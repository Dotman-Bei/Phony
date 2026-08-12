"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ExternalLink } from "lucide-react";

import { useVaultActions } from "@/hooks/useVaultActions";
import type { VaultData } from "@/hooks/useVault";
import { explorerUrlFor } from "@/lib/chains";
import { formatSharePrice, formatToken, parseAmount, toInputValue } from "@/lib/format";
import { Notice } from "./primitives";

type Tab = "deposit" | "withdraw";

/**
 * Deposit and withdraw.
 *
 * The panel's job is to make the outcome of a signature predictable before it is signed:
 * every quote below the input is derived from the same NAV the contract will use, and the
 * withdraw side is bounded by `maxWithdraw` rather than by the user's balance — RWA
 * strategies have notice periods, so the honest maximum is what the vault can actually
 * free this block, not what the shares are nominally worth.
 */
export function VaultActionPanel({ vault }: { vault: VaultData }) {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>("deposit");
  const [input, setInput] = useState("");

  const actions = useVaultActions(() => {
    setInput("");
    vault.refetch();
  });

  const decimals = vault.assetDecimals;
  const parsed = useMemo(() => parseAmount(input, decimals), [input, decimals]);

  const isDeposit = tab === "deposit";
  const ceiling = isDeposit ? vault.walletBalance : vault.maxWithdraw;

  const needsApproval = isDeposit && parsed !== null && parsed > vault.allowance;
  const overCeiling = parsed !== null && parsed > ceiling;
  const hasAmount = parsed !== null && parsed > 0n;

  // Quotes come from share price rather than a preview call: one multicall already gave us
  // the NAV, and a per-keystroke `previewDeposit` would be an RPC round-trip per character
  // for an answer that is arithmetically identical.
  const unit = 10n ** BigInt(decimals);
  const estimatedShares =
    hasAmount && vault.sharePrice > 0n ? (parsed * unit) / vault.sharePrice : 0n;
  const estimatedAssets = hasAmount ? (parsed * vault.sharePrice) / unit : 0n;

  const positionAfter = isDeposit
    ? vault.positionValue + (parsed ?? 0n)
    : vault.positionValue > (parsed ?? 0n)
      ? vault.positionValue - (parsed ?? 0n)
      : 0n;

  const submit = async () => {
    if (!parsed || parsed === 0n) return;
    if (isDeposit) {
      if (needsApproval) await actions.approve();
      else await actions.deposit(parsed);
    } else {
      // Redeem the exact share balance when exiting in full, so dust cannot be left behind
      // by a share-price tick between quoting and signing.
      if (parsed >= vault.maxWithdraw && vault.maxWithdraw >= vault.positionValue) {
        await actions.redeem(vault.shares);
      } else {
        await actions.withdraw(parsed);
      }
    }
  };

  const buttonLabel = () => {
    if (actions.phase === "signing") return "Confirm in wallet";
    if (actions.phase === "pending") return "Submitting";
    if (actions.phase === "success") return "Confirmed";
    if (!hasAmount) return isDeposit ? "Enter an amount" : "Enter an amount";
    if (overCeiling) return "Amount exceeds maximum";
    if (needsApproval) return `Approve ${vault.assetSymbol}`;
    return isDeposit ? "Deposit & restake" : "Withdraw";
  };

  const disabled =
    !isConnected || vault.paused || actions.isBusy || !hasAmount || overCeiling || actions.phase === "success";

  return (
    <div className="panel-body stack-20">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="tabs" role="tablist" aria-label="Vault action">
          {(["deposit", "withdraw"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className="tab"
              data-active={tab === value}
              onClick={() => {
                setTab(value);
                setInput("");
                actions.reset();
              }}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field-label">
          <span className="micro">
            {isDeposit ? `Amount in ${vault.assetSymbol}` : `Amount in ${vault.assetSymbol}`}
          </span>
          <span className="micro num" style={{ color: "var(--muted)" }}>
            {isDeposit ? "Wallet" : "Withdrawable"} {formatToken(ceiling, decimals, 4)}{" "}
            {vault.assetSymbol}
          </span>
        </span>

        <span className="amount-row">
          <input
            className="control num"
            inputMode="decimal"
            placeholder="0.00"
            value={input}
            onChange={(event) => setInput(event.target.value.replace(/[^\d.]/g, ""))}
            aria-label={`Amount to ${tab}`}
          />
          <button type="button" className="max-button" onClick={() => setInput(toInputValue(ceiling, decimals))}>
            Max
          </button>
        </span>
      </label>

      <dl className="stack-0">
        {isDeposit ? (
          <div className="quote-row">
            <dt>You receive</dt>
            <dd className="num">
              ~{formatToken(estimatedShares, decimals, 4)} {vault.shareSymbol}
            </dd>
          </div>
        ) : (
          <div className="quote-row">
            <dt>Shares burned</dt>
            <dd className="num">
              ~{formatToken(estimatedShares, decimals, 4)} {vault.shareSymbol}
            </dd>
          </div>
        )}

        <div className="quote-row">
          <dt>Share price</dt>
          <dd className="num">
            1 {vault.shareSymbol} = {formatSharePrice(vault.sharePrice, decimals)} {vault.assetSymbol}
          </dd>
        </div>

        <div className="quote-row">
          <dt>Position after</dt>
          <dd className="num">
            {formatToken(positionAfter, decimals, 2)} {vault.assetSymbol}
          </dd>
        </div>

        <div className="quote-row">
          <dt>Performance fee</dt>
          <dd className="num">{Number(vault.performanceFeeBps) / 100}% of yield</dd>
        </div>
      </dl>

      {vault.paused ? (
        <Notice tone="warn">
          The vault is paused. Deposits and withdrawals are closed until the curator
          unpauses; deployed capital is unaffected and NAV continues to be reported.
        </Notice>
      ) : null}

      {!isDeposit && vault.maxWithdraw < vault.positionValue && vault.positionValue > 0n ? (
        <Notice tone="warn">
          {formatToken(vault.positionValue - vault.maxWithdraw, decimals, 2)} {vault.assetSymbol} of
          your position is in strategies that cannot be recalled this block — private credit
          principal is out on loan. It becomes withdrawable as borrowers repay.
        </Notice>
      ) : null}

      {overCeiling ? (
        <Notice tone="error">
          Maximum is {formatToken(ceiling, decimals, 4)} {vault.assetSymbol}.
        </Notice>
      ) : null}

      {actions.error ? <Notice tone="error">{actions.error}</Notice> : null}

      {isConnected ? (
        <button type="button" className="primary-action primary-action--block" disabled={disabled} onClick={submit}>
          {actions.isBusy ? <span className="spinner" aria-hidden="true" /> : null}
          {buttonLabel()}
        </button>
      ) : (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <ConnectButton label="Connect wallet to deposit" showBalance={false} />
        </div>
      )}

      {actions.hash ? (
        <a
          className="micro"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--structure-pale)" }}
          href={explorerUrlFor(chainId, "tx", actions.hash)}
          target="_blank"
          rel="noreferrer"
        >
          View on explorer <ExternalLink size={10} strokeWidth={2.5} />
        </a>
      ) : null}
    </div>
  );
}
