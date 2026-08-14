import type { Address } from "viem";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { mock } from "wagmi/connectors";

import { botTestnet } from "@/lib/chains";
import type { StrategyView, VaultData } from "@/hooks/useVault";

/** The address wagmi's mock connector reports as connected. */
export const TEST_ACCOUNT: Address = "0xE685f7D9FDB0F05e0A743A25c801d48434773446";

export const VAULT_ADDRESS: Address = "0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab";
export const STRATEGY_ADDRESS: Address = "0xb4F64d4dC539BaE035F8d90032D81566651AFc3D";

/** USDT is 6 decimals — the decimal count that broke the app once, so tests use the real one. */
export const usdt = (whole: number) => BigInt(Math.round(whole * 1e6));

export function strategyFixture(overrides: Partial<StrategyView> = {}): StrategyView {
  return {
    id: 0,
    address: STRATEGY_ADDRESS,
    name: "BDEX V2 - USDT/WBOT",
    shortName: "BDEX LP",
    risk: "medium",
    swatch: "#8562ff",
    summary: "Provides single-sided liquidity to a live BDEX V2 pair.",
    riskNote: "Impermanent loss is real. Half the position is WBOT.",
    liquidity: "Same block, minus the round-trip swap fee",
    source: "BDEX V2, 0.30% fee tier",
    assets: usdt(600),
    targetBps: 6_000n,
    actualBps: 6_000n,
    apyBps: 0n,
    maxDeposit: usdt(500),
    active: true,
    ...overrides,
  };
}

/**
 * A vault in a known state. Defaults mirror the live testnet deployment: 6-decimal USDT, a
 * share price just under 1 because real entry and exit costs have been paid, 60/40 split.
 */
export function vaultFixture(overrides: Partial<VaultData> = {}): VaultData {
  return {
    ready: true,
    isLoading: false,
    mode: "live",
    chainId: botTestnet.id,

    vaultAddress: VAULT_ADDRESS,
    routerAddress: "0x2B4f2B65374D62b85fF44d818A2691dd1875e6A4",
    assetAddress: "0x75edC9335175Fc0552D51D48439F229c10420fe3",

    assetSymbol: "USDT",
    assetDecimals: 6,
    shareSymbol: "brRWA",

    totalAssets: usdt(1_000),
    totalSupply: usdt(1_000),
    sharePrice: usdt(1),
    idleAssets: usdt(400),
    deployedAssets: usdt(600),
    availableLiquidity: usdt(990),
    weightedApyBps: 0n,
    netApyBps: 0n,
    performanceFeeBps: 1_000n,
    totalYieldHarvested: 0n,
    lastHarvestTime: 0n,
    depositCap: usdt(1_000),
    reserveBps: 4_000n,
    paused: false,

    shares: 0n,
    positionValue: 0n,
    walletBalance: usdt(3),
    allowance: 0n,
    maxWithdraw: 0n,

    strategies: [strategyFixture()],
    refetch: () => {},
    ...overrides,
  };
}

/**
 * wagmi wired to BOT Chain testnet with the mock connector, so connection can be driven
 * without a browser extension. The chain list is the app's own, not a test-only stand-in —
 * a wallet test that connects to the wrong chain would be worthless.
 */
export function createTestConfig(connected = false) {
  return createConfig({
    chains: [botTestnet],
    connectors: [mock({ accounts: [TEST_ACCOUNT], features: { reconnect: connected } })],
    transports: { [botTestnet.id]: http() },
    // No persistence. wagmi writes connections to localStorage by default, which jsdom shares
    // across tests in a file — so a config built in one test would rehydrate the previous
    // test's session and a disconnect assertion would see a connection it never made.
    storage: null,
  });
}

export function renderWithProviders(ui: ReactElement, connected = false) {
  const config = createTestConfig(connected);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return {
    config,
    ...render(
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </WagmiProvider>,
    ),
  };
}
