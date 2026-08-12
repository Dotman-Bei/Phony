import { formatUnits } from "viem";

/**
 * Number formatting.
 *
 * One rule runs through all of it: never round a balance up. A UI that shows more than the
 * chain will pay out produces a failed transaction and a user who thinks the app lied, so
 * every token amount here truncates.
 */

const BPS = 10_000n;

/** Truncating token format — never rounds up past what the chain holds. */
export function formatToken(
  value: bigint | undefined,
  decimals = 18,
  fractionDigits = 2,
): string {
  if (value === undefined) return "--";

  const negative = value < 0n;
  const abs = negative ? -value : value;

  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const remainder = abs % scale;

  const digits =
    fractionDigits > 0
      ? (remainder * 10n ** BigInt(fractionDigits)) / scale
      : 0n;

  const wholeStr = whole.toLocaleString("en-US");
  const sign = negative ? "-" : "";

  if (fractionDigits === 0) return `${sign}${wholeStr}`;
  return `${sign}${wholeStr}.${digits.toString().padStart(fractionDigits, "0")}`;
}

/** Compact form for headline TVL figures: 1.24M, 845.2K. */
export function formatCompact(value: bigint | undefined, decimals = 18): string {
  if (value === undefined) return "--";

  const asNumber = Number(formatUnits(value, decimals));
  if (!Number.isFinite(asNumber)) return "--";

  const abs = Math.abs(asNumber);
  if (abs >= 1_000_000_000) return `${(asNumber / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(asNumber / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(asNumber / 1_000).toFixed(1)}K`;
  return asNumber.toFixed(2);
}

/** Basis points to a percentage string. 420n -> "4.20%" */
export function formatBps(bps: bigint | number | undefined, fractionDigits = 2): string {
  if (bps === undefined) return "--";
  return `${(Number(bps) / 100).toFixed(fractionDigits)}%`;
}

/** Share price, printed at the precision the number actually carries. */
export function formatSharePrice(value: bigint | undefined, decimals = 18): string {
  if (value === undefined) return "--";
  return Number(formatUnits(value, decimals)).toFixed(4);
}

/** Signed percentage change, for gain/loss readouts. */
export function formatDelta(current: bigint, baseline: bigint): string {
  if (baseline === 0n) return "0.00%";
  const deltaBps = ((current - baseline) * BPS) / baseline;
  const sign = deltaBps >= 0n ? "+" : "";
  return `${sign}${(Number(deltaBps) / 100).toFixed(2)}%`;
}

/** 0x1234…abcd */
export function shortenAddress(address: string | undefined, chars = 4): string {
  if (!address || address.length < 12) return address ?? "--";
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export function shortenHash(hash: string | undefined): string {
  if (!hash) return "--";
  return `${hash.slice(0, 10)}…`;
}

/** "3h 12m ago" — mono-friendly and stable in width. */
export function formatRelativeTime(timestampSeconds: bigint | number | undefined): string {
  if (timestampSeconds === undefined) return "--";

  const then = Number(timestampSeconds);
  if (then === 0) return "never";

  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - then);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function formatTimestamp(timestampSeconds: bigint | number | undefined): string {
  if (timestampSeconds === undefined) return "--";
  const date = new Date(Number(timestampSeconds) * 1000);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Parse user input into base units without floating point.
 *
 * `parseUnits` on a Number would silently corrupt large balances, so the string is split
 * and padded directly. Excess decimals are truncated, matching the never-round-up rule.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;

  const [wholePart = "0", fractionPart = ""] = trimmed.split(".");
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");

  try {
    return BigInt(wholePart || "0") * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  } catch {
    return null;
  }
}

/** Full-precision string for pre-filling an input from a balance. */
export function toInputValue(value: bigint | undefined, decimals: number): string {
  if (value === undefined) return "";
  return formatUnits(value, decimals);
}
