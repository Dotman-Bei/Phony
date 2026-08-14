import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VaultActionPanel } from "@/components/VaultActionPanel";
import { renderWithProviders, usdt, vaultFixture } from "./fixtures";

/**
 * build.md §7.3 — "Deposit transaction flow".
 *
 * The write path is stubbed, deliberately. What matters here is the decision the panel makes
 * *before* a signature is requested: approve or deposit, what it quotes, and when it refuses.
 * Whether the chain accepts the resulting call is settled in `contracts/test` against a fork of
 * the real BDEX, which is the only place that answer is worth anything.
 */

const actions = {
  phase: "idle" as string,
  action: null as string | null,
  hash: undefined as `0x${string}` | undefined,
  error: null as string | null,
  isBusy: false,
  approve: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  redeem: vi.fn(),
  harvest: vi.fn(),
  reset: vi.fn(),
};

vi.mock("@/hooks/useVaultActions", () => ({
  useVaultActions: () => actions,
}));

// The panel renders a connect button when disconnected; these tests are about the connected path.
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return { ...actual, useAccount: () => ({ isConnected: true }), useChainId: () => 968 };
});

beforeEach(() => {
  actions.phase = "idle";
  actions.action = null;
  actions.error = null;
  actions.isBusy = false;
});

async function typeAmount(value: string) {
  const input = screen.getByLabelText(/amount to deposit/i);
  await userEvent.clear(input);
  await userEvent.type(input, value);
  return input;
}

describe("deposit flow", () => {
  it("asks for an amount before it will do anything", () => {
    renderWithProviders(<VaultActionPanel vault={vaultFixture()} />);
    const button = screen.getByRole("button", { name: /enter an amount/i });
    expect(button).toBeDisabled();
  });

  it("requires approval first when the allowance is zero, then deposits", async () => {
    const vault = vaultFixture({ allowance: 0n, walletBalance: usdt(3) });
    const { rerender } = renderWithProviders(<VaultActionPanel vault={vault} />);

    await typeAmount("2");

    // Step one: the button offers approval, named after the real asset.
    const approve = screen.getByRole("button", { name: /approve usdt/i });
    await userEvent.click(approve);
    expect(actions.approve).toHaveBeenCalledOnce();
    expect(actions.deposit).not.toHaveBeenCalled();

    // Step two: with an allowance in place the same button becomes the deposit.
    rerender(<VaultActionPanel vault={vaultFixture({ allowance: usdt(1_000) })} />);
    await typeAmount("2");

    await userEvent.click(screen.getByRole("button", { name: /deposit & restake/i }));
    expect(actions.deposit).toHaveBeenCalledWith(usdt(2));
  });

  it("skips approval entirely when the allowance already covers the deposit", async () => {
    renderWithProviders(<VaultActionPanel vault={vaultFixture({ allowance: usdt(1_000) })} />);
    await typeAmount("2");

    expect(screen.queryByRole("button", { name: /approve/i })).to.equal(null);
    await userEvent.click(screen.getByRole("button", { name: /deposit & restake/i }));
    expect(actions.deposit).toHaveBeenCalledWith(usdt(2));
    expect(actions.approve).not.toHaveBeenCalled();
  });

  it("refuses a deposit larger than the wallet holds", async () => {
    renderWithProviders(<VaultActionPanel vault={vaultFixture({ walletBalance: usdt(3) })} />);
    await typeAmount("5");

    const button = screen.getByRole("button", { name: /amount exceeds maximum/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/maximum is 3\.0000 usdt/i)).toBeInTheDocument();

    await userEvent.click(button);
    expect(actions.deposit).not.toHaveBeenCalled();
  });

  it("quotes shares from the share price before any signature", async () => {
    // 0.997692 per share, so 2 USDT buys slightly more than 2 shares.
    renderWithProviders(
      <VaultActionPanel vault={vaultFixture({ sharePrice: 997_692n, allowance: usdt(1_000) })} />,
    );
    await typeAmount("2");

    expect(screen.getByText(/~2\.0046 brRWA/)).toBeInTheDocument();
    expect(screen.getByText(/1 brRWA = 0\.9977 USDT/)).toBeInTheDocument();
  });

  it("states the performance fee applies to yield only", () => {
    renderWithProviders(<VaultActionPanel vault={vaultFixture()} />);
    expect(screen.getByText(/10% of yield/i)).toBeInTheDocument();
  });

  it("closes deposits while the vault is paused", async () => {
    renderWithProviders(
      <VaultActionPanel vault={vaultFixture({ paused: true, allowance: usdt(1_000) })} />,
    );
    await typeAmount("2");

    expect(screen.getByRole("button", { name: /deposit & restake/i })).toBeDisabled();
    expect(screen.getByText(/vault is paused/i)).toBeInTheDocument();
  });

  it("reports a wallet rejection instead of failing silently", async () => {
    actions.error = "Transaction rejected in wallet.";
    renderWithProviders(<VaultActionPanel vault={vaultFixture({ allowance: usdt(1_000) })} />);

    expect(screen.getByText(/transaction rejected in wallet/i)).toBeInTheDocument();
  });

  it("distinguishes waiting on the wallet from waiting on the chain", async () => {
    actions.phase = "signing";
    actions.isBusy = true;
    const { rerender } = renderWithProviders(
      <VaultActionPanel vault={vaultFixture({ allowance: usdt(1_000) })} />,
    );
    expect(screen.getByRole("button", { name: /confirm in wallet/i })).toBeInTheDocument();

    actions.phase = "pending";
    rerender(<VaultActionPanel vault={vaultFixture({ allowance: usdt(1_000) })} />);
    expect(screen.getByRole("button", { name: /submitting/i })).toBeInTheDocument();
  });
});

describe("withdraw flow", () => {
  async function switchToWithdraw() {
    await userEvent.click(screen.getByRole("tab", { name: /withdraw/i }));
  }

  it("bounds the withdrawal by exitable liquidity, not by share value", async () => {
    // The design claim: 2 USDT of position but only 1.9 can be freed this block.
    renderWithProviders(
      <VaultActionPanel
        vault={vaultFixture({
          shares: usdt(2),
          positionValue: usdt(2),
          maxWithdraw: usdt(1.9),
        })}
      />,
    );
    await switchToWithdraw();

    expect(screen.getByText(/withdrawable 1\.9000 usdt/i)).toBeInTheDocument();

    const input = screen.getByLabelText(/amount to withdraw/i);
    await userEvent.type(input, "2");
    expect(screen.getByRole("button", { name: /amount exceeds maximum/i })).toBeDisabled();
  });

  it("warns that the shortfall is capital a strategy cannot release yet", async () => {
    renderWithProviders(
      <VaultActionPanel
        vault={vaultFixture({ shares: usdt(2), positionValue: usdt(2), maxWithdraw: usdt(1.9) })}
      />,
    );
    await switchToWithdraw();

    expect(screen.getByText(/cannot be recalled this block/i)).toBeInTheDocument();
  });

  it("leaves a margin below the quote when Max is pressed", async () => {
    renderWithProviders(
      <VaultActionPanel
        vault={vaultFixture({ shares: usdt(2), positionValue: usdt(2), maxWithdraw: 4_029_824n })}
      />,
    );
    await switchToWithdraw();
    await userEvent.click(screen.getByRole("button", { name: /^max$/i }));

    // 20 bps under 4.029824. Requesting the exact quote was refused on chain by 11 units,
    // because maxWithdraw moves with the pool between quote and signature.
    const input = screen.getByLabelText(/amount to withdraw/i) as HTMLInputElement;
    const filled = Number(input.value);
    expect(filled).to.be.lessThan(4.029824);
    expect(filled).to.be.greaterThan(4.02);
  });

  it("redeems the whole share balance when exiting in full", async () => {
    const vault = vaultFixture({
      shares: usdt(2),
      positionValue: usdt(2),
      maxWithdraw: usdt(2),
    });
    renderWithProviders(<VaultActionPanel vault={vault} />);
    await switchToWithdraw();

    const input = screen.getByLabelText(/amount to withdraw/i);
    await userEvent.type(input, "2");
    await userEvent.click(screen.getByRole("button", { name: /^withdraw$/i }));

    // Redeem by shares, not by assets: a share-price tick between quote and signature would
    // otherwise leave dust behind.
    expect(actions.redeem).toHaveBeenCalledWith(usdt(2));
    expect(actions.withdraw).not.toHaveBeenCalled();
  });
});
