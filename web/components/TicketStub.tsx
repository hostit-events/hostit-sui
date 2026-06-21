"use client";

import { catPalette, catGlyph } from "@/lib/data";
import { Icon } from "@/components/Icon";

// FNV-1a 32-bit — deterministic, SSR/hydration-safe (no Math.random), so the
// faux-QR matrix is identical on server and client for a given seed.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A deterministic faux-QR seeded from `seed`: a 21×21 matrix with three real
// finder squares so it reads as a ticket QR. It encodes nothing — on publish the
// app mints the real scannable code (see plan 013); here it's the "to be minted"
// artifact. `on` = published/active (inks solid), else a ghosted preview.
function FauxQr({ seed, size = 64, on }: { seed: string; size?: number; on: boolean }) {
  const n = 21;
  // Per-cell deterministic fill (pure — no mutable render-scope state).
  const cells = Array.from({ length: n * n }, (_, i) => (hash(`${seed}#${i}`) >>> 9) % 100 > 52);
  const finder = (r: number, c: number) => {
    const ring = (br: number, bc: number) => {
      const lr = r - br;
      const lc = c - bc;
      if (lr < 0 || lr > 6 || lc < 0 || lc > 6) return null;
      const edge = lr === 0 || lr === 6 || lc === 0 || lc === 6;
      const dot = lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4;
      return edge || dot;
    };
    return ring(0, 0) ?? ring(0, n - 7) ?? ring(n - 7, 0);
  };
  const fg = on ? "currentColor" : "rgba(255,255,255,.5)";
  return (
    <svg
      className="tstub-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {cells.map((cell, i) => {
        const r = Math.floor(i / n);
        const c = i % n;
        const f = finder(r, c);
        const fill = f === null ? cell : f;
        return fill ? <rect key={i} x={c} y={r} width={1.04} height={1.04} fill={fg} /> : null;
      })}
    </svg>
  );
}

function Meta({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="tstub-meta-label">{label}</div>
      <div className="tstub-meta-val" style={muted ? { color: "var(--fg3)" } : undefined}>
        {value}
      </div>
    </div>
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export interface TicketStubProps {
  name: string;
  category: string;
  /** ms epoch; NaN → "TBA". */
  startMs: number;
  endMs: number;
  venue?: string;
  city?: string;
  isFree: boolean;
  /** raw price string as typed (e.g. "25"); only used when !isFree. */
  price?: string;
  coinSymbol: string;
  capacity: string;
  /** connected organizer address, or null. */
  organizer: string | null;
  gasSponsored: boolean;
  /** true once the event is live — inks the QR and drops the MINTED seal. */
  published?: boolean;
}

/**
 * The live "ticket forge" artifact. As the create form fills, this composes the
 * actual ticket an attendee will hold: seeded generative art (by name+category),
 * a punched perforation, printed monospace meta, and a faux-QR that mints on
 * publish. The centerpiece of the redesigned create experience (#78).
 */
export function TicketStub({
  name,
  category,
  startMs,
  endMs,
  venue,
  city,
  isFree,
  price,
  coinSymbol,
  capacity,
  organizer,
  gasSponsored,
  published = false,
}: TicketStubProps) {
  const [p1, p2] = catPalette(category);
  const glyph = catGlyph(category);

  const whenValue = Number.isFinite(startMs)
    ? new Date(startMs).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Date TBA";
  const durMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : NaN;
  const durLabel =
    Number.isFinite(durMs) && durMs > 0
      ? durMs >= 86_400_000
        ? `${Math.round(durMs / 86_400_000)}d`
        : `${Math.round(durMs / 3_600_000)}h`
      : "";

  const whereValue = [venue?.trim(), city?.trim()].filter(Boolean).join(" · ") || "Location TBA";
  const admitValue = `${capacity?.trim() || "—"} · 1 / wallet`;
  const priceValue = isFree
    ? "Free"
    : price && price.trim() && Number(price) > 0
      ? `${price.trim()} ${coinSymbol} · +3%`
      : "Set price";

  const seed = `${name || "ticket"}::${category}`;

  return (
    <div className="tstub" style={{ ["--p1" as string]: p1, ["--p2" as string]: p2 }}>
      {/* art panel — seeded generative cover (no upload needed) */}
      <div className="tstub-art" style={{ ["--p1" as string]: p1, ["--p2" as string]: p2 }}>
        <div className="poster-noise" />
        <span className="poster-glyph">
          <Icon icon={glyph} size={88} />
        </span>
        <div className="tstub-foil">
          <span className="tstub-foil-dot" /> on Sui{gasSponsored ? " · gas sponsored" : ""}
        </div>
        <div className="tstub-cat">{category}</div>
        {published && (
          <div className="tstub-stamp" aria-hidden="true">
            MINTED
          </div>
        )}
      </div>

      {/* punched perforation (clipped half-circle notches at the edges) */}
      <div className="tstub-perf" aria-hidden="true">
        <span className="tstub-notch l" />
        <span className="tstub-notch r" />
      </div>

      {/* the printed stub */}
      <div className="tstub-body">
        <div className={`tstub-head${name.trim() ? "" : " placeholder"}`}>
          {name.trim() || "Your event name"}
        </div>

        <div className="tstub-meta">
          <Meta
            label="When"
            value={durLabel ? `${whenValue} · ${durLabel}` : whenValue}
            muted={!Number.isFinite(startMs)}
          />
          <Meta label="Where" value={whereValue} muted={whereValue === "Location TBA"} />
          <Meta label="Admit" value={admitValue} />
          <Meta label="Price" value={priceValue} muted={!isFree && priceValue === "Set price"} />
        </div>

        <div className="tstub-foot">
          <FauxQr seed={seed} on={published} />
          <div>
            <div className="tstub-foot-label">
              {published ? "Scannable at the door" : "Mints on publish"}
            </div>
            <div className="tstub-host">{organizer ? shortAddr(organizer) : "Your wallet · host"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
