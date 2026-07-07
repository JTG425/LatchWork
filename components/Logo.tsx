/* Latchwork brand mark — an "L" drawn as a circuit trace inside a chip
   package, running from an input via (blue) to an output via (green).
   The same artwork ships as the favicon in app/icon.svg. */
export default function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>
      <defs>
        <linearGradient id="lwmark" x1="24" y1="16" x2="47" y2="45" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0a84ff" />
          <stop offset="1" stopColor="#30d158" />
        </linearGradient>
      </defs>
      <path d="M2 20 H6 M2 32 H6 M2 44 H6 M58 20 H62 M58 32 H62 M58 44 H62" stroke="#5a5a66" strokeWidth="3" strokeLinecap="round" />
      <rect x="6" y="6" width="52" height="52" rx="14" fill="#26262c" stroke="#45454f" strokeWidth="2.5" />
      <path d="M25 17 V45 H46" fill="none" stroke="url(#lwmark)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="17" r="5" fill="#0a84ff" />
      <circle cx="46" cy="45" r="5" fill="#30d158" />
    </svg>
  );
}
