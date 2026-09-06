"""Minimal async KV abstraction used for sessions and rate limiting.

Two backends:

* :class:`RedisKV` — real Redis via ``redis.asyncio``, selected when
  ``KHOROCH_KV_URL`` is set.
* :class:`MemoryKV` — plain dict with per-key TTLs (loop-time based), used
  when ``KHOROCH_KV_URL`` is empty (tests + local dev).

Keys used by the auth layer (all values are strings):

* ``rt:<sha256-of-refresh-token>`` → session id (TTL = refresh TTL)
* ``sess:<session-id>`` → ``"<profile-id>:<sha256-of-current-refresh>"``
  (TTL = refresh TTL; presence also proves the session is alive)
* ``user_sess:<profile-id>`` → SET of that profile's live session ids
  (ADR-0024; TTL = refresh TTL, refreshed on every login/rotation so the
  index never expires before the sessions it points at)
* ``rl:<ip>|<email-or-'-'>`` → fixed-window rate-limit counter
"""

import asyncio
import time
from abc import ABC, abstractmethod
from typing import Any

import redis.asyncio as aioredis

from app.core.config import get_settings


class KV(ABC):
    """Tiny async key/value interface mirroring the Redis verbs we need."""

    @abstractmethod
    async def get(self, key: str) -> str | None:
        """Value stored at ``key`` or ``None`` (expired/missing)."""

    @abstractmethod
    async def setex(self, key: str, ttl_seconds: int, value: str) -> None:
        """Set ``key`` to ``value`` with an expiry."""

    @abstractmethod
    async def delete(self, *keys: str) -> None:
        """Delete one or more keys (missing keys are ignored)."""

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """Whether a live (non-expired) ``key`` exists."""

    @abstractmethod
    async def ttl(self, key: str) -> int:
        """Remaining TTL in seconds; -1 no expiry, -2 missing (Redis semantics)."""

    @abstractmethod
    async def incr(self, key: str, ttl_seconds: int) -> int:
        """Atomically increment, setting ``ttl_seconds`` on first hit (INCR+EXPIRE)."""

    @abstractmethod
    async def sadd(self, key: str, member: str, ttl_seconds: int | None = None) -> None:
        """Add ``member`` to the set at ``key`` (creating it if missing).

        ``ttl_seconds`` refreshes the key's expiry alongside the write —
        mirroring how :meth:`setex` refreshes TTL on string writes — so set
        keys stay on the same lazy-TTL lifecycle as every other key. Pass
        ``None`` to keep an existing expiry untouched.
        """

    @abstractmethod
    async def srem(self, key: str, *members: str) -> None:
        """Remove ``members`` from the set at ``key`` (missing keys/members are ignored).

        A set that becomes empty is deleted outright (Redis SREM semantics),
        so no empty-set husks linger in the store.
        """

    @abstractmethod
    async def smembers(self, key: str) -> set[str]:
        """Members of the set at ``key`` (empty set when missing/expired)."""

    async def aclose(self) -> None:
        """Release backend resources (no-op for in-memory)."""


def _loop_time() -> float:
    try:
        return asyncio.get_running_loop().time()
    except RuntimeError:  # pragma: no cover - only outside a running loop
        return time.monotonic()


class MemoryKV(KV):
    """Dict-backed KV with lazy TTL expiry; fallback for tests/local dev."""

    def __init__(self) -> None:
        # key -> (value, expires_at | None); expires_at uses loop time.
        self._data: dict[str, tuple[str, float | None]] = {}
        # Set keys (SADD/SREM/SMEMBERS), same lazy-TTL tuple shape. Kept in a
        # separate map so string and set namespaces can never collide.
        self._sets: dict[str, tuple[set[str], float | None]] = {}

    def _alive_item(self, key: str) -> tuple[Any, float | None] | None:
        """Live item (string value or set) at ``key``, lazy-expiring it if dead.

        Checks both namespaces so ``exists``/``ttl`` answer coherently no
        matter which store owns the key.
        """
        item = self._data.get(key) or self._sets.get(key)
        if item is None:
            return None
        _, expires_at = item
        if expires_at is not None and expires_at <= _loop_time():
            self._data.pop(key, None)
            self._sets.pop(key, None)
            return None
        return item

    def _alive(self, key: str) -> tuple[str, float | None] | None:
        item = self._alive_item(key)
        return item if item is not None and isinstance(item[0], str) else None

    def _alive_set(self, key: str) -> set[str] | None:
        item = self._alive_item(key)
        return item[0] if item is not None and isinstance(item[0], set) else None

    async def get(self, key: str) -> str | None:
        item = self._alive(key)
        return item[0] if item is not None else None

    async def setex(self, key: str, ttl_seconds: int, value: str) -> None:
        self._sets.pop(key, None)  # one namespace owner per key
        self._data[key] = (value, _loop_time() + ttl_seconds)

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self._data.pop(key, None)
            self._sets.pop(key, None)

    async def exists(self, key: str) -> bool:
        return self._alive_item(key) is not None

    async def ttl(self, key: str) -> int:
        item = self._alive_item(key)
        if item is None:
            return -2
        expires_at = item[1]
        if expires_at is None:
            return -1
        return max(0, int(expires_at - _loop_time()))

    async def incr(self, key: str, ttl_seconds: int) -> int:
        item = self._alive(key)
        if item is None:
            self._data[key] = ("1", _loop_time() + ttl_seconds)
            return 1
        value, expires_at = item
        new_count = int(value) + 1
        self._data[key] = (str(new_count), expires_at)
        return new_count

    async def sadd(self, key: str, member: str, ttl_seconds: int | None = None) -> None:
        self._data.pop(key, None)  # one namespace owner per key
        members = self._alive_set(key)
        if members is None:
            members = set()
            expires_at = None if ttl_seconds is None else _loop_time() + ttl_seconds
            self._sets[key] = (members, expires_at)
        elif ttl_seconds is not None:
            self._sets[key] = (members, _loop_time() + ttl_seconds)
        members.add(member)

    async def srem(self, key: str, *members: str) -> None:
        if not members:
            return
        live = self._alive_set(key)
        if live is None:
            return
        live.difference_update(members)
        if not live:  # Redis semantics: empty set -> key gone
            self._sets.pop(key, None)

    async def smembers(self, key: str) -> set[str]:
        members = self._alive_set(key)
        return set(members) if members is not None else set()


class RedisKV(KV):
    """Redis backend (``redis.asyncio``), selected via ``KHOROCH_KV_URL``."""

    def __init__(self, url: str) -> None:
        self._redis: aioredis.Redis = aioredis.Redis.from_url(
            url, decode_responses=True
        )

    async def get(self, key: str) -> str | None:
        result = await self._redis.get(key)
        if result is None:
            return None
        # decode_responses=True yields str, but stay robust to bytes.
        return result if isinstance(result, str) else result.decode("utf-8")

    async def setex(self, key: str, ttl_seconds: int, value: str) -> None:
        await self._redis.setex(key, ttl_seconds, value)

    async def delete(self, *keys: str) -> None:
        if keys:
            await self._redis.delete(*keys)

    async def exists(self, key: str) -> bool:
        return bool(await self._redis.exists(key))

    async def ttl(self, key: str) -> int:
        return int(await self._redis.ttl(key))

    async def incr(self, key: str, ttl_seconds: int) -> int:
        count = int(await self._redis.incr(key))
        if count == 1:
            await self._redis.expire(key, ttl_seconds)
        return count

    async def sadd(self, key: str, member: str, ttl_seconds: int | None = None) -> None:
        await self._redis.sadd(key, member)
        if ttl_seconds is not None:
            await self._redis.expire(key, ttl_seconds)

    async def srem(self, key: str, *members: str) -> None:
        if members:
            await self._redis.srem(key, *members)

    async def smembers(self, key: str) -> set[str]:
        result = await self._redis.smembers(key)
        # decode_responses=True yields str, but stay robust to bytes.
        return {m if isinstance(m, str) else m.decode("utf-8") for m in result}

    async def aclose(self) -> None:
        await self._redis.aclose()


_kv: KV | None = None


def get_kv() -> KV:
    """Return the process-wide KV backend, building it from settings once."""
    global _kv
    if _kv is None:
        url = get_settings().kv_url
        _kv = RedisKV(url) if url else MemoryKV()
    return _kv


def set_kv(kv: KV | None) -> None:
    """Replace (or reset with ``None``) the process-wide KV — test hook."""
    global _kv
    _kv = kv


async def close_kv() -> None:
    """Close and reset the process-wide KV (graceful shutdown)."""
    global _kv
    if _kv is not None:
        await _kv.aclose()
    _kv = None
