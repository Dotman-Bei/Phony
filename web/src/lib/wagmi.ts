"use client";

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";

import { botChain, botTestnet, defaultChainId, hardhatChain } from "./chains";

/**
 * RainbowKit + wagmi configuration for BOT Chain.
 *
 * The wallet list is enumerated rather than taken from `getDefaultConfig`, for two reasons:
 *
 * 1. Only wallets that actually work here are offered. Base Account is excluded — its
 *    connector pulls a Solana payment SDK that has no place in this app, and offering a
 *    wallet the build has stubbed out would be worse than not listing it.
 * 2. WalletConnect only appears when a project id is configured. Without one its QR flow
 *    fails at the moment of connection, which is the worst possible time to discover a
 *    missing environment variable. Injected wallets need no id and cover BOT Chain users.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const hasWalletConnectProjectId = projectId.length > 0;

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: hasWalletConnectProjectId
        ? [injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet]
        : [injectedWallet, metaMaskWallet, rainbowWallet],
    },
    {
      groupName: "More",
      wallets: [trustWallet, okxWallet],
    },
  ],
  {
    appName: "Phony",
    appDescription: "RWA yield restaking and strategy vault on BOT Chain",
    projectId: projectId || "phony-injected-only",
  },
);

/**
 * Chain order matters beyond presentation: wagmi reports `chains[0]` as the active chain
 * for a disconnected visitor. Putting the configured default first means the landing page
 * reads the chain the vault is actually deployed on, instead of greeting every first-time
 * visitor with "not deployed on this network" before they have connected anything.
 */
const orderedChains = [botTestnet, botChain, hardhatChain].sort(
  (a, b) => Number(b.id === defaultChainId) - Number(a.id === defaultChainId),
) as unknown as readonly [typeof botTestnet, ...(typeof botChain)[]];

export const wagmiConfig = createConfig({
  chains: orderedChains,
  connectors,
  transports: {
    [botTestnet.id]: http(),
    [botChain.id]: http(),
    [hardhatChain.id]: http(),
  },
  ssr: true,
});
