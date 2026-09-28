// Foldrule logo — Direction A, "Folded F": three rule segments with brass
// hinges and tick marks. `tone="dark"` is for dark backgrounds (yellow rule),
// `tone="light"` for light backgrounds (graphite rule, yellow hinges).
// Ticks are dropped automatically at small sizes so the mark stays crisp.

import { BRAND } from '@/lib/brand';

type Tone = 'dark' | 'light';

const TICKS: [number, number, number, number][] = [
  [30, 19, 30, 14.5], [38, 19, 38, 14.5], [46, 19, 46, 14.5], [34, 19, 34, 16.5], [42, 19, 42, 16.5],
  [30, 41, 30, 36.5], [38, 41, 38, 36.5], [34, 41, 34, 38.5], [23, 47, 18.5, 47], [23, 51.5, 20.5, 51.5],
];

export function FoldruleMark({
  size = 32,
  tone = 'dark',
  detail,
  title,
  className,
}: {
  size?: number;
  tone?: Tone;
  /** Show tick marks. Defaults to on above 32 px. */
  detail?: boolean;
  /** Accessible name. Omit when the mark sits next to the wordmark. */
  title?: string;
  className?: string;
}) {
  const c = BRAND.colors;
  const seg   = tone === 'dark' ? c.rule : c.graphite;
  const tick  = tone === 'dark' ? c.graphite : c.paper;
  const hinge = tone === 'dark' ? c.graphite : c.rule;
  const showTicks = detail ?? size > 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect x="12" y="8" width="11" height="48" rx="2" fill={seg} />
      <rect x="12" y="8" width="42" height="11" rx="2" fill={seg} />
      <rect x="12" y="30" width="31" height="11" rx="2" fill={seg} />
      {showTicks && (
        <g stroke={tick} strokeWidth="1.4">
          {TICKS.map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />)}
        </g>
      )}
      <circle cx="17.5" cy="13.5" r="2.4" fill={hinge} />
      <circle cx="17.5" cy="35.5" r="2.4" fill={hinge} />
    </svg>
  );
}

export function Wordmark({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-archivo), Archivo, ui-sans-serif, system-ui, sans-serif',
        fontWeight: 700,
        fontStretch: '112%',
        letterSpacing: '-0.015em',
        lineHeight: 1,
        ...style,
      }}
    >
      {BRAND.wordmark}
    </span>
  );
}

/** Mark + wordmark lockup. `size` is the wordmark's font size in px. */
export function Logo({
  size = 22,
  tone = 'dark',
  className,
}: {
  size?: number;
  tone?: Tone;
  className?: string;
}) {
  const color = tone === 'dark' ? '#F4F5F6' : BRAND.colors.graphite;
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size / 2.6) }}>
      <FoldruleMark size={Math.round(size * 1.35)} tone={tone} />
      <span aria-hidden="true"><Wordmark style={{ fontSize: size, color }} /></span>
      <span className="sr-only">{BRAND.name}</span>
    </span>
  );
}
