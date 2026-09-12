import { HighlightMark } from "./HighlightMark";

const ROWS = [
  { key: "Goal", value: "Muscle gain · 2500 kcal/day" },
  { key: "Gym", value: "Gym B · 18 machines on file" },
  { key: "Time left", value: "35 min" },
  { key: "Session", value: "Back day · week 6" },
  { key: "Eaten today", value: "1650 kcal · 62 g protein" },
  { key: "Remaining", value: "+850 kcal · +55 g protein", signal: true },
];

export function ContextLedger() {
  return (
    <div className="lab-rise shadow-soft rounded-md border border-rule bg-panel [animation-delay:520ms]">
      <div className="flex items-center justify-between border-b border-ink/10 px-6 py-4">
        <span className="text-[13.5px] font-medium tracking-tight text-ink">
          Context ledger
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-soft uppercase">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal" />
          Live
        </span>
      </div>

      <dl>
        {ROWS.map((row, i) => (
          <div
            key={row.key}
            className={`flex items-baseline justify-between gap-4 px-6 py-3.5 ${
              i > 0 ? "border-t border-ink/8" : ""
            }`}
          >
            <dt className="shrink-0 text-[12.5px] tracking-tight text-ink-soft">
              {row.key}
            </dt>
            <dd className="text-right font-mono text-[12.5px] leading-snug text-ink">
              {row.signal ? <HighlightMark>{row.value}</HighlightMark> : row.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="border-t border-ink/10 px-6 py-4 text-[12px] leading-relaxed text-ink-soft">
        Every plan Wellio writes reads this ledger first.
      </p>
    </div>
  );
}
