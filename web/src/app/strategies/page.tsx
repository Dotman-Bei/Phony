"use client";

import { useChainId } from "wagmi";
import { ExternalLink } from "lucide-react";

import { MetricGrid, ModeBadge, Notice, RiskPill } from "@/components/primitives";
import { useVaultData } from "@/hooks/useVault";
import { explorerUrlFor } from "@/lib/chains";
import { RESERVE_META, riskClass } from "@/lib/strategyMeta";
import { formatBps, formatToken, shortenAddress } from "@/lib/format";

export default function StrategiesPage() {
  const chainId = useChainId();
  const vault = useVaultData();
  const decimals = vault.assetDecimals;

  return (
    <div className="wide section stack-24">
      <header>
        <span className="eyebrow">Strategy explorer</span>
        <h1 className="lit-heading" style={{ marginTop: 16 }}>
          Where the capital goes.
        </h1>
        <p className="lead prose" style={{ marginTop: 18 }}>
          Every adapter implements one interface, so the router treats a treasury product and
          an AMM position identically. What differs is risk and liquidity — stated below in
          the two terms that actually cost a depositor money.
        </p>
        <div style={{ marginTop: 22, display: "flex", gap: 10, alignItems: "center" }}>
          <ModeBadge mode={vault.mode} />
        </div>
      </header>

      {vault.mode === "demo" ? (
        <Notice tone="warn">
          APYs below are reported by mock yield sources on testnet. The T-bill leg derives
          its rate from realised share-price growth; the other two report their configured
          coupon. None of these are market rates.
        </Notice>
      ) : null}

      <MetricGrid
        columns={4}
        metrics={[
          {
            label: "Strategies live",
            value: String(vault.strategies.filter((s) => s.active).length),
            sub: `${vault.strategies.length} registered`,
          },
          {
            label: "Deployed capital",
            value: formatToken(vault.deployedAssets, decimals, 0),
            sub: vault.assetSymbol,
          },
          {
            label: "Weighted APY",
            value: formatBps(vault.weightedApyBps),
            sub: "on deployed capital",
          },
          {
            label: "Reserve buffer",
            value: formatBps(vault.reserveBps, 0),
            sub: `${formatToken(vault.idleAssets, decimals, 0)} idle`,
          },
        ]}
      />

      {vault.strategies.length === 0 ? (
        <div className="empty-state" data-note="No strategies registered">
          The router has no whitelisted adapters on this network yet.
        </div>
      ) : (
        <div className="stack-20">
          {vault.strategies.map((strategy) => (
            <article className="panel" key={strategy.address}>
              <header className="panel-header">
                <span className="panel-index">{String(strategy.id).padStart(2, "0")}</span>
                <h2>{strategy.name}</h2>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
                  <RiskPill risk={strategy.risk} />
                  {!strategy.active ? <span className="panel-state">Deactivated</span> : null}
                </div>
              </header>

              <div className="metric-grid metric-grid--flush">
                <div className="metric">
                  <span className="metric-label">Assets</span>
                  <span className="metric-value num">{formatToken(strategy.assets, decimals, 2)}</span>
                  <span className="metric-sub num">{vault.assetSymbol}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Estimated APY</span>
                  <span className="metric-value num">{formatBps(strategy.apyBps)}</span>
                  <span className="metric-sub num">annualised</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Allocation</span>
                  <span className="metric-value num">{formatBps(strategy.actualBps)}</span>
                  <span className="metric-sub num">{formatBps(strategy.targetBps, 0)} target</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Deposit cap</span>
                  <span className="metric-value num">
                    {strategy.maxDeposit === 0n ? "None" : formatToken(strategy.maxDeposit, decimals, 0)}
                  </span>
                  <span className="metric-sub num">
                    {strategy.maxDeposit === 0n ? "uncapped" : vault.assetSymbol}
                  </span>
                </div>
              </div>

              <div className="panel-body stack-16">
                <p style={{ fontSize: 15, lineHeight: "24px", color: "var(--text-secondary)" }}>
                  {strategy.summary}
                </p>

                <div className={`risk-banner ${riskClass(strategy.risk)}`}>
                  <div>
                    <strong>{strategy.riskNote.split(".")[0]}.</strong>
                    <p style={{ marginTop: 6 }}>
                      {strategy.riskNote.split(".").slice(1).join(".").trim()}
                    </p>
                  </div>
                </div>

                <dl className="stack-0">
                  <div className="quote-row">
                    <dt>Yield source</dt>
                    <dd>{strategy.source}</dd>
                  </div>
                  <div className="quote-row">
                    <dt>Exit liquidity</dt>
                    <dd>{strategy.liquidity}</dd>
                  </div>
                  <div className="quote-row">
                    <dt>Adapter</dt>
                    <dd>
                      <a
                        className="text-link"
                        href={explorerUrlFor(chainId, "address", strategy.address)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        {shortenAddress(strategy.address, 6)}
                        <ExternalLink size={10} strokeWidth={2.5} />
                      </a>
                    </dd>
                  </div>
                </dl>
              </div>
            </article>
          ))}

          <article className="panel">
            <header className="panel-header">
              <span className="panel-index">--</span>
              <h2>{RESERVE_META.name}</h2>
              <span className="panel-state">Not a strategy</span>
            </header>
            <div className="panel-body stack-12">
              <p style={{ fontSize: 15, lineHeight: "24px", color: "var(--text-secondary)" }}>
                {RESERVE_META.summary}
              </p>
              <dl className="stack-0">
                <div className="quote-row">
                  <dt>Idle</dt>
                  <dd className="num">
                    {formatToken(vault.idleAssets, decimals, 2)} {vault.assetSymbol}
                  </dd>
                </div>
                <div className="quote-row">
                  <dt>Share of NAV</dt>
                  <dd className="num">
                    {formatBps(
                      vault.totalAssets > 0n ? (vault.idleAssets * 10_000n) / vault.totalAssets : 0n,
                    )}
                  </dd>
                </div>
                <div className="quote-row">
                  <dt>Yield</dt>
                  <dd className="num">0.00% — earns nothing by design</dd>
                </div>
              </dl>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
