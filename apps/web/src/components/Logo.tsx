import { APP_VERSION, BRAND_NAME } from "@khoroch/core";

interface LogoProps {
  /** Render the muted version pill (e.g. "v0.6.0") next to the wordmark. */
  withVersion?: boolean;
  /** Mark size in px; corner radius is 30% of the mark per BRAND. */
  size?: number;
}

/** ৳ on an emerald rounded square + "Daily Hisab" wordmark (Inter 700). */
export function Logo({ withVersion = false, size = 30 }: LogoProps) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center bg-emerald font-bold text-accent-ink"
        style={{
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          fontSize: Math.round(size * 0.5),
        }}
      >
        ৳
      </span>
      <span className="truncate font-en text-[16.5px] font-bold text-ink">{BRAND_NAME}</span>
      {withVersion && (
        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold leading-none text-muted">
          v{APP_VERSION}
        </span>
      )}
    </span>
  );
}
