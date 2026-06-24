// Ticket-image resolver for on-chain Display.
//
// A Ticket's on-chain `image_url` field holds the EVENT's metadata blob id (a
// bare Walrus id), not a renderable image — so explorers/wallets that read the
// Display<Ticket> template show nothing. The Display image_url is set to
// `https://sui.hostit.events/api/ticket-image/{image_url}`, which lands here:
// we read the event metadata, find its cover blob, and redirect to the real
// image on Walrus. Works for existing + future tickets, no Move change.

import { getEventMetadata } from "@/lib/metadata";
import { blobUrl } from "@/lib/walrus";

export const dynamic = "force-dynamic";

function redirect(location: string, cache: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": cache } });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fallback = new URL("/brand/icon.png", req.url).toString();
  try {
    const meta = await getEventMetadata(id);
    if (meta?.coverBlobId) {
      // event→cover is content-addressed & immutable — cache hard at the edge.
      return redirect(blobUrl(meta.coverBlobId), "public, max-age=86400, s-maxage=604800, immutable");
    }
    // Valid metadata, just no cover — brand placeholder, modest cache.
    return redirect(fallback, "public, max-age=3600");
  } catch {
    // Transient Walrus/parse failure — don't cache the fallback.
    return redirect(fallback, "no-store");
  }
}
