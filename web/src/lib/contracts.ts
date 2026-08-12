import type { Abi, Address } from "viem";

import { abis, deployments } from "./contracts.generated";
import { defaultChainId } from "./chains";

/**
 * Typed accessors over the generated artifact bundle.
 *
 * `contracts.generated.ts` is written by `contracts/scripts/exportAbi.ts` and is the only place
 * addresses enter the app. Everything downstream asks *this* module, so an un-deployed chain is
 * a well-typed `null` rather than an undefined address that fails at call time with an
 * unreadable RPC error.
 */

/** Keys present in every deployment. Strategy legs are addressed through `legs`. */
export type ContractKey = "asset" | "vault" | "router";

export interface DeploymentLeg {
  key: string;
  name: string;
  risk: "low" | "medium" | "high";
  adapter: string;
  pair: string;
  pairedToken: string;
  pairedSymbol: string;
  weightBps: string;
  capWhole: string;
}

export interface DeploymentRecord {
  network: string;
  /**
   * Provenance of the numbers on screen. Always "live": the project has no mock yield
   * sources. The asset is the chain's own USDT and yield comes from a real BDEX pair.
   */
  sources: "live";
  asset: { address: string; symbol: string; decimals: number };
  dex: { router: string };
  contracts: Record<string, string>;
  legs: DeploymentLeg[];
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
export const bdexLpStrategyAbi = abis.bdexLpStrategy as unknown as Abi;
export const bdexPairAbi = abis.bdexPair as unknown as Abi;
/** The asset is a third-party ERC-20 now, so a plain ERC-20 surface is all the app needs. */
export const erc20Abi = abis.erc20 as unknown as Abi;

export function deploymentFor(chainId: number | undefined): DeploymentRecord | null {
  if (chainId === undefined) return null;
  return registry[String(chainId)] ?? null;
}

export function addressFor(chainId: number | undefined, key: ContractKey): Address | null {
  const record = deploymentFor(chainId);
  const value = record?.contracts?.[key];
  return value ? (value as Address) : null;
}

/** The strategy legs this deployment registered, in allocation order. */
export function legsFor(chainId: number | undefined): DeploymentLeg[] {
  return deploymentFor(chainId)?.legs ?? [];
}

/** True when this chain has a deployment the app can actually talk to. */
export function isConfigured(chainId: number | undefined): boolean {
  return deploymentFor(chainId) !== null;
}

/**
 * How the numbers on screen were produced.
 *
 * `live`          — real asset, real yield venue. Every deployment of this project.
 * `unconfigured`  — no deployment for this chain.
 *
 * There is deliberately no `demo` value. An earlier build shipped mock yield sources and had
 * to label them, which is a problem this design removed rather than disclosed: the vault holds
 * the chain's USDT and earns the trading fees of a live BDEX pair, so there is nothing to
 * caveat. What the UI must still be honest about is *liquidity* — see `maxWithdraw`.
 */
export type DataMode = "live" | "unconfigured";

export function dataModeFor(chainId: number | undefined): DataMode {
  return deploymentFor(chainId) ? "live" : "unconfigured";
}

/** Chains this build has addresses for, for the "wrong network" prompt. */
export function configuredChainIds(): number[] {
  return Object.keys(registry).map(Number);
}

export const fallbackChainId = defaultChainId;
