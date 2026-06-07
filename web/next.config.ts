import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  reactStrictMode: true,
  // Pin the trace root since the repo has both bun.lock (root) and pnpm-lock.yaml (web/).
  outputFileTracingRoot: path.join(import.meta.dirname, ""),
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "**.suivision.xyz" },
    ],
  },
};

export default config;
