/**
 * Editorial metadata for the three strategy legs.
 *
 * The risk rating is the one place this app is allowed to use saturated colour, so it is
 * defined here rather than inferred in a component — a rating is a claim about someone's
 * capital and belongs in one auditable table, not scattered across JSX.
 *
 * The ratings themselves follow the structure of each yield source, not its advertised
 * APY: T-bills are sovereign credit with instant redemption; private credit is
 * counterparty risk with a notice period; LP positions carry impermanent loss and can be
 * marked down in a single block. That ordering is why the highest yield carries the
 * middle rating and not the lowest one.
 */

export type RiskLevel = "low" | "medium" | "high";

export interface StrategyMeta {
  /** Matches `IStrategyAdapter.name()` exactly — the on-chain name is the join key. */
  name: string;
  shortName: string;
  risk: RiskLevel;
  /** Hex used for the allocation bars and chart segments. Structural violets only. */
  swatch: string;
  summary: string;
  riskNote: string;
  liquidity: string;
  source: string;
}

export const STRATEGY_META: StrategyMeta[] = [
  {
    name: "T-Bill Strategy",
    shortName: "T-Bill",
    risk: "low",
    swatch: "#b7a4fb",
    summary:
      "Holds tokenized treasury bills through an ERC-4626 yield product. The base-rate leg and the vault's liquidity anchor.",
    riskNote:
      "Sovereign credit with same-block redemption. The adapter derives its APY from the source's realised share price rather than an advertised rate.",
    liquidity: "Instant",
    source: "ERC-4626 tokenized T-bill vault",
  },
  {
    name: "Private Credit Strategy",
    shortName: "Credit",
    risk: "medium",
    swatch: "#8562ff",
    summary:
      "Lends into a private credit pool. Highest coupon in the vault, and the only leg where capital is genuinely locked while borrowers hold it.",
    riskNote:
      "Counterparty and duration risk. Principal out on loan cannot be recalled in-block, which is why the vault reduces its withdrawal maximum instead of promising an exit it cannot deliver.",
    liquidity: "Partial — gated by pool utilisation",
    source: "Private credit pool",
  },
  {
    name: "RWA Liquidity Strategy",
    shortName: "Liquidity",
    risk: "high",
    swatch: "#713dff",
    summary:
      "Provides single-sided liquidity to an RWA trading pair and collects the trading fees.",
    riskNote:
      "Impermanent loss. This is the only leg whose principal can fall, and the vault marks it to live pool value every block rather than carrying it at cost.",
    liquidity: "Instant",
    source: "RWA/stable AMM pair",
  },
];

const BY_NAME = new Map(STRATEGY_META.map((meta) => [meta.name, meta]));

/** The idle reserve buffer is rendered alongside the strategies but is not one. */
export const RESERVE_META = {
  name: "Reserve Buffer",
  shortName: "Reserve",
  swatch: "#4b3a78",
  summary:
    "Whatever the curator leaves unallocated. Sits idle in the vault so ordinary withdrawals cost one transfer instead of unwinding three strategies.",
} as const;

export function metaFor(onChainName: string): StrategyMeta | undefined {
  return BY_NAME.get(onChainName);
}

export function riskLabel(risk: RiskLevel): string {
  return { low: "Low risk", medium: "Medium risk", high: "High risk" }[risk];
}

export function riskClass(risk: RiskLevel): string {
  return `risk-${risk}`;
}
