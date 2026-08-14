import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import * as path from "path";

/**
 * Frontend test config — build.md §7.3.
 *
 * jsdom rather than a real browser: the four things the spec asks about (wallet connection,
 * the deposit flow, share-price accuracy, chart rendering) are all decidable without a GPU,
 * and a headless-browser suite that needs a funded wallet and a live testnet is exactly the
 * kind of test that gets skipped when it matters.
 *
 * Contract behaviour is not tested here. That lives in `contracts/test`, against a fork of
 * the real chain, because it is the chain's answer that matters — not a stub's.
 */
export default defineConfig({
  // plugin-react ships Vite's own Plugin type, which does not structurally match the plugin
  // union vitest/config re-exports. Same object at runtime; the cast keeps tsc quiet without
  // pinning a resolution override across two packages.
  plugins: [react() as never],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    // Recharts and wagmi both pull in a lot; give the suite room on a cold start.
    testTimeout: 20_000,
  },
});
