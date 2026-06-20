import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Browser-side origins the app legitimately talks to. Derived from
// web/lib/config.ts (Walrus aggregator/publisher, Seal aggregator), the Sui
// fullnode (resolved by @mysten/sui's getJsonRpcFullnodeUrl), the Enoki API
// (zkLogin + sponsor), Iconify (runtime icon data), and Google (zkLogin
// redirect). NOTE: api.groq.com is called ONLY server-side (app/api/*) and is
// deliberately NOT listed here. Keep this list in sync if those origins change.
const CONNECT_SRC = [
  "'self'",
  "https://fullnode.testnet.sui.io",
  "https://fullnode.mainnet.sui.io",
  "https://api.enoki.mystenlabs.com",
  "https://aggregator.walrus-testnet.walrus.space",
  "https://publisher.walrus-testnet.walrus.space",
  "https://seal-aggregator-testnet.mystenlabs.com",
  "https://api.iconify.design",
  "https://accounts.google.com",
];

const IMG_SRC = [
  "'self'",
  "data:",
  "blob:",
  "https://aggregator.walrus-testnet.walrus.space",
  "https://placehold.co",
  "https://*.suivision.xyz",
];

const SCRIPT_SRC = ["'self'", "'unsafe-inline'", "https://code.iconify.design"];

// Google Fonts CSS (@import in app/globals.css) needs the stylesheet host;
// 'unsafe-inline' covers Next/shadcn/next-themes injected inline styles.
const STYLE_SRC = ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"];

const FONT_SRC = ["'self'", "data:", "https://fonts.gstatic.com"];

/**
 * Build the Content-Security-Policy header value. Exported so it can be unit
 * tested (web/lib/__tests__/securityHeaders.test.ts) without a running server.
 * `dev=true` loosens it for Turbopack/HMR (eval + ws); production is strict.
 */
export function buildCsp(dev = isDev): string {
  const connect = dev
    ? [...CONNECT_SRC, "ws:", "wss:", "http://localhost:*"]
    : CONNECT_SRC;
  const script = dev ? [...SCRIPT_SRC, "'unsafe-eval'"] : SCRIPT_SRC;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": script,
    "style-src": STYLE_SRC,
    "img-src": IMG_SRC,
    "font-src": FONT_SRC,
    "connect-src": connect,
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'", "https://accounts.google.com"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: buildCsp() },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "**.suivision.xyz" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
