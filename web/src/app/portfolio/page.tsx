"use client";

import { useAccount, useChainId } from "wagmi";
import { ExternalLink } from "lucide-react";

import { MetricGrid, ModeBadge, Notice, Panel } from "@/components/primitives";
import { YieldChart } from "@/components/YieldChart";
import { useActivity } from "@/hooks/useActivity";
import { WalletButton } from "@/components/WalletButton";
import { useVaultData } from "@/hooks/useVault";
import { explorerUrlFor } from "@/lib/chains";
import {
  formatBps,
  formatDelta,
  formatSharePrice,
  formatTimestamp,
  formatToken,
  shortenHash,
} from "@/lib/format";

const KIND_LABEL = { deposit: "Deposit", withdraw: "Withdraw", harvest: "Harvest" } as const;

export default function PortfolioPage() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const vault = useVaultData();
  const activity = useActivity();

  const decimals = vault.assetDecimals;

  // Cost basis from this wallet's own deposit and withdraw events, so P&L is measured
  // against what was actually contributed rather than against a remembered number.
  const contributed = activity.entries
    .filter((e) => e.account?.toLowerCase() === address?.toLowerCase())
    .reduce((total, entry) => {
      if (entry.kind === "deposit") return total + entry.assets;
      if (entry.kind === "withdraw") return total - entry.assets;
      return total;
    }, 0n);

  const gain = vault.positionValue - (contributed > 0n ? contributed : 0n);

  return (
    <div className="wide section stack-24">
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <span className="eyebrow">Portfolio</span>
          <h1 style={{ marginTop: 14, fontSize: 44 }}>
            {isConnected ? "Your position" : "Vault activity"}
          </h1>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <ModeBadge mode={vault.mode} />
        </div>
      </header>

      {/* Everything below the personal metrics is public chain data. Gating the whole page
          behind a wallet would hide the vault's actual track record from exactly the
          people evaluating whether to deposit. Only the position row needs an address. */}
      {isConnected ? (
        <MetricGrid
          metrics={[
            {
              label: "Position value",
              value: `${formatToken(vault.positionValue, decimals, 2)}`,
              sub: `${vault.assetSymbol}`,
            },
            {
              label: "Shares held",
              value: formatToken(vault.shares, decimals, 2),
              sub: vault.shareSymbol,
            },
            {
              label: "Net contributed",
              value: contributed > 0n ? formatToken(contributed, decimals, 2) : "--",
              sub: contributed > 0n ? "deposits less withdrawals" : "no history in range",
            },
            {
              label: "Unrealised gain",
              value: contributed > 0n ? formatToken(gain, decimals, 4) : "--",
              sub:
                contributed > 0n
                  ? formatDelta(vault.positionValue, contributed)
                  : "needs a cost basis",
            },
          ]}
        />
      ) : (
        <div
          className="panel"
          style={{ display: "flex", alignItems: "center", gap: 20, padding: 22, flexWrap: "wrap" }}
        >
          <div>
            <span className="micro">Your position</span>
            <p style={{ marginTop: 8, fontSize: 15, color: "var(--muted)" }}>
              Connect a wallet for your share balance, cost basis, and unrealised gain. The
              vault-wide history below is public and needs no connection.
            </p>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <WalletButton />
          </div>
        </div>
      )}

      <div className="split-wide">
        <Panel index="01" title="Realised yield" state="From Harvested events">
          <div className="panel-body">
            <YieldChart
              series={activity.yieldSeries}
              decimals={decimals}
              symbol={vault.assetSymbol}
              unavailable={activity.unavailable}
            />
          </div>
        </Panel>

        <Panel index="02" title="Effective rate" state="Live">
          <div className="panel-body stack-16">
            <dl className="stack-0">
              <div className="quote-row">
                <dt>Vault blended APY</dt>
                <dd className="num">{formatBps(vault.netApyBps)}</dd>
              </div>
              <div className="quote-row">
                <dt>On deployed capital</dt>
                <dd className="num">{formatBps(vault.weightedApyBps)}</dd>
              </div>
              <div className="quote-row">
                <dt>Idle drag</dt>
                <dd className="num">-{formatBps(vault.weightedApyBps - vault.netApyBps)}</dd>
              </div>
              <div className="quote-row">
                <dt>Performance fee</dt>
                <dd className="num">{formatBps(vault.performanceFeeBps, 0)} of yield</dd>
              </div>
              <div className="quote-row">
                <dt>Share price</dt>
                <dd className="num">{formatSharePrice(vault.sharePrice, decimals)}</dd>
              </div>
            </dl>

            <p style={{ fontSize: 13, lineHeight: "21px", color: "var(--faint)" }}>
              Holding {vault.assetSymbol} in a wallet earns nothing at all. The blended figure is
              what the vault currently pays after the idle reserve&apos;s drag, before the
              performance fee is taken on harvest.
            </p>
          </div>
        </Panel>
      </div>

      <Panel
        index="03"
        title="Transaction history"
        state={activity.isLoading ? "Loading" : `${activity.entries.length} events`}
      >
        {activity.unavailable ? (
          <div className="panel-body">
            <Notice tone="warn">
              This RPC endpoint declined the log range needed to rebuild history. Live vault
              figures above are unaffected.
            </Notice>
          </div>
        ) : activity.entries.length === 0 ? (
          <div className="panel-body">
            <div className="empty-state" data-note="No events in range">
              No vault events found in the last {process.env.NEXT_PUBLIC_LOG_LOOKBACK_BLOCKS || "100,000"}{" "}
              blocks.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Amount</th>
                  <th>Shares</th>
                  <th>Account</th>
                  <th>Time</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {activity.entries.slice(0, 40).map((entry) => (
                  <tr key={`${entry.hash}-${entry.kind}-${entry.blockNumber}`}>
                    <td>{KIND_LABEL[entry.kind]}</td>
                    <td className="num">
                      {formatToken(entry.assets, decimals, 4)} {vault.assetSymbol}
                    </td>
                    <td className="num">
                      {entry.kind === "harvest" ? "--" : formatToken(entry.shares, decimals, 4)}
                    </td>
                    <td>
                      {entry.account
                        ? isConnected && entry.account.toLowerCase() === address?.toLowerCase()
                          ? "You"
                          : `${entry.account.slice(0, 6)}…${entry.account.slice(-4)}`
                        : "Keeper"}
                    </td>
                    <td className="num">
                      {entry.timestamp > 0n ? formatTimestamp(entry.timestamp) : `#${entry.blockNumber}`}
                    </td>
                    <td>
                      <a
                        className="text-link"
                        href={explorerUrlFor(chainId, "tx", entry.hash)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        {shortenHash(entry.hash)}
                        <ExternalLink size={10} strokeWidth={2.5} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
