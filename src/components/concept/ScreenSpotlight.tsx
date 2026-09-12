import { PhoneFrame } from "./PhoneFrame";
import { HighlightMark } from "./HighlightMark";

const NOTES = [
  {
    title: "Context first",
    body: "The agent reads your ledger — goal, gym, time left, food eaten — before writing a single set.",
  },
  {
    title: "Re-plans in seconds",
    body: "Machine taken? Dish sold out? Wellio rewrites the rest of the day without losing the target.",
  },
  {
    title: "One thread, all day",
    body: "Training and eating live in the same conversation, so nothing gets counted twice.",
  },
];

export function ScreenSpotlight() {
  return (
    <section className="bg-paper pb-28 sm:pb-36">
      <div className="mx-auto w-full max-w-[1160px] px-6 sm:px-10">
        <div className="grid items-center gap-14 border-t border-rule pt-16 lg:grid-cols-[0.85fr_1.15fr] lg:gap-24">
          <div className="flex justify-center">
            <PhoneFrame
              size="md"
              step="Live"
              placeholder="Hero screen slot — interactive demo"
            />
          </div>

          <div>
            <p className="font-mono text-[11px] tracking-[0.14em] text-ink-soft uppercase">
              SPOTLIGHT — 02
            </p>
            <h2 className="mt-7 text-[2rem] leading-[1.12] font-medium tracking-[-0.03em] text-balance text-ink sm:text-[2.4rem]">
              A plan that keeps up with <HighlightMark>real life</HighlightMark>.
            </h2>

            <dl className="mt-12">
              {NOTES.map((n, i) => (
                <div
                  key={n.title}
                  className={`py-6 ${i > 0 ? "border-t border-rule" : ""} ${i === 0 ? "border-t border-rule" : ""}`}
                >
                  <dt className="flex items-baseline gap-4 text-[15.5px] font-medium tracking-tight text-ink">
                    <span className="font-mono text-[11px] text-signal">
                      0{i + 1}
                    </span>
                    {n.title}
                  </dt>
                  <dd className="mt-2.5 pl-8 text-[14.5px] leading-[1.75] text-ink-soft">
                    {n.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
