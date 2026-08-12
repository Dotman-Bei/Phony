import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,

  turbopack: {
    resolveAlias: {
      // wagmi's Base Account connector lazily imports `@base-org/account`, which drags in
      // `@coinbase/cdp-sdk` and its unmet optional `@x402/*` peers — a Solana payment stack
      // irrelevant to a BOT Chain vault. Turbopack traces lazy imports statically, so the
      // missing peers fail the build even though the branch never executes. The wallet list
      // in `lib/wagmi.ts` does not offer Base Account, so this alias removes the subtree
      // rather than hiding a working feature.
      "@base-org/account": "./src/lib/stubs/base-account.ts",
    },
  },
};

export default config;
