import { defineChain } from "viem";

/**
 * BOT Chain mainnet. Chain id, RPC and explorer are the values published in the official
 * dev docs: https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/
 */
export const botChain = defineChain({
  id: 677,
  name: "BOT Chain",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_BOT_MAINNET_RPC || "https://rpc.botchain.ai"] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: "https://scan.botchain.ai" },
  },
});

/**
 * BOT Chain testnet — where the vault runs until mainnet deployment is the last step.
 *
 * Chain 968, served from bohr.life rather than a botchain.ai subdomain. That asymmetry is
 * the chain's, not a typo here, and it is why these defaults are pinned rather than
 * derived from the mainnet host.
 */
export const botTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_BOT_TESTNET_CHAIN_ID || 968),
  name: "BOT Chain Testnet",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_BOT_TESTNET_RPC || "https://rpc.bohr.life"],
    },
  },
  blockExplorers: {
    default: {
      name: "BOTScan (Testnet)",
      url: process.env.NEXT_PUBLIC_BOT_TESTNET_EXPLORER || "https://scan.bohr.life",
    },
  },
  testnet: true,
});

/** Local Hardhat node, for developing the UI without spending testnet gas. */
export const hardhatChain = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const supportedChains = [botChain, botTestnet, hardhatChain] as const;

/**
 * The chain the app targets by default. Testnet until the mainnet deployment lands,
 * at which point NEXT_PUBLIC_DEFAULT_CHAIN_ID flips to 677 — the frontend switch is a
 * single env var, not a code change.
 */
export const defaultChainId = Number(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID || botTestnet.id,
);

export function explorerUrlFor(chainId: number, kind: "tx" | "address", value: string): string {
  const chain = supportedChains.find((c) => c.id === chainId);
  const base = chain?.blockExplorers?.default.url;
  if (!base) return "";
  return `${base}/${kind === "tx" ? "tx" : "address"}/${value}`;
}
