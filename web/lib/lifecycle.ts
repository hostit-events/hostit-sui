"use client";

// The per-event manage page is organized around the event's on-chain lifecycle
// stage (GH#87). The stage is derived purely from the event's on-chain clock +
// capacity, so the page can re-light the rail and recompose the deck the moment
// a boundary passes (e.g. sales open, doors open) with no reload.

import { useEffect, useState } from "react";

export type LifecycleStage = "drafting" | "onSale" | "doorsOpen" | "wrapped";

export interface StageInput {
  purchaseStartMs: number;
  startMs: number;
  endMs: number;
}

/** Pure: derive the lifecycle stage from on-chain times and `now` (epoch ms). */
export function lifecycleStage(e: StageInput, now: number): LifecycleStage {
  if (now >= e.endMs) return "wrapped";
  if (now >= e.startMs) return "doorsOpen";
  if (now >= e.purchaseStartMs) return "onSale";
  return "drafting";
}

export const STAGE_ORDER: readonly LifecycleStage[] = [
  "drafting",
  "onSale",
  "doorsOpen",
  "wrapped",
];

export const STAGE_LABEL: Record<LifecycleStage, string> = {
  drafting: "Drafting",
  onSale: "On sale",
  doorsOpen: "Doors open",
  wrapped: "Wrapped",
};

/** Index of a stage in the canonical order (for past/now/future styling). */
export function stageIndex(stage: LifecycleStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/**
 * A `now` (epoch ms) that re-renders on an interval, so a stage boundary passing
 * while the page is open re-lights the rail without a reload. The initial value
 * is read lazily (not during render) to keep `Date.now()` out of the render body.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
