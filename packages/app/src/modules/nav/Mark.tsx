/** Vendy mark: a short line with three stations, the last one reached. */
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 14) / 30}
      viewBox="0 0 30 14"
      aria-hidden
      focusable="false"
    >
      <path d="M3 7h24" stroke="#0B5FD3" strokeWidth="4" />
      <circle
        cx="4"
        cy="7"
        r="3.5"
        fill="#fff"
        stroke="#0B5FD3"
        strokeWidth="2.5"
      />
      <circle
        cx="15"
        cy="7"
        r="3.5"
        fill="#fff"
        stroke="#0B5FD3"
        strokeWidth="2.5"
      />
      <circle cx="26" cy="7" r="4" fill="#0B5FD3" />
    </svg>
  );
}
