import { Button } from "@/components/ui/button";
import appIcon from "@/assets/wellio-app-icon.png.asset.json";

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6">
      <path
        fill="currentColor"
        d="M16.7 12.9c0-2.5 2.1-3.7 2.2-3.8a4.8 4.8 0 0 0-3.8-2.1c-1.6-.2-3.2 1-4 1-.9 0-2.2-1-3.6-1-1.9 0-3.6 1.1-4.6 2.7-2 3.4-.5 8.5 1.4 11.3 1 1.4 2.1 2.9 3.6 2.8 1.4-.1 2-1 3.7-1s2.2 1 3.7 1c1.5 0 2.5-1.4 3.4-2.8 1.1-1.6 1.5-3.2 1.6-3.3-.1 0-3.6-1.4-3.6-4.8ZM14 5.3A4.7 4.7 0 0 0 15.1 2 4.8 4.8 0 0 0 12 3.6a4.5 4.5 0 0 0-1.1 3.2A4 4 0 0 0 14 5.3Z"
      />
    </svg>
  );
}

export function DownloadPanel() {
  return (
    <section className="relative -mt-px min-h-screen bg-paper">
      <div className="mx-auto grid min-h-screen w-full max-w-[1440px] grid-cols-1 lg:grid-cols-2">
        <div className="relative flex min-h-[46vh] items-center justify-center overflow-hidden px-8 py-16 lg:min-h-screen lg:border-r lg:border-rule">
          {/* soft avocado glow behind the icon */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
            style={{
              background:
                "radial-gradient(circle, oklch(0.82 0.06 132 / 0.45) 0%, oklch(0.972 0.019 108 / 0) 70%)",
            }}
          />
          <img
            src={appIcon.url}
            alt="Wellio avocado app icon"
            className="relative h-auto w-full max-w-[360px] select-none drop-shadow-[0_24px_48px_rgba(60,70,40,0.28)] sm:max-w-[440px] lg:max-w-[480px]"
          />
        </div>

        <div className="flex items-center border-t border-rule px-8 py-16 sm:px-14 lg:min-h-screen lg:border-t-0 lg:px-20">
          <div className="w-full max-w-[31rem]">
            <p className="font-mono text-[10px] tracking-[0.16em] text-ink-soft uppercase">
              Wellio for iPhone
            </p>
            <h2 className="mt-7 text-[3.2rem] leading-[0.95] font-medium text-ink sm:text-[4.6rem]">
              Welcome to Wellio.
            </h2>
            <p className="mt-8 max-w-md text-[17px] leading-[1.7] text-ink-soft">
              Your context-aware fitness companion, ready wherever your day takes you.
            </p>

            <div className="mt-12 border-t border-rule pt-8">
              <Button
                asChild
                className="h-auto rounded-md bg-ink px-5 py-3 text-paper shadow-none hover:bg-ink/90"
              >
                <a href="https://www.apple.com/app-store/" target="_blank" rel="noreferrer">
                  <AppleMark />
                  <span className="text-left">
                    <span className="block font-mono text-[9px] leading-none uppercase">Download on the</span>
                    <span className="mt-1 block text-[17px] leading-none">App Store</span>
                  </span>
                </a>
              </Button>
              <p className="mt-5 font-mono text-[10px] tracking-[0.12em] text-ink-soft uppercase">
                iPhone · Coming soon
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}