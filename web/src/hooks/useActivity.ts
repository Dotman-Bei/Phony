"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { parseAbiItem, type Address, type Log } from "viem";

import { addressFor } from "@/lib/contracts";

/**
 * Transaction history and yield series, read from chain logs.
 *
 * Everything on the portfolio page comes from events the vault actually emitted. There is
 * no synthetic series and no seeded demo history — an empty vault renders an empty state
 * that says so, which is the honest alternative to placeholder analytics.
 *
 * Public RPCs commonly cap `eth_getLogs` ranges, so the lookback is bounded and the query
 * degrades to "history unavailable" rather than throwing.
 */

const LOOKBACK_BLOCKS = BigInt(process.env.NEXT_PUBLIC_LOG_LOOKBACK_BLOCKS || 100_000);

const depositEvent = parseAbiItem(
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
);
const withdrawEvent = parseAbiItem(
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
);
const harvestEvent = parseAbiItem("event Harvested(uint256 amount, uint256 fee, uint256 timestamp)");

export type ActivityKind = "deposit" | "withdraw" | "harvest";

export interface ActivityEntry {
  kind: ActivityKind;
  hash: string;
  blockNumber: bigint;
  /** Asset amount moved. For a harvest this is gross yield, before the fee. */
  assets: bigint;
  shares: bigint;
  fee: bigint;
  account: Address | null;
  timestamp: bigint;
}

export interface YieldPoint {
  timestamp: number;
  /** Cumulative yield harvested, net of the performance fee, in asset base units. */
  cumulative: string;
  amount: string;
}

export interface ActivityData {
  entries: ActivityEntry[];
  userEntries: ActivityEntry[];
  yieldSeries: YieldPoint[];
  isLoading: boolean;
  unavailable: boolean;
  refetch: () => void;
}

function blockTimestampOf(log: Log & { args?: unknown }): bigint {
  const args = log.args as { timestamp?: bigint } | undefined;
  return args?.timestamp ?? 0n;
}

export function useActivity(): ActivityData {
  const chainId = useChainId();
  const client = usePublicClient();
  const { address: account } = useAccount();
  const vaultAddress = addressFor(chainId, "vault");

  const query = useQuery({
    queryKey: ["activity", chainId, vaultAddress],
    enabled: Boolean(client && vaultAddress),
    refetchInterval: 30_000,
    queryFn: async (): Promise<ActivityEntry[]> => {
      if (!client || !vaultAddress) return [];

      const latest = await client.getBlockNumber();
      const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

      const [deposits, withdrawals, harvests] = await Promise.all([
        client.getLogs({ address: vaultAddress, event: depositEvent, fromBlock, toBlock: latest }),
        client.getLogs({ address: vaultAddress, event: withdrawEvent, fromBlock, toBlock: latest }),
        client.getLogs({ address: vaultAddress, event: harvestEvent, fromBlock, toBlock: latest }),
      ]);

      // Deposit/Withdraw carry no timestamp, so their blocks are fetched. Blocks are
      // deduplicated first — a busy vault emits many events per block and fetching each
      // one separately is how a history view quietly becomes a hundred RPC calls.
      const needed = new Set<bigint>();
      for (const log of [...deposits, ...withdrawals]) {
        if (log.blockNumber !== null) needed.add(log.blockNumber);
      }

      const blockTimes = new Map<bigint, bigint>();
      await Promise.all(
        [...needed].map(async (blockNumber) => {
          try {
            const block = await client.getBlock({ blockNumber });
            blockTimes.set(blockNumber, block.timestamp);
          } catch {
            blockTimes.set(blockNumber, 0n);
          }
        }),
      );

      const entries: ActivityEntry[] = [
        ...deposits.map((log): ActivityEntry => ({
          kind: "deposit",
          hash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? 0n,
          assets: log.args.assets ?? 0n,
          shares: log.args.shares ?? 0n,
          fee: 0n,
          account: (log.args.owner as Address) ?? null,
          timestamp: blockTimes.get(log.blockNumber ?? 0n) ?? 0n,
        })),
        ...withdrawals.map((log): ActivityEntry => ({
          kind: "withdraw",
          hash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? 0n,
          assets: log.args.assets ?? 0n,
          shares: log.args.shares ?? 0n,
          fee: 0n,
          account: (log.args.owner as Address) ?? null,
          timestamp: blockTimes.get(log.blockNumber ?? 0n) ?? 0n,
        })),
        ...harvests.map((log): ActivityEntry => ({
          kind: "harvest",
          hash: log.transactionHash ?? "",
          blockNumber: log.blockNumber ?? 0n,
          assets: log.args.amount ?? 0n,
          shares: 0n,
          fee: log.args.fee ?? 0n,
          account: null,
          timestamp: blockTimestampOf(log),
        })),
      ];

      return entries.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    },
  });

  const entries = query.data ?? [];

  const userEntries = account
    ? entries.filter(
        (entry) => entry.account?.toLowerCase() === account.toLowerCase() || entry.kind === "harvest",
      )
    : [];

  // Cumulative net yield over time, oldest first — the shape the area chart wants.
  const yieldSeries: YieldPoint[] = [];
  let running = 0n;
  for (const entry of entries.filter((e) => e.kind === "harvest").reverse()) {
    running += entry.assets - entry.fee;
    yieldSeries.push({
      timestamp: Number(entry.timestamp),
      cumulative: running.toString(),
      amount: (entry.assets - entry.fee).toString(),
    });
  }

  return {
    entries,
    userEntries,
    yieldSeries,
    isLoading: query.isLoading,
    unavailable: query.isError,
    refetch: () => void query.refetch(),
  };
}
