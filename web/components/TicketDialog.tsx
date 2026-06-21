"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { getEventMetadata } from "@/lib/metadata";
import { svgQrToPngBlob, downloadBlob, shareOrDownloadPng } from "@/lib/qrPng";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { TicketQr } from "@/components/TicketQr";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function fmtWhen(startMs?: number): string | undefined {
  if (!startMs || Number.isNaN(startMs)) return undefined;
  const d = new Date(startMs);
  const date = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

export interface TicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  name: string;
  serial: string;
  eventId: string;
  checkedIn: boolean;
  startMs?: number;
  /** Event `uri` (Walrus blob id / URL) — resolved to venue/city for display + pass. */
  uri?: string;
  /** Check-in + refund controls, rendered by the caller (single source of truth). */
  actions?: ReactNode;
}

export function TicketDialog(props: TicketDialogProps) {
  const { open, onOpenChange, ticketId, name, serial, eventId, checkedIn, startMs, uri, actions } = props;
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const [venue, setVenue] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [caps, setCaps] = useState<{ apple: boolean; google: boolean } | null>(null);
  const [busy, setBusy] = useState<"qr" | "apple" | "google" | null>(null);

  const whenText = fmtWhen(startMs);

  // Resolve venue lazily once the dialog is open. Keyed only on [open, uri] so
  // capabilities resolving later doesn't re-trigger (and double-fetch) this.
  useEffect(() => {
    if (!open || !uri) return;
    let alive = true;
    getEventMetadata(uri)
      .then((m) => {
        if (alive && m) setVenue([m.venue, m.city].filter(Boolean).join(", ") || undefined);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, uri]);

  // Probe which wallet providers are configured — once, on first open.
  useEffect(() => {
    if (!open || caps !== null) return;
    let alive = true;
    fetch("/api/wallet-pass/capabilities")
      .then((r) => (r.ok ? r.json() : { apple: false, google: false }))
      .then((c) => alive && setCaps(c))
      .catch(() => alive && setCaps({ apple: false, google: false }));
    return () => {
      alive = false;
    };
  }, [open, caps]);

  function getQrSvg(): SVGSVGElement | null {
    return qrWrapRef.current?.querySelector("svg") ?? null;
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(ticketId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the ticket id.");
    }
  }

  async function downloadQr() {
    const svg = getQrSvg();
    if (!svg) return;
    setBusy("qr");
    try {
      const blob = await svgQrToPngBlob(svg);
      downloadBlob(blob, `hostit-ticket-${serial || ticketId.slice(2, 10)}.png`);
    } catch {
      toast.error("Couldn't export the QR image.");
    } finally {
      setBusy(null);
    }
  }

  async function shareQr() {
    const svg = getQrSvg();
    if (!svg) return;
    setBusy("qr");
    try {
      const blob = await svgQrToPngBlob(svg);
      const how = await shareOrDownloadPng(blob, `hostit-ticket-${serial || ticketId.slice(2, 10)}.png`, name);
      if (how === "downloaded") toast.success("Saved the ticket QR.");
    } catch {
      toast.error("Couldn't share the QR image.");
    } finally {
      setBusy(null);
    }
  }

  async function addToWallet(platform: "apple" | "google") {
    setBusy(platform);
    try {
      const res = await fetch(`/api/wallet-pass/${ticketId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, name, dateText: whenText, venue, serial }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Pass generation failed" }));
        toast.error(error ?? "Pass generation failed");
        return;
      }
      if (platform === "google") {
        const { saveUrl } = await res.json();
        window.open(saveUrl, "_blank", "noopener,noreferrer");
      } else {
        const blob = await res.blob();
        downloadBlob(blob, `hostit-${ticketId.slice(2, 10)}.pkpass`);
      }
    } catch {
      toast.error("Couldn't reach the pass service.");
    } finally {
      setBusy(null);
    }
  }

  const title = name || "Ticket";
  const description = checkedIn ? "Checked in" : "Show this QR at the door to check in.";

  const body = (
    <div className="flex flex-col gap-5">
      {/* big scannable QR */}
      <div className="flex flex-col items-center gap-2">
        <div ref={qrWrapRef}>
          <TicketQr ticketId={ticketId} size={216} />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{checkedIn ? "Checked in" : "Valid"}</Badge>
          {serial && <span className="mono text-xs text-muted-foreground">#{serial}</span>}
        </div>
      </div>

      {/* meta */}
      <div className="flex flex-col gap-2.5 text-sm">
        {whenText && (
          <Row icon="proicons:calendar" label="When" value={whenText} />
        )}
        {venue && <Row icon="ph:map-pin-fill" label="Where" value={venue} />}
        <div className="flex items-center gap-2">
          <Icon icon="ph:identification-card-fill" size={15} className="flex-none text-muted-foreground" />
          <span className="text-muted-foreground">Ticket</span>
          <button
            type="button"
            onClick={copyId}
            className="mono ml-auto inline-flex items-center gap-1.5 truncate text-xs text-foreground transition-colors hover:text-primary"
            aria-label={copied ? "Ticket id copied" : "Copy ticket id"}
          >
            <span className="truncate">{ticketId.slice(0, 10)}…{ticketId.slice(-4)}</span>
            <Icon icon={copied ? "ic:round-check" : "ic:round-content-copy"} size={14} className="flex-none" />
          </button>
        </div>
      </div>

      {/* primary actions (check-in / refund) + view event */}
      {(actions || eventId) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {eventId && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/event/${eventId}`}>
                <Icon icon="ic:round-open-in-new" size={15} /> View event
              </Link>
            </Button>
          )}
        </div>
      )}

      {/* QR tools */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button variant="outline" size="sm" onClick={downloadQr} disabled={busy === "qr"} aria-busy={busy === "qr"}>
          <Icon icon="ic:round-download" size={15} /> Download QR
        </Button>
        <Button variant="outline" size="sm" onClick={shareQr} disabled={busy === "qr"} aria-busy={busy === "qr"}>
          <Icon icon="ic:round-ios-share" size={15} /> Share
        </Button>
      </div>

      {/* wallet passes — only shown for configured providers */}
      {caps && (caps.apple || caps.google) && (
        <div className="flex flex-wrap items-center gap-2">
          {caps.apple && (
            <Button variant="outline" size="sm" onClick={() => addToWallet("apple")} disabled={busy === "apple"} aria-busy={busy === "apple"}>
              <Icon icon="mdi:apple" size={16} /> Add to Apple Wallet
            </Button>
          )}
          {caps.google && (
            <Button variant="outline" size="sm" onClick={() => addToWallet("google")} disabled={busy === "google"} aria-busy={busy === "google"}>
              <Icon icon="logos:google-icon" size={14} /> Add to Google Wallet
            </Button>
          )}
        </div>
      )}
    </div>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92vh] gap-0 overflow-y-auto rounded-t-2xl px-4 pb-8">
        <SheetHeader className="px-0">
          <SheetTitle className="truncate">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function Row({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon icon={icon} size={15} className="flex-none text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto truncate text-right text-foreground">{value}</span>
    </div>
  );
}
