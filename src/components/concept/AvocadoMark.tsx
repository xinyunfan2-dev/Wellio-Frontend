type Props = { className?: string };

/** Cute, minimal avocado mark used as the Wellio logo. */
export function AvocadoMark({ className }: Props) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      role="img"
      aria-label="Wellio avocado logo"
    >
      <path
        d="M24 4c7.5 0 14 7.2 14 16.5C38 33 32 44 24 44S10 33 10 20.5C10 11.2 16.5 4 24 4Z"
        fill="currentColor"
        opacity="0.22"
      />
      <path
        d="M24 4c7.5 0 14 7.2 14 16.5C38 33 32 44 24 44S10 33 10 20.5C10 11.2 16.5 4 24 4Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <ellipse cx="24" cy="27.5" rx="7" ry="8" fill="currentColor" />
    </svg>
  );
}
