"use client";

import { useMemo } from "react";
import { useAccount, useChainId, useReadContracts } from "wagmi";
import type { Address } from "viem";

import {
  addressFor,
  dataModeFor,
  deploymentFor,
  routerAbi,
  erc20Abi,
  vaultAbi,
  type DataMode,
} from "@/lib/contracts";
import { metaFor, RESERVE_META, type RiskLevel } from "@/lib/strategyMeta";

export interface StrategyView {
  id: number;
  address: Address;
  name: string;
  shortName: string;
  risk: RiskLevel;
  swatch: string;
  summary: string;
  riskNote: string;
  liquidity: string;
  source: string;
  /** Assets currently held by the adapter, in asset base units. */
  assets: bigint;
  /** Curator's target weight, in bps of total deposits. */
  targetBps: bigint;
  /** Actual share of the vault's NAV, in bps. */
  actualBps: bigint;
  apyBps: bigint;
  maxDeposit: bigint;
  active: boolean;
}

export interface VaultData {
  ready: boolean;
  isLoading: boolean;
  mode: DataMode;
  chainId: number;

  vaultAddress: Address | null;
  routerAddress: Address | null;
  assetAddress: Address | null;

  assetSymbol: string;
  assetDecimals: number;
  shareSymbol: string;

  /** Vault-wide */
  totalAssets: bigint;
  totalSupply: bigint;
  sharePrice: bigint;
  idleAssets: bigint;
  deployedAssets: bigint;
  availableLiquidity: bigint;
  weightedApyBps: bigint;
  /** Blended APY including the idle buffer, which earns nothing. */
  netApyBps: bigint;
  performanceFeeBps: bigint;
  totalYieldHarvested: bigint;
  lastHarvestTime: bigint;
  depositCap: bigint;
  reserveBps: bigint;
  paused: boolean;

  /** Connected user */
  shares: bigint;
  positionValue: bigint;
  walletBalance: bigint;
  allowance: bigint;
  maxWithdraw: bigint;

  strategies: StrategyView[];
  refetch: () => void;
}

const EMPTY_STRATEGIES: StrategyView[] = [];

/**
 * Single source of truth for on-chain vault state.
 *
 * Every page reads from here rather than issuing its own calls, so the numbers on the
 * vault page and the portfolio page can never disagree — they come from one multicall in
 * one block. Polling is on a 12s interval, roughly a block, which is fast enough that
 * yield visibly ticks and slow enough not to hammer a public RPC.
 */
export function useVaultData(): VaultData {
  const chainId = useChainId();
  const { address: account } = useAccount();

  const vaultAddress = addressFor(chainId, "vault");
  const routerAddress = addressFor(chainId, "router");
  const assetAddress = addressFor(chainId, "asset");
  const deployment = deploymentFor(chainId);

  const configured = Boolean(vaultAddress && routerAddress && assetAddress);

  const vault = { address: vaultAddress ?? undefined, abi: vaultAbi } as const;
  const router = { address: routerAddress ?? undefined, abi: routerAbi } as const;
  const asset = { address: assetAddress ?? undefined, abi: erc20Abi } as const;

  const { data, isLoading, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...vault, functionName: "totalAssets" },
      { ...vault, functionName: "totalSupply" },
      { ...vault, functionName: "sharePrice" },
      { ...vault, functionName: "idleAssets" },
      { ...vault, functionName: "deployedAssets" },
      { ...vault, functionName: "availableLiquidity" },
      { ...vault, functionName: "performanceFeeBps" },
      { ...vault, functionName: "totalYieldHarvested" },
      { ...vault, functionName: "lastHarvestTime" },
      { ...vault, functionName: "depositCap" },
      { ...vault, functionName: "paused" },
      { ...vault, functionName: "symbol" },
      { ...vault, functionName: "decimals" },
      { ...router, functionName: "getStrategiesInfo" },
      { ...router, functionName: "weightedAPY" },
      { ...router, functionName: "totalAllocationBps" },
      { ...asset, functionName: "symbol" },
      { ...asset, functionName: "decimals" },
    ],
    query: {
      enabled: configured,
      refetchInterval: 12_000,
    },
  });

  const { data: userData, refetch: refetchUser } = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...vault, functionName: "balanceOf", args: [account ?? "0x0"] },
      { ...vault, functionName: "maxWithdraw", args: [account ?? "0x0"] },
      { ...asset, functionName: "balanceOf", args: [account ?? "0x0"] },
      { ...asset, functionName: "allowance", args: [account ?? "0x0", vaultAddress ?? "0x0"] },
    ],
    query: {
      enabled: configured && Boolean(account),
      refetchInterval: 12_000,
    },
  });

  return useMemo<VaultData>(() => {
    const read = <T,>(index: number, fallback: T): T => {
      const entry = data?.[index];
      return entry?.status === "success" ? (entry.result as T) : fallback;
    };
    const readUser = <T,>(index: number, fallback: T): T => {
      const entry = userData?.[index];
      return entry?.status === "success" ? (entry.result as T) : fallback;
    };

    const totalAssets = read<bigint>(0, 0n);
    const totalSupply = read<bigint>(1, 0n);
    const assetDecimals = Number(read<number>(17, 18));

    const info = read<
      readonly [
        readonly Address[],
        readonly string[],
        readonly bigint[],
        readonly bigint[],
        readonly bigint[],
        readonly bigint[],
        readonly boolean[],
      ]
    >(13, undefined as never);

    const strategies: StrategyView[] = info
      ? info[0]
          .map((adapter, i): StrategyView | null => {
            // Removed strategies leave a zero-address hole so ids stay stable.
            if (adapter === "0x0000000000000000000000000000000000000000") return null;

            const onChainName = info[1][i];
            const meta = metaFor(onChainName);
            const assets = info[4][i] ?? 0n;

            return {
              id: i,
              address: adapter,
              name: onChainName || `Strategy ${i}`,
              shortName: meta?.shortName ?? onChainName,
              risk: meta?.risk ?? "medium",
              swatch: meta?.swatch ?? "#8562ff",
              summary: meta?.summary ?? "",
              riskNote: meta?.riskNote ?? "",
              liquidity: meta?.liquidity ?? "Unknown",
              source: meta?.source ?? "Unknown",
              assets,
              targetBps: info[2][i] ?? 0n,
              actualBps: totalAssets > 0n ? (assets * 10_000n) / totalAssets : 0n,
              apyBps: info[5][i] ?? 0n,
              maxDeposit: info[3][i] ?? 0n,
              active: info[6][i] ?? false,
            };
          })
          .filter((s): s is StrategyView => s !== null)
      : EMPTY_STRATEGIES;

    const weightedApyBps = read<bigint>(14, 0n);
    const shares = readUser<bigint>(0, 0n);

    // The router's weighted APY covers deployed capital only. The idle buffer earns
    // nothing, so blending it in is the difference between the vault's advertised rate
    // and what a depositor actually receives.
    const netApyBps =
      totalAssets > 0n ? (weightedApyBps * read<bigint>(4, 0n)) / totalAssets : 0n;

    return {
      ready: configured && !isLoading,
      isLoading,
      mode: dataModeFor(chainId),
      chainId,

      vaultAddress,
      routerAddress,
      assetAddress,

      assetSymbol: read<string>(16, "RWA"),
      assetDecimals,
      shareSymbol: read<string>(11, "brRWA"),

      totalAssets,
      totalSupply,
      sharePrice: read<bigint>(2, 10n ** BigInt(assetDecimals)),
      idleAssets: read<bigint>(3, 0n),
      deployedAssets: read<bigint>(4, 0n),
      availableLiquidity: read<bigint>(5, 0n),
      weightedApyBps,
      netApyBps,
      performanceFeeBps: read<bigint>(6, 0n),
      totalYieldHarvested: read<bigint>(7, 0n),
      lastHarvestTime: read<bigint>(8, 0n),
      depositCap: read<bigint>(9, 0n),
      reserveBps: 10_000n - read<bigint>(15, 0n),
      paused: read<boolean>(10, false),

      shares,
      positionValue: totalSupply > 0n ? (shares * totalAssets) / totalSupply : 0n,
      walletBalance: readUser<bigint>(2, 0n),
      allowance: readUser<bigint>(3, 0n),
      maxWithdraw: readUser<bigint>(1, 0n),

      strategies,
      refetch: () => {
        void refetch();
        void refetchUser();
      },
    };
  }, [
    data,
    userData,
    chainId,
    configured,
    isLoading,
    vaultAddress,
    routerAddress,
    assetAddress,
    refetch,
    refetchUser,
  ]);
}

/** Allocation rows for the chart and legend, with the idle buffer appended. */
export function allocationRows(vault: VaultData) {
  const rows = vault.strategies.map((s) => ({
    key: s.name,
    label: s.shortName,
    value: s.assets,
    bps: s.actualBps,
    apyBps: s.apyBps,
    swatch: s.swatch,
    risk: s.risk as RiskLevel | null,
  }));

  rows.push({
    key: RESERVE_META.name,
    label: RESERVE_META.shortName,
    value: vault.idleAssets,
    bps: vault.totalAssets > 0n ? (vault.idleAssets * 10_000n) / vault.totalAssets : 0n,
    apyBps: 0n,
    swatch: RESERVE_META.swatch,
    risk: null,
  });

  return rows;
}

export { deploymentFor };
