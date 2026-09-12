import type { ReactNode } from "react";

type PhoneFrameSize = "sm" | "md" | "lg";

const SIZES: Record<PhoneFrameSize, string> = {
  sm: "w-[196px]",
  md: "w-[248px]",
  lg: "w-[292px]",
};

export type PhoneFrameProps = {
  /** Screen content. Leave empty to render the reserved placeholder. */
  children?: ReactNode;
  /** Small caption under the phone. */
  caption?: string;
  /** Step / index chip shown on the placeholder screen. */
  step?: string;
  /** Placeholder hint text, shown when no children are provided. */
  placeholder?: string;
  size?: PhoneFrameSize;
  className?: string;
};

/**
 * Reserved slot for a real mobile app screen.
 * Drop a screenshot, a video or a live interactive React screen as children:
 *   <PhoneFrame><img src={shot} alt="Wellio plan screen" /></PhoneFrame>
 */
export function PhoneFrame({
  children,
  caption,
  step,
  placeholder = "Screen slot — app frame goes here",
  size = "md",
  className = "",
}: PhoneFrameProps) {
  return (
    <figure className={`flex flex-col items-center ${className}`}>
      <div
        className={`group relative ${SIZES[size]} rounded-[2.2rem] border border-ink/12 bg-ink/95 p-[7px] shadow-soft transition-transform duration-500 ease-out hover:-translate-y-1.5`}
      >
        <div className="relative aspect-[9/19.5] w-full overflow-hidden rounded-[1.75rem] bg-paper">
          <span className="absolute top-2 left-1/2 z-10 h-[16px] w-[68px] -translate-x-1/2 rounded-full bg-ink/95" />

          {children ?? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
              {step ? (
                <span className="font-mono text-[11px] tracking-[0.14em] text-signal uppercase">
                  {step}
                </span>
              ) : null}
              <span className="text-[12.5px] leading-relaxed text-ink-soft">
                {placeholder}
              </span>
              <span className="mt-2 h-px w-10 bg-rule" />
            </div>
          )}
        </div>
      </div>

      {caption ? (
        <figcaption className="mt-5 max-w-[15rem] text-center text-[12.5px] leading-relaxed text-ink-soft">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
