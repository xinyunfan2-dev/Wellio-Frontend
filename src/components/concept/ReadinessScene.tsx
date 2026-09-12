import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

type Metric = {
  label: string;
  unit: string;
  baseline: string;
  low: number;
  high: number;
  scale: number; // bar scale max
  format: (v: number) => string;
};

const fmtSleep = (v: number) => {
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
};

const METRICS: Metric[] = [
  {
    label: "Sleep duration",
    unit: "",
    baseline: "7h 30m",
    low: 5 * 60 + 12,
    high: 7 * 60 + 48,
    scale: 9 * 60,
    format: fmtSleep,
  },
  {
    label: "Deep sleep",
    unit: "%",
    baseline: "20%",
    low: 9,
    high: 22,
    scale: 30,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    label: "Resting heart rate",
    unit: "bpm",
    baseline: "55 bpm",
    low: 68,
    high: 54,
    scale: 80,
    format: (v) => `${Math.round(v)} bpm`,
  },
  {
    label: "HRV",
    unit: "ms",
    baseline: "60 ms",
    low: 31,
    high: 62,
    scale: 80,
    format: (v) => `${Math.round(v)} ms`,
  },
];

type Advice = {
  headline: string;
  points: string[];
  details: string;
};

const DIET: { low: Advice; high: Advice } = {
  low: {
    headline: "Steady blood sugar, hydrate, protect tonight's sleep.",
    points: [
      "Oats + banana for breakfast",
      "Water and electrolytes through the day",
      "Yogurt and nuts for magnesium",
      "Max one coffee, before noon",
    ],
    details:
      "Poor sleep raises cortisol and makes blood sugar swing harder. A slow-carb breakfast (oats, banana) keeps energy flat instead of spiking. Dehydration amplifies fatigue, so front-load water and electrolytes. Magnesium and tryptophan in the evening (yogurt, nuts, kiwi) support sleep onset tonight. Caffeine has a 5–6 hour half-life — one cup before noon won't reach bedtime, a second one will.",
  },
  high: {
    headline: "Fuel today's session.",
    points: [
      "40 g carbs two hours before training",
      "1.8–2.2 g protein per kg bodyweight",
      "30 g protein + fast carbs within 30 min after",
    ],
    details:
      "With recovery topped up, the constraint shifts to fueling. 40 g of carbs two hours out fills glycogen without sitting heavy. Hitting 1.8–2.2 g of protein per kg supports the added training load. The post-session window is when uptake is fastest — 30 g of protein with fast carbs within half an hour.",
  },
};

const TRAINING: { low: Advice; high: Advice } = {
  low: {
    headline: "No lifting today.",
    points: [
      "20–30 min low-intensity cardio or mobility",
      "Heart rate under 60% of max",
      "Back day moves to tomorrow",
    ],
    details:
      "Under-recovered lifting raises injury risk and adds stress the body can't adapt from. Swapping in 20–30 minutes of easy cardio or mobility keeps the habit and aids recovery. The weekly plan re-plans itself: today's back session slides to tomorrow, tomorrow's rest day moves to today — the week's four sessions stay intact.",
  },
  high: {
    headline: "Back day, as planned.",
    points: [
      "Main lift at +2.5–5% load, 5×5",
      "About 55 minutes total",
      "Week plan unchanged",
    ],
    details:
      "Sleep, HRV and resting heart rate all sit at or above baseline, so the planned back day goes ahead — with a small progression on the main lift. Accessories stay as scheduled. Total time about 55 minutes, matching the time budget on file.",
  },
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TODAY = 3; // Thursday
// task positions as day indexes: low -> high
const TASK_BACK = { low: 4, high: 3 };
const TASK_REST = { low: 3, high: 6 };

const DURATION = 1200;

const READINESS_MOTION = {
  low: {
    video: "/readiness-motion/low-readiness.mp4",
    poster: "/readiness-motion/low-poster.png",
    alt: "低准备度牛油果躺在床上休息",
  },
  high: {
    video: "/readiness-motion/high-readiness.mp4",
    poster: "/readiness-motion/high-poster.png",
    alt: "高准备度牛油果在健身房举哑铃",
  },
} as const;

const READINESS_ILLUSTRATIONS = {
  watch: "/readiness-illustrations/watch-readiness.png",
  diet: {
    low: "/readiness-illustrations/diet-low.png",
    high: "/readiness-illustrations/diet-high.png",
  },
  training: {
    low: "/readiness-illustrations/training-low.png",
    high: "/readiness-illustrations/training-high.png",
  },
  week: "/readiness-illustrations/week-plan.png",
} as const;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const fn = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return reduced;
}

/** progress 0 (low) → 1 (high), eased over DURATION ms, reversible mid-flight. */
function useReadinessProgress() {
  const [progress, setProgress] = useState(0);
  const reduced = usePrefersReducedMotion();
  const state = useRef({ value: 0, raf: 0 });

  const goTo = useCallback(
    (target: 0 | 1) => {
      const s = state.current;
      cancelAnimationFrame(s.raf);
      if (reduced) {
        s.value = target;
        setProgress(target);
        return;
      }
      const from = s.value;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / DURATION);
        const v = lerp(from, target, easeInOut(t));
        s.value = v;
        setProgress(v);
        if (t < 1) s.raf = requestAnimationFrame(step);
      };
      s.raf = requestAnimationFrame(step);
    },
    [reduced],
  );

  useEffect(() => () => cancelAnimationFrame(state.current.raf), []);

  const setInstant = useCallback((v: number) => {
    state.current.value = v;
    setProgress(v);
  }, []);

  return { progress, goTo, setInstant };
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

/** Hand-drawn watch object plus precise data rows; all values are driven by p. */
function WatchFace({ p }: { p: number }) {
  return (
    <div>
      <div className="mx-auto w-full max-w-[156px]">
        <img
          src={READINESS_ILLUSTRATIONS.watch}
          alt="Hand-drawn readiness watch"
          className="readiness-spot-float h-auto w-full"
        />
      </div>

      <div className="mt-5 border-t border-rule">
        {METRICS.map((metric) => {
          const value = lerp(metric.low, metric.high, p);
          const fill = Math.max(8, Math.min(100, (value / metric.scale) * 100));
          return (
            <div key={metric.label} className="border-b border-rule py-3">
              <div className="grid grid-cols-[1fr_auto] items-baseline gap-4">
                <div>
                  <p className="font-mono text-[9px] tracking-[0.12em] text-ink uppercase">
                    {metric.label}
                  </p>
                  <p className="mt-0.5 font-mono text-[8px] tracking-[0.08em] text-ink-soft uppercase">
                    Baseline {metric.baseline}
                  </p>
                </div>
                <p className="font-mono text-[13px] font-medium text-ink tabular-nums">
                  {metric.format(value)}
                </p>
              </div>
              <div className="mt-2 h-px overflow-hidden bg-rule">
                <span
                  className="block h-full bg-signal"
                  style={{ width: `${fill}%`, opacity: lerp(0.38, 1, p) }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdviceBlock({
  title,
  data,
  illustrations,
  p,
  onDetails,
}: {
  title: string;
  data: { low: Advice; high: Advice };
  illustrations: { low: string; high: string };
  p: number;
  onDetails: (a: Advice, title: string) => void;
}) {
  const current = p < 0.5 ? data.low : data.high;
  return (
    <div className="border-t border-rule pt-5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
          {title}
        </span>
        <button
          type="button"
          onClick={() => onDetails(current, title)}
          className="font-mono text-[10px] tracking-[0.14em] text-ink uppercase underline-offset-4 hover:underline"
        >
          Details
        </button>
      </div>

      <div className="relative mt-4 min-h-[12.5rem]">
        {[data.low, data.high].map((a, i) => {
          const show = i === 0 ? 1 - p : p;
          return (
            <div
              key={i}
              className="absolute inset-0 grid grid-cols-[minmax(0,1fr)_88px] items-start gap-4"
              style={{
                opacity: show,
                pointerEvents: show > 0.5 ? "auto" : "none",
                transform: `translateY(${(1 - show) * 8}px)`,
              }}
              aria-hidden={show <= 0.5}
            >
              <div>
                <p className="text-[16.5px] leading-snug font-medium tracking-tight text-ink">
                  {a.headline}
                </p>
                <ul className="mt-3 space-y-1.5">
                  {a.points.map((pt) => (
                    <li
                      key={pt}
                      className="flex items-baseline gap-2.5 text-[13px] leading-relaxed text-ink-soft"
                    >
                      <span className="h-px w-3 shrink-0 self-center bg-ink/40" />
                      {pt}
                    </li>
                  ))}
                </ul>
              </div>
              <img
                src={i === 0 ? illustrations.low : illustrations.high}
                alt=""
                aria-hidden
                className="readiness-spot-float mt-1 h-auto w-full"
                style={{ animationDelay: i === 0 ? "-1.2s" : "-2.7s" }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekPlan({ p }: { p: number }) {
  const cell = 100 / 7;
  const backX = lerp(TASK_BACK.low, TASK_BACK.high, p) * cell;
  const restX = lerp(TASK_REST.low, TASK_REST.high, p) * cell;

  return (
    <div className="mt-10 border-t border-rule pt-6">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
          Week plan — auto re-arranged
        </span>
        <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
          4 sessions kept
        </span>
      </div>

      <div className="mt-4 grid items-center gap-5 sm:grid-cols-[96px_minmax(0,1fr)]">
        <img
          src={READINESS_ILLUSTRATIONS.week}
          alt=""
          aria-hidden
          className="readiness-spot-float mx-auto h-auto w-20 sm:w-24"
          style={{ animationDelay: "-3.4s" }}
        />

        <div className="relative min-w-0">
          <div className="grid grid-cols-7">
            {DAYS.map((d, i) => (
              <div
                key={d}
                className={`border-l border-rule px-2 pb-10 ${i === 6 ? "border-r" : ""}`}
              >
                <span
                  className={`font-mono text-[10px] tracking-[0.1em] uppercase ${
                    i === TODAY ? "text-ink" : "text-ink-soft"
                  }`}
                >
                  {d}
                </span>
                {i === TODAY ? (
                  <span className="mt-1 block font-mono text-[9px] tracking-[0.1em] text-ink-soft/70 uppercase">
                    Today
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          {/* Moving task blocks */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
            <div
              className="absolute top-6 h-7"
              style={{ left: `${backX}%`, width: `${cell}%` }}
            >
              <div className="mx-1 flex h-full items-center justify-center border border-ink/60 bg-ink px-2">
                <span className="truncate font-mono text-[9.5px] tracking-[0.1em] text-paper uppercase">
                  Back day
                </span>
              </div>
            </div>
            <div
              className="absolute top-6 h-7"
              style={{ left: `${restX}%`, width: `${cell}%` }}
            >
              <div className="mx-1 flex h-full items-center justify-center border border-rule bg-panel px-2">
                <span className="truncate font-mono text-[9.5px] tracking-[0.1em] text-ink-soft uppercase">
                  Rest
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailsPanel({
  advice,
  title,
  onClose,
}: {
  advice: Advice | null;
  title: string;
  onClose: () => void;
}) {
  if (!advice) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="max-h-[80vh] w-full max-w-xl overflow-y-auto border border-ink/15 bg-paper px-8 py-8 sm:px-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
            {title} — details
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[10px] tracking-[0.14em] text-ink uppercase underline-offset-4 hover:underline"
          >
            Close
          </button>
        </div>
        <h3 className="mt-6 text-[1.5rem] leading-tight font-medium tracking-tight text-ink">
          {advice.headline}
        </h3>
        <p className="mt-5 text-[14.5px] leading-[1.85] text-ink-soft">{advice.details}</p>
        <ul className="mt-6 border-t border-rule">
          {advice.points.map((pt, i) => (
            <li
              key={pt}
              className="flex items-baseline gap-4 border-b border-rule py-3 text-[13.5px] text-ink"
            >
              <span className="font-mono text-[10px] text-ink-soft">0{i + 1}</span>
              {pt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

export function ReadinessScene() {
  const { progress: p, goTo, setInstant } = useReadinessProgress();
  const reduced = usePrefersReducedMotion();
  const [details, setDetails] = useState<{ advice: Advice; title: string } | null>(null);
  const [active, setActive] = useState<0 | 1>(0);
  const [revealed, setRevealed] = useState(false);
  const manualLocked = useRef(false);
  const wasIntersecting = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);

  const select = (target: 0 | 1) => {
    manualLocked.current = true;
    setActive(target);
    goTo(target);
  };

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* Phase 2: auto-play once when the scene enters the viewport. */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !wasIntersecting.current) {
            wasIntersecting.current = true;
            if (!manualLocked.current) {
              setActive(1);
              goTo(1);
            }
          } else if (!e.isIntersecting && wasIntersecting.current) {
            wasIntersecting.current = false;
            manualLocked.current = false;
            setActive(0);
            setInstant(0);
          }
        }
      },
      { threshold: 0.45 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [goTo, setInstant]);

  // keep instant set referenced (used later for scroll mode)
  void setInstant;

  const score = Math.round(lerp(38, 86, p));

  return (
    <section
      id="readiness"
      ref={sectionRef}
      data-revealed={revealed}
      className="relative flex min-h-screen flex-col justify-center bg-paper py-20 sm:py-24"
    >
      <div className="readiness-atmosphere pointer-events-none absolute inset-x-0 top-0 h-72" aria-hidden />
      <div className="mx-auto w-full max-w-[1160px] px-6 sm:px-10">
        {/* Header row: label + segmented control */}
        <div className="readiness-reveal readiness-reveal-1 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-10">
          <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.14em] text-ink-soft uppercase">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />
            READINESS — 01
          </p>

          <div className="flex border border-ink/20" role="tablist" aria-label="Readiness state">
            {(["Low readiness", "High readiness"] as const).map((label, i) => (
              <button
                key={label}
                type="button"
                role="tab"
                aria-selected={active === i}
                onClick={() => select(i as 0 | 1)}
                className={`px-4 py-2 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors ${
                  i === 0 ? "border-r border-ink/20" : ""
                } ${active === i ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Main grid */}
        <div className="mt-12 grid gap-x-10 gap-y-12 lg:grid-cols-[1fr_1.15fr_1.15fr]">
          {/* Left: character slot + score */}
          <div className="readiness-reveal readiness-reveal-2">
            <div className="readiness-scene-feather relative aspect-square w-full max-w-[360px] overflow-hidden bg-paper">
              {reduced ? (
                <img
                  src={p < 0.5 ? READINESS_MOTION.low.poster : READINESS_MOTION.high.poster}
                  alt={p < 0.5 ? READINESS_MOTION.low.alt : READINESS_MOTION.high.alt}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              ) : (
                <>
                  <video
                    src={READINESS_MOTION.low.video}
                    poster={READINESS_MOTION.low.poster}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="auto"
                    aria-label={READINESS_MOTION.low.alt}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ opacity: 1 - p }}
                  />
                  <video
                    src={READINESS_MOTION.high.video}
                    poster={READINESS_MOTION.high.poster}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="auto"
                    aria-label={READINESS_MOTION.high.alt}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ opacity: p }}
                  />
                </>
              )}
            </div>

            <div className="mt-8 border-t border-rule pt-5">
              <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
                Readiness score
              </span>
              <div className="mt-2 flex items-baseline gap-3">
                <span className="font-mono text-[4rem] leading-none font-medium tracking-tight text-ink tabular-nums">
                  {score}
                </span>
                <span className="relative inline-block h-[1.2em] w-44 overflow-hidden align-baseline whitespace-nowrap">
                  <span
                    className="absolute inset-0 font-mono text-[11px] tracking-[0.14em] text-ink-soft uppercase"
                    style={{ opacity: 1 - p }}
                  >
                    Under-recovered
                  </span>
                  <span
                    className="absolute inset-0 font-mono text-[11px] tracking-[0.14em] text-signal uppercase"
                    style={{ opacity: p }}
                  >
                    Fully charged
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* Middle: watch metrics */}
          <div className="readiness-reveal readiness-reveal-3">
            <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
              From your watch
            </span>
            <div className="mt-6">
              <WatchFace p={p} />
            </div>
          </div>

          {/* Right: advice */}
          <div className="readiness-reveal readiness-reveal-4 flex flex-col gap-8">
            <AdviceBlock
              title="Diet today"
              data={DIET}
              illustrations={READINESS_ILLUSTRATIONS.diet}
              p={p}
              onDetails={(advice, title) => setDetails({ advice, title })}
            />
            <AdviceBlock
              title="Training today"
              data={TRAINING}
              illustrations={READINESS_ILLUSTRATIONS.training}
              p={p}
              onDetails={(advice, title) => setDetails({ advice, title })}
            />
          </div>
        </div>

        <div className="readiness-reveal readiness-reveal-5">
          <WeekPlan p={p} />
        </div>

        <p className="readiness-reveal readiness-reveal-5 mt-10 font-mono text-[9.5px] tracking-[0.14em] text-ink-soft/70 uppercase">
          Sample data — for demonstration
        </p>
      </div>

      <DetailsPanel
        advice={details?.advice ?? null}
        title={details?.title ?? ""}
        onClose={() => setDetails(null)}
      />
    </section>
  );
}
