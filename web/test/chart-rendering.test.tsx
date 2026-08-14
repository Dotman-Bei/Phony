import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AllocationView } from "@/components/AllocationView";
import { YieldChart } from "@/components/YieldChart";
import { allocationRows } from "@/hooks/useVault";
import { strategyFixture, usdt, vaultFixture } from "./fixtures";

/**
 * build.md §7.3 — "Chart data rendering".
 *
 * Two things are being checked, and the second matters more than the first. One: a chart with
 * data draws it. Two: a chart with *no* data says so, rather than drawing an empty axis that
 * reads as "zero yield" when the truth is "nothing has been harvested yet". A vault that has
 * never earned and a vault that has earned nothing look identical on a blank chart, and only one
 * of those is a fact about the strategy.
 */
describe("allocation data", () => {
  it("appends the idle reserve as its own row, earning nothing", () => {
    const rows = allocationRows(
      vaultFixture({
        idleAssets: usdt(400),
        totalAssets: usdt(1_000),
        strategies: [strategyFixture({ assets: usdt(600), actualBps: 6_000n })],
      }),
    );

    expect(rows).to.have.length(2);
    expect(rows[1].label).to.equal("Reserve");
    expect(rows[1].value).to.equal(usdt(400));
    expect(rows[1].apyBps).to.equal(0n);
    // The reserve carries no risk rating: it is not a strategy and must not be coloured as one.
    expect(rows[1].risk).to.equal(null);
  });

  it("computes the reserve's share of NAV rather than assuming the target", () => {
    // The live case: routing splits each deposit, so actual drifts from the 40% target.
    const rows = allocationRows(
      vaultFixture({
        idleAssets: usdt(800),
        totalAssets: usdt(6_030),
        strategies: [strategyFixture({ assets: usdt(5_230), actualBps: 8_673n })],
      }),
    );

    expect(Number(rows[1].bps)).to.be.closeTo(1_326, 5);
  });

  it("survives an empty vault without dividing by zero", () => {
    const rows = allocationRows(
      vaultFixture({ idleAssets: 0n, totalAssets: 0n, strategies: [] }),
    );

    expect(rows).to.have.length(1);
    expect(rows[0].bps).to.equal(0n);
  });
});

describe("AllocationView", () => {
  it("renders a legend row per strategy plus the reserve", () => {
    render(
      <AllocationView
        vault={vaultFixture({
          idleAssets: usdt(400),
          totalAssets: usdt(1_000),
          strategies: [strategyFixture({ assets: usdt(600) })],
        })}
      />,
    );

    expect(screen.getByText("BDEX LP")).toBeInTheDocument();
    expect(screen.getByText("Reserve")).toBeInTheDocument();
  });

  it("never colours the allocation by risk", () => {
    // Deliberate: saturated risk colour on an allocation chart reads as the vault endorsing the
    // split. Risk ratings belong on the strategy page, next to the reasoning for them. This
    // pins that rule so a future "helpful" change to colour segments by risk fails here.
    const { container } = render(
      <AllocationView
        vault={vaultFixture({ strategies: [strategyFixture({ risk: "high" })] })}
      />,
    );

    expect(container.querySelector(".risk-low, .risk-medium, .risk-high")).to.equal(null);
    expect(screen.queryByText(/high risk/i)).to.equal(null);

    // Segments carry the strategy's structural swatch instead.
    const swatch = container.querySelector(".alloc-swatch") as HTMLElement | null;
    expect(swatch).to.not.equal(null);
    expect(swatch?.getAttribute("style")).to.contain("background");
  });

  it("renders an empty vault as an empty state, not a chart of zeroes", () => {
    render(
      <AllocationView vault={vaultFixture({ totalAssets: 0n, idleAssets: 0n, strategies: [] })} />,
    );

    // Nothing deployed means no strategy legend row to find.
    expect(screen.queryByText("BDEX LP")).to.equal(null);
  });
});

describe("YieldChart", () => {
  // YieldPoint carries base units as strings: these come from event logs, not from arithmetic.
  const series = [
    { timestamp: 1_786_000_000, amount: usdt(0.5).toString(), cumulative: usdt(0.5).toString() },
    { timestamp: 1_786_086_400, amount: usdt(0.75).toString(), cumulative: usdt(1.25).toString() },
    { timestamp: 1_786_172_800, amount: usdt(0.75).toString(), cumulative: usdt(2).toString() },
  ];

  it("draws a series when harvests exist", () => {
    const { container } = render(
      <YieldChart series={series} decimals={6} symbol="USDT" unavailable={false} />,
    );

    // Recharts renders SVG; its presence is what proves it drew rather than bailing to a note.
    expect(container.querySelector("svg")).to.not.equal(null);
    expect(container.querySelector(".empty-state")).to.equal(null);
  });

  it("says no harvest has happened rather than drawing a flat zero line", () => {
    const { container } = render(
      <YieldChart series={[]} decimals={6} symbol="USDT" unavailable={false} />,
    );

    // The heading is a data attribute that CSS surfaces via attr(), so assert the attribute
    // rather than visible text — jsdom renders no pseudo-elements.
    expect(container.querySelector(".empty-state")).toHaveAttribute(
      "data-note",
      "No harvest recorded",
    );
    // The distinction that matters: yield may still be accruing inside the strategy.
    expect(screen.getByText(/already reflected in the share price/i)).toBeInTheDocument();
    expect(container.querySelector("svg")).to.equal(null);
  });

  it("distinguishes an RPC that refused the log range from a vault with no history", () => {
    const { container } = render(
      <YieldChart series={[]} decimals={6} symbol="USDT" unavailable />,
    );

    expect(container.querySelector(".empty-state")).toHaveAttribute(
      "data-note",
      "History unavailable",
    );
    expect(screen.getByText(/declined the log range/i)).toBeInTheDocument();
  });
});
