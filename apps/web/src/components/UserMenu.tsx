import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { t } from "@khoroch/core";
import { w } from "../lib/web-i18n";
import { useAuthStore } from "../store/auth";
import { useLangStore } from "../store/lang";

/**
 * Header user chip → popover (prototype avwrap @585-592 + handlers
 * @1556-1559): avatar initial + name, name/email header, a profile &
 * settings item, and logout. Closes on outside click and Escape, moves
 * focus into the popover on open and back to the chip on Escape.
 */
export function UserMenu() {
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const name = user?.name ?? user?.email ?? t(lang, "login");
  const email = user?.email ?? null;
  const initial = (name.trim()[0] ?? "ই").toUpperCase();

  // Outside click + Escape (prototype @1559, plus keyboard support).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        chipRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Move focus into the popover when it opens.
  useEffect(() => {
    if (open) popRef.current?.focus();
  }, [open]);

  async function handleLogout() {
    setOpen(false);
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={chipRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={name}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[9.5rem] items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 sm:max-w-[14rem]"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald text-[13px] font-bold text-accent-ink"
        >
          {initial}
        </span>
        <span className="hidden truncate sm:inline">{name}</span>
      </button>

      {open && (
        <div
          ref={popRef}
          tabIndex={-1}
          role="menu"
          aria-label={name}
          className="absolute right-0 top-12 z-50 w-60 rounded-card border border-line bg-surface p-2 shadow-card focus:outline-none"
        >
          <div className="border-b border-line px-2 pb-2.5 pt-1">
            <p className="truncate text-sm font-bold text-ink">{name}</p>
            {email && <p className="truncate font-en text-xs text-muted">{email}</p>}
          </div>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/settings");
            }}
            className="mt-1 flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2"
          >
            {w(lang, "profileSettings")}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => void handleLogout()}
            className="flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13px] font-semibold text-danger transition-colors hover:bg-surface-2"
          >
            {t(lang, "logout")}
          </button>
        </div>
      )}
    </div>
  );
}
