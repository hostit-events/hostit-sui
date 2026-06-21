"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * Real, scannable QR encoding the ticket's bare on-chain object id. The door
 * camera scanner decodes it and `extractTicketId` (lib/staffKey.ts) reads the id
 * directly via its `isValidSuiObjectId` branch — so the encoded value MUST be the
 * bare object id, with no URL/JSON wrapper. `QRCodeSVG` renders an inline SVG and
 * is SSR-safe (no canvas/DOM-measure), so no client-only guard is needed; the
 * SVG is also what `lib/qrPng.ts` rasterizes for download/share.
 */
export function TicketQr({ ticketId, size = 54 }: { ticketId: string; size?: number }) {
  return (
    <div style={{ background: "#fff", padding: 4, borderRadius: 7, flex: "none", lineHeight: 0 }}>
      <QRCodeSVG
        value={ticketId}
        size={size}
        bgColor="#ffffff"
        fgColor="#0C112B"
        level="M"
        aria-label="Ticket QR code"
      />
    </div>
  );
}
