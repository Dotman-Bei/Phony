/**
 * Editorial metadata for the strategy legs.
 *
 * The risk rating is the one place this app is allowed to use saturated colour, so it is
 * defined here rather than inferred in a component — a rating is a claim about someone's
 * capital and belongs in one auditable table, not scattered across JSX.
 *
 * The list is short because BOT Chain is short on venues. There is no lending market, no
 * tokenized-treasury issuer and no ERC-4626 vault on the chain, so a T-bill leg and a private
 * credit leg would have had nothing real behind them. They were removed rather than simulated,
 * and the unallocated weight sits in the vault's idle reserve where it is honestly described as
 * earning nothing.
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
    name: "BDEX V2 - USDT/WBOT",
    shortName: "BDEX LP",
    risk: "medium",
    swatch: "#8562ff",
    summary:
      "Provides single-sided liquidity to the live BDEX V2 USDT/WBOT pair and earns its trading fees. The vault swaps part of each deposit for WBOT, adds both sides, and reverses that on exit.",
    riskNote:
      "Impermanent loss is real: half the position is WBOT, so a fall in WBOT marks the position down within the block it happens. Fees are earned only when the pair is actually traded, so a quiet market pays nothing rather than an advertised rate.",
    liquidity: "Same block, minus the round-trip swap fee",
    source: "BDEX V2 (Uniswap V2 architecture), 0.30% fee tier",
  },
];

/** Fallback for a leg deployed but not yet described here. */
export const UNKNOWN_STRATEGY: StrategyMeta = {
  name: "Unknown strategy",
  shortName: "Unknown",
  risk: "high",
  swatch: "#5b4bbd",
  summary:
    "This adapter is registered on chain but has no entry in the app's metadata table. Its numbers are read live; its risk rating is withheld rather than guessed.",
  riskNote:
    "Unrated. An unreviewed venue is treated as the highest risk tier until someone writes down why it is not.",
  liquidity: "Unknown",
  source: "Unrecognised adapter",
};

export function metaFor(onChainName: string): StrategyMeta {
  return (
    STRATEGY_META.find((meta) => meta.name === onChainName) ?? {
      ...UNKNOWN_STRATEGY,
      name: onChainName,
      shortName: onChainName.slice(0, 12),
    }
  );
}

/**
 * The idle reserve — whatever weight the curator leaves unallocated.
 *
 * It earns nothing and says so. On a chain with exactly one real yield venue the reserve is
 * doing more work than usual: it is the part of the vault that can always be exited in full,
 * in-block, with no swap and no price impact.
 */
export const RESERVE_META = {
  name: "Idle reserve",
  shortName: "Reserve",
  swatch: "#3a3363",
  summary:
    "Unallocated capital held in the vault. Earns nothing, exits instantly, and absorbs small withdrawals without touching a strategy.",
} as const;

/**
 * Risk rating presentation. One class per tier, driven by a single function so the saturated
 * colour can never disagree with the rating it is supposed to represent.
 */
export function riskClass(risk: RiskLevel): string {
  return `risk-${risk}`;
}

export function riskLabel(risk: RiskLevel): string {
  return { low: "Low risk", medium: "Medium risk", high: "High risk" }[risk];
}
