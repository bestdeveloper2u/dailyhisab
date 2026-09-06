"""Rule-based Bengali voice-transcript parser (Phase 2).

Pure Python — no new dependencies, no network, no LLM (ARCHITECTURE §3:
"rule-based bn parser first; LLM optional later"). The transcript is
normalized (Bengali digits → ASCII, stray punctuation → spaces), split into
segments on " এবং ", " ও ", " and ", comma, semicolon and newline, and each
segment yields at most one expense candidate:

* amount: explicit ascii digits (e.g. "50", "৫০"→"50", "120.50") or Bengali
  number-words (পাঁচ=5 … শত=100 …), with "হাজার" as a ×1000 multiplier;
* category: first keyword hit from an ordered list (longer/specific phrases
  before their generic substrings — e.g. "ভাড়া টাকা"→transport before
  "ভাড়া"→housing, "বাসা"→housing before "বাস"→transport);
* payment method: optional keyword hit (বিকাশ/bkash, নগদ/nagad, …);
* confidence: 0.95 keyword + explicit digits, 0.6 explicit digits only,
  0.3 amount from a number-word; segments without an amount are skipped and
  an empty parse is items=[] with confidence 0.0. The response confidence is
  the minimum across parsed items (worst-segment).
"""

import re
import uuid as uuid_mod
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, cast

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.expense import Expense
from app.models.profile import Profile
from app.schemas.expense import (
    ExpenseGroup,
    ParsedItem,
    PayMethod,
    VoiceParseIn,
    VoiceParseOut,
)

router = APIRouter(prefix="/voice", tags=["voice"])

CurrentUser = Annotated[Profile, Depends(get_current_user)]
DbDep = Annotated[AsyncSession, Depends(get_db)]

# --- normalization ----------------------------------------------------------

_BN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
# Danda, quotes and other punctuation become spaces; '.' is kept (decimals).
_PUNCT = re.compile(r"[।!?'\"()\-\u2013\u2014]+")
# Horizontal whitespace collapses; newlines survive — they are multi-item
# separators (see _SEG_SPLIT) and must reach the split intact.
_WS = re.compile(r"[^\S\n]+")

# Multi-item separators (a Bengali conjunction needs surrounding spaces so
# words like ওয়াইফাই are never split).
_SEG_SPLIT = re.compile(r"\s*(?:,|;|\n)\s*|\s+এবং\s+|\s+ও\s+|\s+and\s+")

_AMOUNT = re.compile(r"\d+(?:\.\d+)?")

# --- vocabulary ---------------------------------------------------------------

# Bengali number-words (longest-first matching keeps একশ over এক etc).
_NUMBER_WORDS: dict[str, int] = {
    "একশ": 100,
    "পাঁচশ": 500,
    "দুইশ": 200,
    "নব্বই": 90,
    "চল্লিশ": 40,
    "পঞ্চাশ": 50,
    "সত্তর": 70,
    "ত্রিশ": 30,
    "বিশ": 20,
    "ষাট": 60,
    "হাজার": 1000,
    "দশ": 10,
    "পাঁচ": 5,
    "panch": 5,
    "চার": 4,
    "ছয়": 6,
    "সাত": 7,
    "আট": 8,
    "নয়": 9,
    "শত": 100,
    "dui": 2,
    "দুই": 2,
    "তিন": 3,
    "এক": 1,
    "আশি": 80,
}
_NUMBER_WORDS_ORDERED = sorted(_NUMBER_WORDS, key=len, reverse=True)

_THOUSAND_WORD = "হাজার"

# Ordered category keywords: first substring hit wins, so specific phrases
# and longer words must precede their generic substrings.
_KEYWORDS: list[tuple[str, ExpenseGroup]] = [
    # transport — "ভাড়া টাকা" (fare money) before housing's ভাড়া
    ("ভাড়া টাকা", "transport"),
    ("বাস ভাড়া", "transport"),
    ("রিকশা", "transport"),
    ("rickshaw", "transport"),
    # housing — বাসা before বাস (বাস is a substring of বাসা)
    ("বাসা", "housing"),
    ("বাস", "transport"),
    ("bus", "transport"),
    ("সিএনজি", "transport"),
    ("cng", "transport"),
    ("উবার", "transport"),
    ("uber", "transport"),
    # food
    ("চা", "food"),
    ("চাল", "food"),
    ("ডাল", "food"),
    ("তেল", "food"),
    ("সবজি", "food"),
    ("ডিম", "food"),
    ("মুদি", "food"),
    ("বাজার", "food"),
    ("হোটেল", "food"),
    ("কফি", "food"),
    ("coffee", "food"),
    ("খাবার", "food"),
    ("লাঞ্চ", "food"),
    ("ডিনার", "food"),
    ("ব্রেকফাস্ট", "food"),
    ("ভাত", "food"),
    ("মাছ", "food"),
    ("মাংস", "food"),
    # housing
    ("ভাড়া", "housing"),
    ("rent", "housing"),
    # utility
    ("বিজলি", "utility"),
    ("বিদ্যুৎ", "utility"),
    ("গ্যাস", "utility"),
    ("পানির", "utility"),
    ("ওয়াইফাই", "utility"),
    ("wifi", "utility"),
    # health
    ("ওষুধ", "health"),
    ("ডাক্তার", "health"),
    ("হাসপাতাল", "health"),
    ("medicine", "health"),
    ("doctor", "health"),
    # education
    ("টিউশন", "education"),
    ("স্কুল", "education"),
    ("কলেজ", "education"),
    ("বই", "education"),
    ("book", "education"),
    ("school", "education"),
    ("college", "education"),
    # personal
    ("মোবাইল রিচার্জ", "personal"),
    ("রিচার্জ", "personal"),
    ("recharge", "personal"),
    ("কাপড়", "personal"),
    ("জুতা", "personal"),
    ("shoe", "personal"),
]

_PAY_KEYWORDS: list[tuple[str, PayMethod]] = [
    ("বিকাশ", "bkash"),
    ("bkash", "bkash"),
    ("নগদ", "nagad"),
    ("nagad", "nagad"),
    ("রকেট", "rocket"),
    ("rocket", "rocket"),
    ("কার্ড", "card"),
    ("card", "card"),
    ("ব্যাংক", "bank"),
    ("bank", "bank"),
]

_CONF_KEYWORD_DIGITS = 0.95
_CONF_DIGITS_ONLY = 0.6
_CONF_WORD_AMOUNT = 0.3

_TWO_PLACES = Decimal("0.01")


# --- parsing -----------------------------------------------------------------


def _normalize(text: str) -> str:
    """Bengali digits → ASCII, stray punctuation → spaces, collapse blanks."""
    text = text.translate(_BN_DIGITS)
    text = _PUNCT.sub(" ", text)
    return _WS.sub(" ", text).strip()


def _extract_amount(seg: str) -> tuple[Decimal | None, bool]:
    """Return ``(amount, explicit_digits)`` for the segment.

    ``amount`` is ``None`` when the segment carries no usable amount.
    হাজার is a MULTIPLIER only — never the base word. The longest-first scan
    used to match হাজার first ("আট হাজার" → base 1000) and then multiply by
    হাজার again → 1,000,000. Now: digits×হাজার, word×হাজার, or a bare
    "হাজার" = 1000.
    """
    digit_match = _AMOUNT.search(seg)
    if digit_match is not None:
        amount = Decimal(digit_match.group(0))
        if _THOUSAND_WORD in seg:
            amount *= Decimal(1000)
        return amount, True
    word_value: int | None = None
    for word in _NUMBER_WORDS_ORDERED:
        if word != _THOUSAND_WORD and word in seg:
            word_value = _NUMBER_WORDS[word]
            break
    if word_value is None:
        if _THOUSAND_WORD not in seg:
            return None, False
        amount = Decimal(1000)  # bare "হাজার টাকা"
    elif _THOUSAND_WORD in seg:
        amount = Decimal(word_value * 1000)
    else:
        amount = Decimal(word_value)
    return amount, False


def _strip_amount_text(seg: str) -> str:
    """Segment with digit runs and number-words blanked out.

    Category scanning runs on this so number words can never pose as
    categories (e.g. নব্বই "90" contains বই "book").
    """
    cleaned = _AMOUNT.sub(" ", seg)
    for word in _NUMBER_WORDS_ORDERED:
        cleaned = cleaned.replace(word, " ")
    return _WS.sub(" ", cleaned)


def _match_category(
    seg: str, extra: list[tuple[str, ExpenseGroup]] | None = None
) -> tuple[str, ExpenseGroup]:
    """Longest keyword hit wins → ``(cat, grp)``; otherwise ``("other", "other")``.

    Longest-first matters more than list order now: "চাল" (rice) must beat
    "চা" (tea) even though "চা" is a substring of "চাল" and sits earlier in
    the list. Ties on length keep the earlier list entry. ``extra`` carries
    the caller's history-derived khatas (ADR-0019) so ANY khata the user has
    used before is recognised without touching this static list.
    """
    best: tuple[str, ExpenseGroup] | None = None
    for keyword, grp in [*_KEYWORDS, *(extra or [])]:
        if keyword in seg and (best is None or len(keyword) > len(best[0])):
            best = (keyword, grp)
    if best is not None:
        return best
    return "other", "other"


def _match_pay(seg: str) -> PayMethod | None:
    """Longest keyword hit wins (same substring-safety as categories)."""
    best: PayMethod | None = None
    for keyword, pay in _PAY_KEYWORDS:
        if keyword in seg and (best is None or len(keyword) > len(best)):
            best = pay
    return best


async def _user_khatas(
    db: AsyncSession, user_id: uuid_mod.UUID
) -> list[tuple[str, ExpenseGroup]]:
    """Distinct ``(cat, grp)`` pairs from the caller's history (ADR-0019)."""
    rn = (
        func.row_number()
        .over(
            partition_by=Expense.cat,
            order_by=(Expense.iso.desc(), Expense.created_at.desc(), Expense.id.desc()),
        )
        .label("rn")
    )
    ranked = (
        select(Expense.cat.label("cat"), Expense.grp.label("grp"), rn)
        .where(Expense.user_id == user_id)
        .subquery()
    )
    rows = (
        (await db.execute(select(ranked.c.cat, ranked.c.grp).where(ranked.c.rn == 1)))
        .all()
    )
    return [(row.cat, cast(ExpenseGroup, row.grp)) for row in rows]


def _parse_segment(
    seg: str,
    today: date,
    extra: list[tuple[str, ExpenseGroup]] | None = None,
) -> tuple[ParsedItem, float] | None:
    """Parse one segment; ``None`` when it carries no amount (skip it)."""
    normalized = seg.strip()
    if not normalized:
        return None
    amount, explicit_digits = _extract_amount(normalized)
    if amount is None:
        return None
    cat, grp = _match_category(_strip_amount_text(normalized), extra)
    confidence = (
        (_CONF_KEYWORD_DIGITS if grp != "other" else _CONF_DIGITS_ONLY)
        if explicit_digits
        else _CONF_WORD_AMOUNT
    )
    return (
        ParsedItem(
            cat=cat,
            grp=grp,
            amt=str(amount.quantize(_TWO_PLACES)),
            pay=_match_pay(normalized),
            desc=normalized,
            iso=today,
        ),
        confidence,
    )


@router.post("/parse", response_model=VoiceParseOut)
async def parse_transcript(
    body: VoiceParseIn, user: CurrentUser, db: DbDep
) -> VoiceParseOut:
    """Rule-parse a Bengali voice transcript into expense candidates.

    The keyword matcher is extended with the caller's history-derived khatas
    (ADR-0019) — every khata the user has ever saved is recognised on the
    next transcript, free of any AI/token cost. Pure SQL + rules.
    """
    today = datetime.now(UTC).date()
    extra = await _user_khatas(db, user.id)
    items: list[ParsedItem] = []
    confidences: list[float] = []
    for seg in _SEG_SPLIT.split(_normalize(body.text)):
        parsed = _parse_segment(seg, today, extra)
        if parsed is not None:
            items.append(parsed[0])
            confidences.append(parsed[1])
    return VoiceParseOut(
        items=items, confidence=min(confidences) if confidences else 0.0
    )
