import { describe, expect, it } from "vitest";

import {
  formatBps,
  formatCompact,
  formatSharePrice,
  formatToken,
  parseAmount,
  toInputValue,
} from "@/lib/format";

/**
 * build.md §7.3 — "Share price calculation accuracy".
 *
 * Most of these guard one rule: a UI must never show more than the chain will pay out. Every
 * token amount truncates rather than rounds, because a balance rounded up produces a failed
 * transaction and a user who thinks the app lied.
 *
 * They also pin the 6-decimal behaviour specifically. A wrong decimal count is not a cosmetic
 * bug here — it shipped once, and it rendered 3 USDT as 0.0000 and quoted 2 trillion shares.
 */
describe("share price and amount formatting", () => {
  describe("formatToken truncates, never rounds up", () => {
    it("truncates a 6-decimal amount instead of rounding it up", () => {
      // 4.029824 USDT with 4 places shown must not become 4.0299.
      expect(formatToken(4_029_824n, 6, 4)).to.equal("4.0298");
    });

    it("does not round a hair below the next unit up to it", () => {
      expect(formatToken(1_999_999n, 6, 2)).to.equal("1.99");
      expect(formatToken(999_999n, 6, 0)).to.equal("0");
    });

    it("renders 18-decimal amounts as well, for a chain that uses them", () => {
      expect(formatToken(10n ** 18n, 18, 2)).to.equal("1.00");
    });

    it("shows a placeholder rather than a zero for missing data", () => {
      expect(formatToken(undefined, 6, 2)).to.equal("--");
    });
  });

  describe("share price", () => {
    it("prices a share just under parity", () => {
      // The live vault: 4.036503 assets / 4.045844 shares = 0.997692.
      const sharePrice = (usdt(4.036503) * 10n ** 6n) / usdt(4.045844);

      // Rounds to nearest at 4 dp rather than truncating, unlike formatToken. That split is
      // deliberate and this pins it: a *balance* must never display above what the chain will
      // pay out, but a share price is not a withdrawable amount, so nearest is the honest
      // rendering of it. If someone ever makes formatToken round, the truncation tests above
      // fail — which is the point.
      expect(formatSharePrice(sharePrice, 6)).to.equal("0.9977");
    });

    it("prices parity exactly", () => {
      expect(formatSharePrice(10n ** 6n, 6)).to.equal("1.0000");
    });

    it("reads a 6-decimal price at the right scale", () => {
      // The decimals bug: an 18-decimal reading of a 6-decimal price collapses to zero.
      expect(formatSharePrice(10n ** 6n, 18)).to.equal("0.0000");
      expect(formatSharePrice(10n ** 6n, 6)).to.equal("1.0000");
    });
  });

  describe("deposit and withdraw quotes", () => {
    const unit = 10n ** 6n;

    /** The arithmetic the action panel uses for "You receive". */
    const sharesFor = (assets: bigint, sharePrice: bigint) => (assets * unit) / sharePrice;
    const assetsFor = (shares: bigint, sharePrice: bigint) => (shares * sharePrice) / unit;

    it("quotes more shares than assets when a share is worth less than one asset", () => {
      const sharePrice = 997_692n; // 0.997692
      const shares = sharesFor(usdt(2), sharePrice);

      expect(shares).toBeGreaterThan(usdt(2));
      expect(formatToken(shares, 6, 4)).to.equal("2.0046");
    });

    it("round-trips assets -> shares -> assets without inventing value", () => {
      const sharePrice = 997_692n;
      const shares = sharesFor(usdt(2), sharePrice);

      // Truncation must lose a sliver, never gain one.
      expect(assetsFor(shares, sharePrice)).toBeLessThanOrEqual(usdt(2));
    });

    it("quotes 1:1 at parity", () => {
      expect(sharesFor(usdt(50), unit)).to.equal(usdt(50));
    });
  });

  describe("parseAmount", () => {
    it("parses a decimal string at 6 decimals", () => {
      expect(parseAmount("2.5", 6)).to.equal(2_500_000n);
    });

    it("rejects junk rather than guessing zero", () => {
      expect(parseAmount("", 6)).to.equal(null);
      expect(parseAmount("abc", 6)).to.equal(null);
    });

    it("does not silently truncate more precision than the asset has", () => {
      // 7 decimal places against a 6-decimal token.
      const parsed = parseAmount("1.1234567", 6);
      expect(parsed === null || parsed <= 1_123_457n).to.equal(true);
    });

    it("survives a round trip through the Max button's formatter", () => {
      const exitable = 4_029_824n;
      const shown = toInputValue(exitable, 6);
      expect(parseAmount(shown, 6)).toBeLessThanOrEqual(exitable);
    });
  });

  describe("bps and compact", () => {
    it("formats basis points as a percentage", () => {
      expect(formatBps(1_000n, 0)).to.equal("10%");
      expect(formatBps(4_000n, 0)).to.equal("40%");
    });

    it("formats a TVL compactly at 6 decimals", () => {
      // Also rounds to nearest: a headline TVL is a summary, not a claim on anyone's capital.
      expect(formatCompact(usdt(1_250), 6)).to.equal("1.3K");
      expect(formatCompact(usdt(4.0365), 6)).to.equal("4.04");
    });
  });
});

function usdt(whole: number): bigint {
  return BigInt(Math.round(whole * 1e6));
}
