"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUnits } from "viem";

import type { YieldPoint } from "@/hooks/useActivity";
import { EmptyState } from "./primitives";

/**
 * Cumulative harvested yield over time.
 *
 * Plotted from `Harvested` events only. A vault that has never harvested renders the empty
 * state rather than a flat synthetic line — a chart that shows a trend the chain does not
 * contain is worse than no chart.
 */
export function YieldChart({
  series,
  decimals,
  symbol,
  unavailable,
}: {
  series: YieldPoint[];
  decimals: number;
  symbol: string;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <EmptyState note="History unavailable">
        This RPC endpoint declined the log range needed to rebuild harvest history. The vault
        itself is unaffected — every figure above is a live contract read.
      </EmptyState>
    );
  }

  if (series.length === 0) {
    return (
      <EmptyState note="No harvest recorded">
        No harvest has been recorded yet. Yield still accrues inside the strategies and is
        already reflected in the share price; this chart plots realised harvests only.
      </EmptyState>
    );
  }

  const data = series.map((point) => ({
    timestamp: point.timestamp,
    label: new Date(point.timestamp * 1000).toISOString().slice(5, 10),
    cumulative: Number(formatUnits(BigInt(point.cumulative), decimals)),
  }));

  return (
    <div className="chart-frame">
      <ResponsiveContainer width="100%" height="100%">
        {/* Right margin leaves room for the final point and its x-label; at 8px the most
            recent harvest — the one anybody actually looks at — clips against the edge. */}
        <AreaChart data={data} margin={{ top: 8, right: 22, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="yieldFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8562ff" stopOpacity={0.42} />
              <stop offset="100%" stopColor="#8562ff" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={54}
            tickFormatter={(value: number) => value.toFixed(2)}
          />
          <Tooltip
            cursor={{ stroke: "rgba(183,164,251,0.35)" }}
            contentStyle={{
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              fontFamily: "var(--mono)",
              fontSize: 11,
            }}
            labelStyle={{ color: "var(--faint)" }}
            itemStyle={{ color: "var(--text)" }}
            formatter={(value: number) => [`${value.toFixed(4)} ${symbol}`, "Cumulative yield"]}
          />
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke="#b7a4fb"
            strokeWidth={1.5}
            fill="url(#yieldFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
