"use client";

// Radial capacity gauge for the manage command center (GH#87): an outer
// minted/max arc in the event's category gradient, with an optional inner
// "checked-in / minted" arc for the Doors-Open stage. Numeric-first center.
// Deliberately NOT a green linear bar (that's the web2-CRM look we're avoiding).

interface CapacityRingProps {
  minted: number;
  max: number;
  /** When provided, draws the inner checked-in arc (checkedIn / minted). */
  checkedIn?: number;
  p1: string;
  p2: string;
  size?: number;
}

export function CapacityRing({ minted, max, checkedIn, p1, p2, size = 176 }: CapacityRingProps) {
  const pct = max > 0 ? Math.min(1, minted / max) : 0;
  const ciPct = checkedIn != null && minted > 0 ? Math.min(1, checkedIn / minted) : 0;
  const stroke = 13;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke) / 2 - 2;
  const innerR = r - stroke - 5;
  const C = 2 * Math.PI * r;
  const Ci = 2 * Math.PI * innerR;
  const gid = `capgrad-${size}`;
  const showInner = checkedIn != null;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${minted} of ${max} tickets minted${showInner ? `, ${checkedIn} checked in` : ""}`}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={p1} />
          <stop offset="100%" stopColor={p2} />
        </linearGradient>
      </defs>
      {/* outer track + minted arc */}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={stroke} />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - pct)}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: "stroke-dashoffset .6s ease" }}
      />
      {/* inner checked-in arc (Doors Open) */}
      {showInner && (
        <>
          <circle cx={cx} cy={cy} r={innerR} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth={5} />
          <circle
            cx={cx}
            cy={cy}
            r={innerR}
            fill="none"
            stroke="rgba(255,255,255,.62)"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={Ci}
            strokeDashoffset={Ci * (1 - ciPct)}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke-dashoffset .6s ease" }}
          />
        </>
      )}
      {/* center label */}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={30} fontWeight={700} fill="var(--fg)">
        {minted}
      </text>
      <text x={cx} y={cy + 19} textAnchor="middle" fontSize={12} fill="var(--fg3)">
        / {max} minted
      </text>
    </svg>
  );
}
