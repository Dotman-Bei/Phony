/**
 * Build-time stub for `@base-org/account`.
 *
 * wagmi's Base Account connector lazily imports this package, which pulls in
 * `@coinbase/cdp-sdk` and its optional `@x402/*` peers — a Solana payment stack that has
 * nothing to do with a BOT Chain vault. Turbopack resolves lazy imports statically, so the
 * unmet optional peers fail the build even though the code never runs.
 *
 * The wallet list in `wagmi.ts` deliberately does not offer Base Account, so this module
 * is unreachable at runtime. It throws rather than returning a fake SDK: if the connector
 * ever does get wired up, a clear error beats a silent no-op wallet.
 */
export function createBaseAccountSDK(): never {
  throw new Error(
    "Base Account is not enabled in this build. Connect with an injected wallet or WalletConnect.",
  );
}

export function getCryptoKeyAccount(): never {
  throw new Error("Base Account is not enabled in this build.");
}

export function removeCryptoKey(): never {
  throw new Error("Base Account is not enabled in this build.");
}

export const base = undefined;

const stub = { createBaseAccountSDK, getCryptoKeyAccount, removeCryptoKey };
export default stub;
