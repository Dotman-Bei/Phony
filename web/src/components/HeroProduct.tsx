"use client";

import Link from "next/link";

import { allocationRows, useVaultData } from "@/hooks/useVault";
import { formatBps, formatCompact, formatSharePrice, formatToken } from "@/lib/format";
import { ModeBadge } from "./primitives";

/**
 * The product surface that rises out of the hero bloom.
 *
 * It shows the real vault, not a screenshot. Before a deployment exists on the selected
 * chain it renders the same layout with dashes and an explicit "not deployed" badge —
 * which is more useful than a mock, and is the only version of this panel that stays true
 * after the numbers change.
 */
export function HeroProduct() {
  const vault = useVaultData();
  const decimals = vault.assetDecimals;
  const configured = vault.mode !== "unconfigured";

  const rows = allocationRows(vault).filter((row) => row.bps > 0n);

  return (
    <div className="hero-product">
      <header className="panel-header">
        <span className="panel-index">01</span>
        <h2>Vault overview</h2>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <ModeBadge mode={vault.mode} />
        </div>
      </header>

      <div className="metric-grid metric-grid--flush">
        <div className="metric">
          <span className="metric-label">Total value locked</span>
          <span className="metric-value num">
            {configured ? formatCompact(vault.totalAssets, decimals) : "--"}
          </span>
          <span className="metric-sub num">{vault.assetSymbol}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Net blended APY</span>
          <span className="metric-value num">{configured ? formatBps(vault.netApyBps) : "--"}</span>
          <span className="metric-sub num">{formatBps(vault.weightedApyBps)} deployed</span>
        </div>
        <div className="metric">
          <span className="metric-label">Share price</span>
          <span className="metric-value num">
            {configured ? formatSharePrice(vault.sharePrice, decimals) : "--"}
          </span>
          <span className="metric-sub num">
            1 {vault.shareSymbol} / {vault.assetSymbol}
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">Lifetime yield</span>
          <span className="metric-value num">
            {configured ? formatToken(vault.totalYieldHarvested, decimals, 2) : "--"}
          </span>
          <span className="metric-sub num">net of fees</span>
        </div>
      </div>

      <div className="panel-body" style={{ paddingBottom: 34 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
          <span className="micro">Current allocation</span>
          <Link className="micro" href="/strategies" style={{ color: "var(--structure-pale)" }}>
            All strategies
          </Link>
        </div>

        <div className="alloc-list" style={{ marginTop: 18 }}>
          {rows.length > 0 ? (
            rows.map((row) => (
              <div className="alloc-row" key={row.key}>
                <span className="alloc-name">
                  <span className="alloc-swatch" style={{ background: row.swatch }} aria-hidden="true" />
                  {row.label}
                </span>
                <span className="alloc-value num">{formatBps(row.bps)}</span>
                <span className="alloc-track">
                  <span
                    className="alloc-fill"
                    style={{ width: `${Number(row.bps) / 100}%`, background: row.swatch }}
                  />
                </span>
              </div>
            ))
          ) : (
            <span className="micro" style={{ color: "var(--faint)" }}>
              Allocation appears once the vault holds capital
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
