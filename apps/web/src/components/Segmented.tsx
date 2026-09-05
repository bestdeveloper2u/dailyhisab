interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

interface SegmentedProps<V extends string> {
  /** Accessible group name (e.g. "Theme"). */
  label: string;
  value: V;
  options: ReadonlyArray<SegmentedOption<V>>;
  onChange: (value: V) => void;
}

/**
 * Segmented control mirroring the prototype's `.seg` (themeSeg @854,
 * twTheme/twMotion @967-970): pill container with the active segment raised.
 */
export function Segmented<V extends string>({ label, value, options, onChange }: SegmentedProps<V>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-control bg-surface-2 p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={`rounded-[8px] px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
              active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
