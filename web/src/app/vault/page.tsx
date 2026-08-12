"use client";

import { useAccount, useChainId } from "wagmi";
import { Droplet, RefreshCw } from "lucide-react";

import { AllocationView } from "@/components/AllocationView";
import { VaultActionPanel } from "@/components/VaultActionPanel";
import { MetricGrid, ModeBadge, Notice, Panel } from "@/components/primitives";
import { useVaultData } from "@/hooks/useVault";
import { useVaultActions } from "@/hooks/useVaultActions";
import { deploymentFor } from "@/lib/contracts";
import { explorerUrlFor } from "@/lib/chains";
import {
  formatBps,
  formatCompact,
  formatRelativeTime,
  formatSharePrice,
  formatToken,
  shortenAddress,
} from "@/lib/format";

export default function VaultPage() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const vault = useVaultData();
  const actions = useVaultActions(() => vault.refetch());

  const decimals = vault.assetDecimals;
  const deployment = deploymentFor(chainId);

  if (!deployment) {
    return (
      <div className="wide section">
        <span className="eyebrow">Vault</span>
        <h1 className="lit-heading" style={{ marginTop: 18 }}>
          No deployment on this network.
        </h1>
        <p className="lead prose" style={{ marginTop: 18 }}>
          Phony is not deployed on the chain your wallet is connected to. Switch to BOT
          Chain Testnet using the network selector in the header.
        </p>
        <div style={{ marginTop: 28 }}>
          <ModeBadge mode="unconfigured" />
        </div>
      </div>
    );
  }

  return (
    <div className="wide section stack-20">
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <span className="eyebrow">Vault</span>
          <h1 style={{ marginTop: 14, fontSize: 44 }}>{vault.shareSymbol}</h1>
          <p className="meta" style={{ marginTop: 10 }}>
            {vault.assetSymbol} · {shortenAddress(vault.vaultAddress ?? undefined, 6)}
          </p>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <ModeBadge mode={vault.mode} />
          <a
            className="ghost-action"
            href={explorerUrlFor(chainId, "address", vault.vaultAddress ?? "")}
            target="_blank"
            rel="noreferrer"
          >
            Explorer
          </a>
        </div>
      </header>

      {vault.mode === "demo" ? (
        <Notice tone="warn">
          This deployment routes into mock yield sources. Transactions, share accounting, and
          NAV are real; the coupons are simulated. Rates shown here are not market rates.
        </Notice>
      ) : null}

      <MetricGrid
        metrics={[
          {
            label: "Total value locked",
            value: `${formatCompact(vault.totalAssets, decimals)} ${vault.assetSymbol}`,
            sub: `${formatToken(vault.deployedAssets, decimals, 0)} deployed`,
          },
          {
            label: "Net blended APY",
            value: formatBps(vault.netApyBps),
            sub: `${formatBps(vault.weightedApyBps)} on deployed capital`,
          },
          {
            label: "Your position",
            value: isConnected ? `${formatToken(vault.positionValue, decimals, 2)}` : "--",
            sub: isConnected ? `${formatToken(vault.shares, decimals, 2)} ${vault.shareSymbol}` : "not connected",
          },
          {
            label: "Share price",
            value: formatSharePrice(vault.sharePrice, decimals),
            sub: `1 ${vault.shareSymbol} / ${vault.assetSymbol}`,
          },
        ]}
      />

      <div className="split-wide">
        <div className="stack-20">
          <Panel index="01" title="Current allocation" state={`Reserve target ${formatBps(vault.reserveBps, 0)}`}>
            <AllocationView vault={vault} />
          </Panel>

          <Panel
            index="02"
            title="Compounding"
            action={
              <button
                type="button"
                className="ghost-action"
                onClick={() => actions.harvest()}
                disabled={actions.isBusy || vault.paused}
                title="Harvest is permissionless. The keeper runs it on a schedule; anyone may trigger it."
              >
                {actions.isBusy && actions.action === "harvest" ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <RefreshCw size={13} strokeWidth={2} />
                )}
                Harvest now
              </button>
            }
          >
            <div className="metric-grid metric-grid--3 metric-grid--flush">
              <div className="metric">
                <span className="metric-label">Lifetime yield</span>
                <span className="metric-value metric-value--sm num">
                  {formatToken(vault.totalYieldHarvested, decimals, 4)}
                </span>
                <span className="metric-sub num">net of fees</span>
              </div>
              <div className="metric">
                <span className="metric-label">Last harvest</span>
                <span className="metric-value metric-value--sm num">
                  {formatRelativeTime(vault.lastHarvestTime)}
                </span>
                <span className="metric-sub num">keeper cadence</span>
              </div>
              <div className="metric">
                <span className="metric-label">Performance fee</span>
                <span className="metric-value metric-value--sm num">
                  {formatBps(vault.performanceFeeBps, 0)}
                </span>
                <span className="metric-sub num">on yield only</span>
              </div>
            </div>

            <div className="panel-body">
              <p style={{ fontSize: 14, lineHeight: "22px", color: "var(--muted)" }}>
                Harvested yield is transferred into the vault while share supply stays fixed,
                so the share price rises and every holder compounds without acting. Calling
                harvest costs gas and pays the caller nothing — it is a public good the keeper
                bot funds.
              </p>
            </div>
          </Panel>
        </div>

        <div className="stack-20">
          <Panel index="03" title="Deposit & withdraw" state={vault.paused ? "Paused" : "Open"}>
            <VaultActionPanel vault={vault} />
          </Panel>

          <Panel index="04" title="Liquidity" state="Live">
            <div className="panel-body stack-12">
              <dl className="stack-0">
                <div className="quote-row">
                  <dt>Idle reserve</dt>
                  <dd className="num">{formatToken(vault.idleAssets, decimals, 2)}</dd>
                </div>
                <div className="quote-row">
                  <dt>Exitable this block</dt>
                  <dd className="num">{formatToken(vault.availableLiquidity, decimals, 2)}</dd>
                </div>
                <div className="quote-row">
                  <dt>Deposit cap</dt>
                  <dd className="num">
                    {vault.depositCap === 0n ? "Uncapped" : formatToken(vault.depositCap, decimals, 0)}
                  </dd>
                </div>
              </dl>

              <p style={{ fontSize: 13, lineHeight: "21px", color: "var(--faint)" }}>
                The reserve is whatever the curator leaves unallocated. Withdrawals inside it
                cost one transfer; larger exits unwind strategies proportionally.
              </p>
            </div>
          </Panel>

          {vault.mode === "demo" && isConnected ? (
            <Panel index="05" title="Test tokens" state="Testnet">
              <div className="panel-body stack-12">
                <p style={{ fontSize: 13, lineHeight: "21px", color: "var(--muted)" }}>
                  Claim {vault.assetSymbol} to run the full loop. Rate limited per address.
                </p>
                <button
                  type="button"
                  className="ghost-action"
                  onClick={() => actions.faucet()}
                  disabled={actions.isBusy}
                >
                  {actions.isBusy && actions.action === "faucet" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <Droplet size={13} strokeWidth={2} />
                  )}
                  Claim {vault.assetSymbol}
                </button>
                {actions.error && actions.action === "faucet" ? (
                  <Notice tone="error">{actions.error}</Notice>
                ) : null}
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
