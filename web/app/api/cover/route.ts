// Server-only route: AI event-cover generation via Cloudflare Workers AI (SDXL).
// Returns raw PNG bytes (1280x720, 16:9) that the client wraps into a File and
// runs through the normal cover-upload flow. Holds CF_ACCOUNT_ID + CF_AI_TOKEN
// (server-only — NEVER NEXT_PUBLIC_). Mirrors /api/create-assist's guards.

import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";
import { verifyTurnstile, blockedByTurnstile } from "@/lib/turnstile";

export const dynamic = "force-dynamic";

// Cover gen draws the shared Cloudflare Neuron budget (a cost surface) and is
// UNAUTHENTICATED, so keep the per-IP allowance tight: one human regenerates a
// few covers while drafting an event, not a stream.
const RL_LIMIT = 4;
const RL_WINDOW_MS = 60_000;
// Hard GLOBAL daily ceiling so a small set of rotated IPs can't drain the shared
// 10k-Neuron/day Cloudflare budget (it's account-wide, and SDXL is Neuron-heavy).
// Kept well under the budget with headroom for other Workers AI on the account.
// ponytail: per-process unless KV is provisioned (then rateLimit() primes it
// globally); worst case the free button pauses until 00:00 UTC — cosmetic,
// self-healing, and the manual cover upload still works.
const GLOBAL_DAILY_LIMIT = 120;
const DAY_MS = 86_400_000;
// Prompt is short free text; cap the body before we touch Cloudflare.
const MAX_BODY_BYTES = 4 * 1024;
const MAX_PROMPT = 800;

// SDXL on Workers AI supports width/height (flux-1-schnell is square-only) and
// returns raw binary image bytes. 1280x720 = 16:9 banner; 20 is the model's max
// num_steps. ponytail: model id is fixed, not config — change here if it churns.
const CF_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

export async function POST(req: Request) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_AI_TOKEN;
  if (!accountId || !token) {
    return Response.json(
      {
        error:
          "AI covers aren't configured on this server (missing CF_ACCOUNT_ID / CF_AI_TOKEN).",
      },
      { status: 503 },
    );
  }

  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json({ error: "Prompt too large" }, { status: 413 });
  }

  let body: { prompt?: string; turnstileToken?: string };
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return Response.json({ error: "Prompt too large" }, { status: 413 });
    }
    body = JSON.parse(raw) as { prompt?: string; turnstileToken?: string };
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const ip = clientIpFromHeaders(req.headers);
  if (blockedByTurnstile(await verifyTurnstile(body.turnstileToken, ip))) {
    return Response.json(
      { error: "Quick verification needed — please retry." },
      { status: 403 },
    );
  }

  // Validate BEFORE spending any rate/budget allowance on junk prompts.
  const prompt = (body.prompt ?? "").trim().slice(0, MAX_PROMPT);
  if (prompt.length < 3) {
    return Response.json({ error: "Add a title or prompt first." }, { status: 400 });
  }

  const rl = rateLimit(`cover:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: `Too many covers — wait ${rl.retryAfterSec}s and try again.` },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }

  // Global daily Neuron-budget gate (UTC day). Date is fine in a route handler.
  const utcDay = new Date().toISOString().slice(0, 10);
  if (!rateLimit(`cover:global:${utcDay}`, GLOBAL_DAILY_LIMIT, DAY_MS).ok) {
    return Response.json(
      { error: "AI covers have hit today's free limit — upload a cover, or try again tomorrow." },
      { status: 503 },
    );
  }

  let cf: Response;
  try {
    cf = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt, width: 1280, height: 720, num_steps: 20 }),
      },
    );
  } catch {
    return Response.json(
      { error: "Couldn't reach the image service — try again." },
      { status: 502 },
    );
  }

  // Success = an affirmative image/* body. Anything else (JSON error envelope,
  // or an edge HTML/text page with a 200) is treated as a failure rather than
  // forwarded mislabeled as a PNG.
  const ct = cf.headers.get("content-type") ?? "";
  if (!cf.ok || !ct.startsWith("image/")) {
    let detail = `image service error (${cf.status})`;
    try {
      const j = (await cf.json()) as { errors?: { message?: string }[] };
      if (j?.errors?.[0]?.message) detail = j.errors[0].message;
    } catch {
      /* non-JSON body — keep the status-based detail */
    }
    return Response.json(
      { error: `Cover generation failed: ${detail}` },
      { status: 502 },
    );
  }

  // Guard against a 200 with an empty/truncated body (content-filter blank, proxy
  // hiccup) slipping through as a 0-byte "image" that becomes a broken cover.
  const bytes = await cf.arrayBuffer();
  if (bytes.byteLength < 100) {
    return Response.json(
      { error: "Cover generation returned an empty image — try again." },
      { status: 502 },
    );
  }
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": ct, "cache-control": "no-store" },
  });
}
