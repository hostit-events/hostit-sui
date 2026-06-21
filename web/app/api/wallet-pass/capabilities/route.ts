// Public capability probe: tells the client which wallet-pass providers are
// configured, so the ticket dialog only shows buttons that will work. Returns
// booleans only — never any credential material.

import { walletCapabilities } from "@/lib/walletPass.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(walletCapabilities());
}
