import type { ReactNode } from "react";

export function HighlightMark({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`relative inline-block px-[0.08em] ${className}`}>
      <span
        className="absolute inset-x-0 bottom-[0.06em] h-[0.34em] bg-signal/30"
        aria-hidden
      />
      <span className="relative text-ink">{children}</span>
    </span>
  );
}
