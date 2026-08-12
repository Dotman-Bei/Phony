"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Info, XCircle } from "lucide-react";

import type { DataMode } from "@/lib/contracts";
import { riskClass, riskLabel, type RiskLevel } from "@/lib/strategyMeta";

/* ------------------------------------------------------------------ mode --- */

/**
 * Mode badge. Carries the same semantic weight as a risk rating: it states where the numbers
 * beside it came from. There is no "demo" state any more — the vault holds the chain's own USDT
 * and earns a real BDEX pair's fees, so the only other case is a chain with no deployment,
 * which never borrows the live colour.
 */
export function ModeBadge({ mode }: { mode: DataMode }) {
  const config = {
    live: { className: "mode-live", label: "Live" },
    unconfigured: { className: "mode-unconfigured", label: "Not deployed" },
  }[mode];

  return (
    <span
      className={`mode-badge ${config.className}`}
      title={
        mode === "live"
          ? "Real asset, real venue: the chain's USDT deployed into a live BDEX pair. Yields are fees actually earned, not projections."
          : "No Phony deployment on this network."
      }
    >
      {config.label}
    </span>
  );
}

/* ------------------------------------------------------------------ risk --- */

export function RiskPill({ risk }: { risk: RiskLevel }) {
  return <span className={`risk-pill ${riskClass(risk)}`}>{riskLabel(risk)}</span>;
}

export function RiskBanner({ risk, children }: { risk: RiskLevel; children: ReactNode }) {
  return <div className={`risk-banner ${riskClass(risk)}`}>{children}</div>;
}

/* ---------------------------------------------------------------- panels --- */

export function Panel({
  index,
  title,
  state,
  action,
  children,
  className = "",
}: {
  index?: string;
  title: string;
  state?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-header">
        {index ? <span className="panel-index">{index}</span> : null}
        <h2>{title}</h2>
        {action ? <div style={{ marginLeft: "auto" }}>{action}</div> : null}
        {state && !action ? <span className="panel-state">{state}</span> : null}
      </header>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- data ---- */

export interface MetricSpec {
  label: string;
  value: string;
  sub?: string;
}

export function MetricGrid({
  metrics,
  columns = 4,
  flush = false,
}: {
  metrics: MetricSpec[];
  columns?: 2 | 3 | 4;
  flush?: boolean;
}) {
  const columnClass = columns === 3 ? "metric-grid--3" : columns === 2 ? "metric-grid--2" : "";

  return (
    <div className={`metric-grid ${columnClass} ${flush ? "metric-grid--flush" : ""}`}>
      {metrics.map((metric) => (
        <div className="metric" key={metric.label}>
          <span className="metric-label">{metric.label}</span>
          <span className="metric-value num">{metric.value}</span>
          {metric.sub ? <span className="metric-sub num">{metric.sub}</span> : null}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- states ---- */

export function EmptyState({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="empty-state" data-note={note}>
      {children}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const Icon = tone === "error" ? XCircle : tone === "warn" ? AlertTriangle : Info;
  const toneClass = tone === "error" ? "notice--error" : tone === "warn" ? "notice--warn" : "";

  return (
    <div className={`notice ${toneClass}`}>
      <Icon size={15} strokeWidth={2} />
      <span>{children}</span>
    </div>
  );
}

export function SourceBadge({ live, label }: { live: boolean; label: string }) {
  return (
    <span className="source-badge">
      <span className={`source-dot ${live ? "dot-live" : "dot-local"}`} />
      {label}
    </span>
  );
}
