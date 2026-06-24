// AI event-cover generation (client side). Builds a text-free poster prompt from
// the event's title + category and asks /api/cover (Cloudflare Workers AI, SDXL)
// for a 1280x720 image, returned as a File you feed straight into the existing
// cover-upload flow (pickCover -> Walrus on publish). No new storage code.

import { getTurnstileToken } from "@/lib/turnstileClient";

// Per-category visual seed so a bare title still yields an on-theme cover. The
// model never renders text reliably, so we steer it AWAY from words (our UI
// overlays the real title) and toward a vivid background. Keyed by CATEGORIES id.
const CATEGORY_HINT: Record<string, string> = {
  music: "concert stage lights, festival crowd energy",
  web3: "abstract blockchain network, glowing neon nodes, futuristic",
  tech: "futuristic technology, circuit patterns, sleek and clean",
  sports: "dynamic stadium energy, athletic motion",
  arts: "expressive abstract art, bold paint strokes and color",
  food: "gourmet food and drink spread, warm inviting light",
  community: "diverse people gathering, warm welcoming mood",
};

/** Compose an SDXL prompt from the event title + category id. */
export function buildCoverPrompt(title: string, category: string): string {
  const subject = title.trim() || "a vibrant community event";
  const hint = CATEGORY_HINT[category] ?? "vibrant celebratory gathering";
  return `${subject}. ${hint}. Event cover poster background art, cinematic lighting, rich color, high detail, no text, no words, no letters, no typography.`;
}

/**
 * Generate a cover via /api/cover and return it as a File ready for pickCover().
 * Throws with a human-readable message on failure (the caller toasts it).
 */
export async function generateCover(prompt: string): Promise<File> {
  const turnstileToken = await getTurnstileToken();
  const resp = await fetch("/api/cover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, turnstileToken }),
  });
  if (!resp.ok) {
    let msg = `Cover generation failed (${resp.status})`;
    try {
      const j = (await resp.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  return new File([blob], "ai-cover.png", { type: blob.type || "image/png" });
}
