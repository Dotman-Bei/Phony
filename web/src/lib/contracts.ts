import type { Abi, Address } from "viem";

import { abis, deployments } from "./contracts.generated";
import { defaultChainId } from "./chains";

/**
 * Typed accessors over the generated artifact bundle.
 *
 * `contracts.generated.ts` is written by `contracts/scripts/exportAbi.ts` and is the only
 * place addresses enter the app. Everything downstream asks *this* module, so an
 * un-deployed chain is a well-typed `null` rather than an undefined address that fails at
 * call time with an unreadable RPC error.
 */

export type ContractKey =
  | "asset"
  | "vault"
  | "router"
  | "tbillStrategy"
  | "creditStrategy"
  | "liquidityStrategy"
  | "tbillSource"
  | "creditPool"
  | "liquidityPool";

export interface DeploymentRecord {
  network: string;
  usesMocks: boolean;
  contracts: Record<string, string>;
  config: {
    allocationsBps: Record<string, string>;
    performanceFeeBps: string;
    depositCap: string;
    reserveBufferBps: string;
  };
}

const registry = deployments as unknown as Record<string, DeploymentRecord>;

export const vaultAbi = abis.botVault as unknown as Abi;
export const routerAbi = abis.strategyRouter as unknown as Abi;
export const strategyAbi = abis.strategyAdapter as unknown as Abi;
export const creditStrategyAbi = abis.creditStrategy as unknown as Abi;
export const liquidityStrategyAbi = abis.liquidityStrategy as unknown as Abi;
export const tbillStrategyAbi = abis.tbillStrategy as unknown as Abi;
export const rwaTokenAbi = abis.rwaToken as unknown as Abi;

export function deploymentFor(chainId: number | undefined): DeploymentRecord | null {
  if (chainId === undefined) return null;
  return registry[String(chainId)] ?? null;
}

export function addressFor(chainId: number | undefined, key: ContractKey): Address | null {
  const record = deploymentFor(chainId);
  const value = record?.contracts?.[key];
  return value ? (value as Address) : null;
}

/** True when this chain has a deployment the app can actually talk to. */
export function isConfigured(chainId: number | undefined): boolean {
  return deploymentFor(chainId) !== null;
}

/**
 * How the numbers on screen were produced.
 *
 * `live`  — a deployment wired to real RWA protocol addresses.
 * `demo`  — a deployment whose yield sources are the mock contracts. Real transactions,
 *           real share accounting, simulated coupons. Never labelled live.
 * `unconfigured` — no deployment for this chain.
 *
 * This is the honesty rule the design system takes seriously enough to give it a saturated
 * colour, and it is why testnet APYs are never presented as market rates.
 */
export type DataMode = "live" | "demo" | "unconfigured";

export function dataModeFor(chainId: number | undefined): DataMode {
  const record = deploymentFor(chainId);
  if (!record) return "unconfigured";
  return record.usesMocks ? "demo" : "live";
}

/** Chains this build has addresses for, for the "wrong network" prompt. */
export function configuredChainIds(): number[] {
  return Object.keys(registry).map(Number);
}

export const fallbackChainId = defaultChainId;
