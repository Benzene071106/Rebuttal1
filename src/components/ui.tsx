// Shared building blocks, so badges, buttons, cards and empty states look the same on
// every page.

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";
const TONE_COLOR: Record<Tone, string> = { good: "var(--fight)", warn: "var(--offer)", bad: "var(--danger)", info: "var(--accent)", neutral: "var(--muted)" };

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold" style={{ color: TONE_COLOR[tone], border: "1px solid currentColor" }}>
      {children}
    </span>
  );
}

export const BUTTON = {
  primary: "rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel hover:opacity-90 disabled:opacity-60",
  secondary: "rounded-md border border-line bg-panel px-3 py-1.5 text-sm hover:border-accent disabled:opacity-60",
  ghost: "rounded-md px-3 py-1.5 text-sm text-muted hover:text-ink disabled:opacity-60",
} as const;

export function Card({ title, subtitle, right, children }: { title: string; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
        </div>
        {right}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// Opens the Simulator tools menu in the top bar (see TopBar), so empty states can point to it.
export const OPEN_SIMULATOR_EVENT = "rebuttal:simulator";

export function Empty({ children, title, action }: { children: React.ReactNode; title?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-line px-4 py-5 text-center">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-sm text-accent">✓</span>
      {title ? <p className="text-sm font-medium">{title}</p> : null}
      <p className="max-w-prose text-sm text-muted">{children}</p>
      {action ? (
        <button onClick={action.onClick} className={`${BUTTON.secondary} mt-1`}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export const openSimulator = () => window.dispatchEvent(new Event(OPEN_SIMULATOR_EVENT));

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular" style={tone ? { color: TONE_COLOR[tone] } : undefined}>{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}
