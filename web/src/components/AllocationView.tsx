"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { allocationRows, type VaultData } from "@/hooks/useVault";
import { formatBps, formatToken } from "@/lib/format";
import { RESERVE_META } from "@/lib/strategyMeta";

/**
 * Current allocation: donut plus a hairline legend.
 *
 * Segments are shaded in the structural violet ramp, never in the risk colours. An
 * allocation is not a verdict — colouring the largest slice green would imply the vault
 * endorses it, and the risk ratings on the strategy page are where that claim belongs.
 */
export function AllocationView({ vault }: { vault: VaultData }) {
  // The reserve stays listed even at zero. A depositor comparing it against the target in
  // the panel header needs to see that it is drained, and a row that disappears when it
  // hits zero is exactly the row you wanted to see.
  const rows = allocationRows(vault).filter(
    (row) => row.value > 0n || row.bps > 0n || row.key === RESERVE_META.name,
  );
  const decimals = vault.assetDecimals;

  if (vault.totalAssets === 0n) {
    return (
      <div className="panel-body">
        <div className="empty-state" data-note="No capital deployed">
          The vault holds nothing yet. Allocation appears once the first deposit is routed.
        </div>
      </div>
    );
  }

  const chartData = rows.map((row) => ({
    name: row.label,
    // Recharts cannot size a segment from a bigint, so basis points become the unit.
    value: Number(row.bps),
    swatch: row.swatch,
  }));

  return (
    <div className="panel-body">
      <div className="split" style={{ gap: 28, alignItems: "center" }}>
        <div className="chart-frame" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="94%"
                paddingAngle={2}
                stroke="none"
                isAnimationActive={false}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.name} fill={entry.swatch} />
                ))}
              </Pie>
              <Tooltip
                cursor={false}
                contentStyle={{
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                }}
                itemStyle={{ color: "var(--text)" }}
                formatter={(value: number, name: string) => [`${(value / 100).toFixed(2)}%`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="alloc-list">
          {rows.map((row) => (
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

              <span className="alloc-meta num">
                {formatToken(row.value, decimals, 2)} {vault.assetSymbol}
                {" · "}
                {row.apyBps > 0n ? `${formatBps(row.apyBps)} APY` : "0.00% APY"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
