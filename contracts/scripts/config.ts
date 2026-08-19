import { ethers } from "hardhat";

/**
 * Per-network deployment configuration — real protocol addresses only.
 *
 * There is no mock mode. Every address below is a contract someone else deployed and other
 * people already use: the chain's canonical USDT, and BDEX V2, whose Router02 was verified to
 * be a genuine Uniswap V2 deployment (`factory()` agrees with the published factory, `WETH()`
 * returns WBOT, and `getAmountsOut` matches the 997/1000 constant-product formula wei-exact
 * against live reserves).
 *
 * Sources:
 *   https://dev-docs.botchain.ai/docs/DEX/contract-addresses/
 *   https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/
 *
 * Why one strategy leg and a large idle reserve: BOT Chain has no lending market, no
 * tokenized-treasury issuer and no ERC-4626 vault — checked against both explorers' verified
 * contract indexes. BDEX is the only venue on the chain paying a real yield on USDT, so it is
 * the only leg that exists. The router's weights, caps, retirement and rebalancing are
 * untouched, and a second leg is a config entry rather than a code change the day another
 * venue ships. Inventing a second source to fill out the allocation chart would be the
 * dishonest option.
 */

export type RiskTier = "low" | "medium" | "high";

export interface LegConfig {
  /** Key used in the deployment manifest and by the frontend. */
  key: string;
  /** Name the adapter reports on chain, shown in the strategy explorer. */
  name: string;
  /** The other side of the BDEX pair. The pair itself is resolved through the factory. */
  pairedToken: string;
  pairedSymbol: string;
  /** Target allocation in bps. The gap to 10 000 across all legs is the idle reserve. */
  weightBps: bigint;
  /** Per-strategy cap in whole asset units; 0 = uncapped. Sized against pool depth. */
  capWhole: bigint;
  risk: RiskTier;
}

export interface NetworkConfig {
  label: string;
  asset: { address: string; symbol: string; decimals: number };
  dex: { router: string };
  vault: { name: string; symbol: string };
  legs: LegConfig[];
  performanceFeeBps: bigint;
  /** Vault-level TVL ceiling in whole asset units; 0 = uncapped. */
  depositCap: bigint;
  maxSlippageBps: bigint;
}

const SHARED = {
  vault: { name: "Phony RWA Vault", symbol: "brRWA" },
  performanceFeeBps: 1_000n,
  // 1% covers the 0.15% round-trip swap fee on half the position plus price impact at the
  // sizes these pools support. Entry reverts rather than accept worse.
  maxSlippageBps: 100n,
};

/** WBOT is deployed at the same address on both networks. */
const WBOT = "0xD5452816194a3784dBa983426cCe7c122F4abd30";

/**
 * Position-sizing override, scoped to one network.
 *
 * There is deliberately no unscoped `LEG_CAP` fallback. A single variable covering both
 * networks reads as a convenience and behaves as a trap: testnet's USDT/WBOT pool is ~250x
 * deeper than mainnet's, so a number sized for one is badly wrong for the other. A `.env` left
 * over from testnet deploys, carrying `LEG_CAP=500` against a mainnet pool holding 26 USDT, is
 * exactly what preflight refused on the first mainnet attempt — and preflight is the backstop,
 * not the design. Scoping the name means the wrong value cannot be reached in the first place.
 */
function sized(scope: "TESTNET" | "MAINNET", name: string, fallback: bigint): bigint {
  const raw = process.env[`${scope}_${name}`];
  return raw === undefined || raw.trim() === "" ? fallback : BigInt(raw);
}

export const NETWORKS: Record<string, NetworkConfig> = {
  botTestnet: {
    ...SHARED,
    label: "BOT Chain Testnet",
    asset: {
      address: process.env.ASSET_ADDRESS || "0x75edC9335175Fc0552D51D48439F229c10420fe3",
      symbol: "USDT",
      decimals: Number(process.env.ASSET_DECIMALS || 6),
    },
    dex: { router: process.env.BDEX_V2_ROUTER || "0xD6425a02f0845B8D99e349C34D2E7A576E177345" },
    legs: [
      {
        key: "wbotLp",
        name: "BDEX V2 - USDT/WBOT",
        pairedToken: process.env.PAIRED_TOKEN || WBOT,
        pairedSymbol: "WBOT",
        weightBps: 6_000n,
        // The pair holds roughly 6.5k USDT. A position that is a large fraction of the pool
        // pays its own price impact twice — once entering, once leaving — and makes NAV a
        // function of our own size rather than of the market. 500 keeps the deployed leg
        // under ~8% of depth.
        capWhole: sized("TESTNET", "LEG_CAP", 500n),
        risk: "medium",
      },
    ],
    depositCap: sized("TESTNET", "DEPOSIT_CAP", 1_000n),
  },

  botMainnet: {
    ...SHARED,
    label: "BOT Chain Mainnet",
    asset: {
      address: process.env.ASSET_ADDRESS || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
      symbol: "USDT",
      decimals: Number(process.env.ASSET_DECIMALS || 6),
    },
    dex: { router: process.env.BDEX_V2_ROUTER || "0x1414eD29FdFD322c3c0a830330ed982E2D629e76" },
    legs: [
      {
        key: "wbotLp",
        name: "BDEX V2 - USDT/WBOT",
        pairedToken: process.env.PAIRED_TOKEN || WBOT,
        pairedSymbol: "WBOT",
        weightBps: 6_000n,
        // Mainnet's USDT/WBOT pair holds ~25.7 USDT against testnet's ~6 500, so the cap is
        // two, not the 10 000 this used to say. `npm run scan:mainnet` prints the survey the
        // number comes from. It is a small vault because it is a small pool, and sizing the
        // cap to the pool we wish existed would only mean paying our own price impact twice
        // and calling the result yield.
        capWhole: sized("MAINNET", "LEG_CAP", 2n),
        risk: "medium",
      },
    ],
    // ~7.5% of pool depth deployed at the cap, matching testnet's discipline. Raise both the
    // day the pool is deeper — `npm run preflight:mainnet` refuses the deploy if they drift
    // past what the pool can absorb, so this is checked rather than remembered.
    depositCap: sized("MAINNET", "DEPOSIT_CAP", 5n),
  },
};

/**
 * The in-process network is a fork of testnet, which is what the test suite runs against —
 * real BDEX, real USDT, no stand-ins.
 */
NETWORKS.hardhat = { ...NETWORKS.botTestnet, label: "Hardhat (fork of BOT Chain Testnet)" };
NETWORKS.localhost = NETWORKS.hardhat;

export function configFor(networkName: string): NetworkConfig {
  const config = NETWORKS[networkName];
  if (!config) {
    throw new Error(
      `No deployment config for network "${networkName}". Add one to scripts/config.ts.`,
    );
  }
  return config;
}

/** Unallocated weight — the vault's instantly-exitable idle reserve. */
export function reserveBufferBps(config: NetworkConfig): bigint {
  return config.legs.reduce((rest, leg) => rest - leg.weightBps, 10_000n);
}

export function scaled(whole: bigint, decimals: number): bigint {
  return whole === 0n ? 0n : whole * 10n ** BigInt(decimals);
}

export async function currentNetworkName(): Promise<string> {
  const { name } = await ethers.provider.getNetwork();
  return name;
}
