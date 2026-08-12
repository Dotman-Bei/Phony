"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { maxUint256 } from "viem";

import { addressFor, erc20Abi, vaultAbi } from "@/lib/contracts";

/**
 * Write path for the vault: approve, deposit, withdraw, harvest.
 *
 * Every action funnels through one state machine so the UI has a single, honest notion of
 * "what is happening right now". `phase` distinguishes waiting-on-the-wallet from
 * waiting-on-the-chain, because those are different experiences and collapsing them into
 * one spinner is what makes a dapp feel broken.
 */

export type TxPhase = "idle" | "signing" | "pending" | "success" | "error";
export type TxAction = "approve" | "deposit" | "withdraw" | "redeem" | "harvest" | null;

export interface VaultActions {
  phase: TxPhase;
  action: TxAction;
  hash: `0x${string}` | undefined;
  error: string | null;
  isBusy: boolean;

  approve: (amount?: bigint) => Promise<void>;
  deposit: (assets: bigint) => Promise<void>;
  withdraw: (assets: bigint) => Promise<void>;
  redeem: (shares: bigint) => Promise<void>;
  harvest: () => Promise<void>;
  reset: () => void;
}

/** Wallet rejections and revert reasons arrive as prose walls; keep the first line. */
function readableError(error: unknown): string {
  if (!(error instanceof Error)) return "Transaction failed.";

  const message = error.message;
  if (/user rejected|denied transaction/i.test(message)) return "Transaction rejected in wallet.";
  if (/insufficient funds/i.test(message)) return "Not enough BOT to cover gas.";

  const custom = message.match(/reverted with (?:the following reason|custom error)[:\s]+'?([^'\n]+)/i);
  if (custom) return custom[1].trim();

  return message.split("\n")[0].slice(0, 160);
}

export function useVaultActions(onConfirmed?: () => void): VaultActions {
  const chainId = useChainId();
  const { address: account } = useAccount();

  const vaultAddress = addressFor(chainId, "vault");
  const assetAddress = addressFor(chainId, "asset");

  const [action, setAction] = useState<TxAction>(null);
  const [error, setError] = useState<string | null>(null);
  const { writeContractAsync, data: hash, reset: resetWrite } = useWriteContract();

  const { isLoading: isConfirming, isSuccess, isError: receiptFailed } = useWaitForTransactionReceipt({
    hash,
  });

  const [phase, setPhase] = useState<TxPhase>("idle");

  useEffect(() => {
    if (!hash) return;
    if (isConfirming) setPhase("pending");
    else if (isSuccess) setPhase("success");
    else if (receiptFailed) {
      setPhase("error");
      setError("Transaction reverted on chain.");
    }
  }, [hash, isConfirming, isSuccess, receiptFailed]);

  useEffect(() => {
    if (phase !== "success") return;
    onConfirmed?.();
    // Hold the confirmation visible briefly, then return the button to rest.
    const timer = setTimeout(() => {
      setPhase("idle");
      setAction(null);
      resetWrite();
    }, 3_500);
    return () => clearTimeout(timer);
  }, [phase, onConfirmed, resetWrite]);

  const run = useCallback(
    async (next: TxAction, execute: () => Promise<`0x${string}`>) => {
      setAction(next);
      setError(null);
      setPhase("signing");
      try {
        await execute();
      } catch (caught) {
        setError(readableError(caught));
        setPhase("error");
      }
    },
    [],
  );

  const approve = useCallback(
    async (amount?: bigint) => {
      if (!assetAddress || !vaultAddress) return;
      await run("approve", () =>
        writeContractAsync({
          address: assetAddress,
          abi: erc20Abi,
          functionName: "approve",
          // Default to an unlimited allowance so depositing is one signature, not two on
          // every visit. A bounded amount can be passed for users who prefer it.
          args: [vaultAddress, amount ?? maxUint256],
        }),
      );
    },
    [assetAddress, vaultAddress, run, writeContractAsync],
  );

  const deposit = useCallback(
    async (assets: bigint) => {
      if (!vaultAddress || !account) return;
      await run("deposit", () =>
        writeContractAsync({
          address: vaultAddress,
          abi: vaultAbi,
          functionName: "deposit",
          args: [assets, account],
        }),
      );
    },
    [vaultAddress, account, run, writeContractAsync],
  );

  const withdraw = useCallback(
    async (assets: bigint) => {
      if (!vaultAddress || !account) return;
      await run("withdraw", () =>
        writeContractAsync({
          address: vaultAddress,
          abi: vaultAbi,
          functionName: "withdraw",
          args: [assets, account, account],
        }),
      );
    },
    [vaultAddress, account, run, writeContractAsync],
  );

  const redeem = useCallback(
    async (shares: bigint) => {
      if (!vaultAddress || !account) return;
      await run("redeem", () =>
        writeContractAsync({
          address: vaultAddress,
          abi: vaultAbi,
          functionName: "redeem",
          args: [shares, account, account],
        }),
      );
    },
    [vaultAddress, account, run, writeContractAsync],
  );

  const harvest = useCallback(async () => {
    if (!vaultAddress) return;
    await run("harvest", () =>
      writeContractAsync({ address: vaultAddress, abi: vaultAbi, functionName: "harvest" }),
    );
  }, [vaultAddress, run, writeContractAsync]);


  const reset = useCallback(() => {
    setPhase("idle");
    setAction(null);
    setError(null);
    resetWrite();
  }, [resetWrite]);

  return {
    phase,
    action,
    hash,
    error,
    isBusy: phase === "signing" || phase === "pending",
    approve,
    deposit,
    withdraw,
    redeem,
    harvest,
    reset,
  };
}
