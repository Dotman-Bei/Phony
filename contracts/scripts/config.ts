import { ethers } from "hardhat";

/**
 * Per-network deployment configuration.
 *
 * The mock yield sources exist only where `useMocks` is true. On mainnet the strategy
 * adapters must be pointed at real protocol addresses via env vars — the deploy script
 * refuses to run with mocks on a network configured `useMocks: false`, so a testnet
 * shortcut cannot reach production by accident.
 */
export interface NetworkConfig {
  label: string;
  /** Deploy mock RWA token + mock yield sources instead of using real addresses. */
  useMocks: boolean;
  asset: {
    address?: string;
    name: string;
    symbol: string;
    decimals: number;
  };
  vault: {
    name: string;
    symbol: string;
  };
  /** Allocation weights in bps. The gap to 10 000 is the vault's idle reserve buffer. */
  allocations: {
    tbillBps: bigint;
    creditBps: bigint;
    liquidityBps: bigint;
  };
  /** Per-strategy deposit caps in whole tokens; 0 = uncapped. */
  caps: {
    tbill: bigint;
    credit: bigint;
    liquidity: bigint;
  };
  /** Advertised rates for the mock sources, in bps. Ignored when `useMocks` is false. */
  mockRates: {
    tbillApyBps: bigint;
    creditApyBps: bigint;
    creditUtilisationBps: bigint;
    liquidityApyBps: bigint;
  };
  /** Real protocol addresses. Required when `useMocks` is false. */
  external: {
    tbillYieldSource?: string;
    creditPool?: string;
    liquidityPool?: string;
  };
  performanceFeeBps: bigint;
  /** Vault-level TVL ceiling in whole tokens; 0 = uncapped. */
  depositCap: bigint;
  maxSlippageBps: bigint;
}

const SHARED = {
  vault: { name: "Phony RWA Vault", symbol: "brRWA" },
  allocations: { tbillBps: 4_000n, creditBps: 3_500n, liquidityBps: 2_000n },
  performanceFeeBps: 1_000n,
  maxSlippageBps: 100n,
};

export const NETWORKS: Record<string, NetworkConfig> = {
  hardhat: {
    ...SHARED,
    label: "Hardhat (in-process)",
    useMocks: true,
    asset: { name: "Tokenized T-Bill", symbol: "TBILL", decimals: 18 },
    caps: { tbill: 0n, credit: 0n, liquidity: 0n },
    mockRates: {
      tbillApyBps: 420n,
      creditApyBps: 800n,
      creditUtilisationBps: 0n,
      liquidityApyBps: 650n,
    },
    external: {},
    depositCap: 0n,
  },

  localhost: {
    ...SHARED,
    label: "Localhost",
    useMocks: true,
    asset: { name: "Tokenized T-Bill", symbol: "TBILL", decimals: 18 },
    caps: { tbill: 0n, credit: 0n, liquidity: 0n },
    mockRates: {
      tbillApyBps: 420n,
      creditApyBps: 800n,
      creditUtilisationBps: 0n,
      liquidityApyBps: 650n,
    },
    external: {},
    depositCap: 0n,
  },

  botTestnet: {
    ...SHARED,
    label: "BOT Chain Testnet",
    useMocks: true,
    asset: { name: "Tokenized T-Bill", symbol: "TBILL", decimals: 18 },
    // Caps on testnet keep a single faucet-happy tester from skewing the allocation chart.
    caps: { tbill: 5_000_000n, credit: 5_000_000n, liquidity: 5_000_000n },
    mockRates: {
      tbillApyBps: 420n,
      creditApyBps: 800n,
      // 60% out on loan, so the UI genuinely exercises the partial-liquidity path.
      creditUtilisationBps: 6_000n,
      liquidityApyBps: 650n,
    },
    external: {},
    depositCap: 0n,
  },

  botMainnet: {
    ...SHARED,
    label: "BOT Chain Mainnet",
    // Mainnet must point at real RWA protocol addresses. Set these before deploying:
    //   ASSET_ADDRESS, TBILL_YIELD_SOURCE, CREDIT_POOL, LIQUIDITY_POOL
    useMocks: process.env.MAINNET_USE_MOCKS === "true",
    asset: {
      address: process.env.ASSET_ADDRESS,
      name: "Tokenized T-Bill",
      symbol: "TBILL",
      decimals: Number(process.env.ASSET_DECIMALS || 18),
    },
    caps: { tbill: 0n, credit: 0n, liquidity: 0n },
    mockRates: {
      tbillApyBps: 420n,
      creditApyBps: 800n,
      creditUtilisationBps: 6_000n,
      liquidityApyBps: 650n,
    },
    external: {
      tbillYieldSource: process.env.TBILL_YIELD_SOURCE,
      creditPool: process.env.CREDIT_POOL,
      liquidityPool: process.env.LIQUIDITY_POOL,
    },
    // Start capped. Raise it once the vault has run on mainnet with real capital.
    depositCap: BigInt(process.env.DEPOSIT_CAP || 1_000_000),
  },
};

export function configFor(networkName: string): NetworkConfig {
  const config = NETWORKS[networkName];
  if (!config) {
    throw new Error(
      `No deployment config for network "${networkName}". Add one to scripts/config.ts.`,
    );
  }
  return config;
}

export function scaled(whole: bigint, decimals: number): bigint {
  return whole === 0n ? 0n : whole * 10n ** BigInt(decimals);
}

export async function currentNetworkName(): Promise<string> {
  const { name } = await ethers.provider.getNetwork();
  return name;
}
