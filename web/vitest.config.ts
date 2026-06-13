/// <reference types="vitest/config" />
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Frontend unit-test runner. There is no production server here — these tests
// exercise pure, chain-free units in `lib/` (error humanizing, parimutuel odds,
// PTB constructors). Keep them deterministic: no wallet, no network.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the `@/*` -> project-root alias from tsconfig.json so test imports
    // can use the same paths as app code.
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
});
