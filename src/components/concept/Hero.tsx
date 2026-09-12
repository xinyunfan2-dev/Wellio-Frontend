import { HighlightMark } from "./HighlightMark";

const HERO_SCENE = "/hero/wellio-hero-scene.png";

const STATS = [
  { figure: "17", label: "Agent tools" },
  { figure: "05", label: "Demo scenarios" },
  { figure: "02", label: "Live adaptations" },
];

export function Hero() {
  return (
    <section className="relative min-h-screen overflow-hidden bg-paper">
      <img
        src={HERO_SCENE}
        alt=""
        aria-hidden
        className="hero-scene-drift pointer-events-none absolute inset-0 z-0 h-full w-full origin-bottom-right select-none object-cover object-bottom"
      />
      <div className="hero-scene-glow pointer-events-none absolute inset-0 z-[1]" aria-hidden />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1160px] flex-col px-6 sm:px-10">
        {/* Top row — left label above Wellio, right label aligned */}
        <div className="flex items-center justify-between pt-[99px]">
          <span className="font-mono text-[10px] tracking-[0.16em] text-ink-soft uppercase">
            DISCOVER OUR PRODUCT CONCEPT
          </span>
          <span className="font-mono text-[10px] tracking-[0.16em] text-ink-soft uppercase">
            Context-aware / Fitness agent
          </span>
        </div>

        {/* Content block — sits in top 3/4 */}
        <div className="flex flex-1 items-start pt-6">
          <div className="grid w-full grid-cols-1 gap-x-12 gap-y-10 sm:grid-cols-12">
            {/* Left column — wider, more content */}
            <div className="sm:col-span-8">
              <h1 className="lab-rise text-[4.5rem] leading-[0.85] font-medium tracking-[-0.04em] text-ink sm:text-[6rem] lg:text-[7.5rem] [animation-delay:80ms]">
                Wellio
              </h1>

              <p className="lab-rise mt-8 max-w-[28rem] text-[2rem] leading-[1.15] font-medium tracking-[-0.02em] text-ink [animation-delay:200ms] sm:text-[2.4rem] lg:text-[2.8rem]">
                A fitness <HighlightMark>agent</HighlightMark> that reads
                your world and re-plans the moment reality changes.
              </p>

              <p className="lab-rise mt-6 max-w-[26rem] text-[16.5px] leading-[1.8] text-ink-soft [animation-delay:320ms]">
                The rack is taken, you have 35 minutes, and dinner is somewhere
                new. Wellio reads the room and re-plans on the spot.
              </p>
            </div>

            {/* Right column — narrower, stats */}
            <div className="sm:col-span-4 sm:pt-[13px]">
              <dl className="lab-rise flex flex-col gap-0 border-t border-rule [animation-delay:140ms]">
                {STATS.map((s) => (
                  <div
                    key={s.label}
                    className="flex items-baseline justify-between gap-4 border-b border-rule py-4"
                  >
                    <dd className="text-[10px] leading-snug tracking-[0.14em] text-ink-soft uppercase">
                      {s.label}
                    </dd>
                    <dt className="font-mono text-[28px] leading-none font-medium tracking-tight text-ink">
                      {s.figure}
                    </dt>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
