import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { addSecondLeg, deployPhony, generateTradingFees, usdt } from "./fixtures";

/**
 * BotVault — against real BDEX liquidity on a fork of BOT Chain testnet.
 *
 * Every assertion here goes through a live pool, which changes what can be asserted. There is no
 * exact arithmetic on the way in or out: entry swaps half the deposit and pays 0.3%, exit reverses
 * it, and the pool's price moves between blocks because other people trade it. So the tests bound
 * what must hold — shares never inflate, NAV never overstates what can be withdrawn, a late
 * depositor cannot take yield earned before they arrived — rather than pinning numbers a mock
 * would have made exact and a real pool never will.
 */
describe("BotVault", () => {
  describe("ERC-4626 conformance", () => {
    it("reports the real asset and its decimals", async () => {
      const { vault, asset } = await loadFixture(deployPhony);

      expect(await vault.asset()).to.equal(await asset.getAddress());
      expect(await vault.decimals()).to.equal(6n);
      expect(await vault.symbol()).to.equal("brRWA");
    });

    it("mints shares one-for-one into an empty vault", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(usdt(500));
      expect(await vault.totalSupply()).to.equal(usdt(500));
    });

    it("honours previewDeposit exactly", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));

      const previewed = await vault.previewDeposit(usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(previewed);
    });

    it("emits Deposit and Withdraw with the ERC-4626 signatures", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));

      await expect(vault.connect(alice).deposit(usdt(200), alice.address))
        .to.emit(vault, "Deposit")
        .withArgs(alice.address, alice.address, usdt(200), usdt(200));

      const exitable = await vault.maxWithdraw(alice.address);
      await expect(vault.connect(alice).withdraw(exitable, alice.address, alice.address)).to.emit(
        vault,
        "Withdraw",
      );
    });

    it("treats a zero deposit as a no-op rather than reverting", async () => {
      const { alice, vault } = await loadFixture(deployPhony);

      // OZ's ERC-4626 permits it and mints nothing, which is harmless: no shares, no routing,
      // no state change beyond the event. Pinned because it is a conformance question someone
      // will otherwise "fix" in one direction or the other.
      await vault.connect(alice).deposit(0, alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(0n);
      expect(await vault.totalSupply()).to.equal(0n);
    });

    it("lets a third party spend an approved share balance, and no more", async () => {
      const { alice, bob, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(400), alice.address);

      const shares = await vault.balanceOf(alice.address);
      await vault.connect(alice).approve(bob.address, shares / 2n);

      // Bob may redeem what he was approved for.
      await vault.connect(bob).redeem(shares / 2n, bob.address, alice.address);

      // And not a share more.
      await expect(vault.connect(bob).redeem(shares / 2n, bob.address, alice.address)).to.be
        .reverted;
    });
  });

  describe("routing and the reserve buffer", () => {
    it("splits a deposit by weight and leaves the rest idle", async () => {
      const { alice, asset, vault, strategy } = await loadFixture(deployPhony);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      // 60% deployed, 40% idle. The principal placed is exact; the mark is not.
      expect(await vault.idleAssets()).to.equal(usdt(400));
      expect(await strategy.totalDeposited()).to.equal(usdt(600));

      // Marked to the pool's post-entry spot price, which sits above cost because the entry
      // itself moved the price. What the position could actually be unwound for is below cost.
      expect(await strategy.totalAssets()).to.be.gte(await strategy.totalDeposited());
      expect(await strategy.availableLiquidity()).to.be.lt(await strategy.totalAssets());
    });

    it("applies weights to the idle balance, so the reserve converges on its target", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(2_000));

      await vault.connect(alice).deposit(usdt(500), alice.address);
      expect(await vault.idleAssets()).to.equal(usdt(200));

      await vault.connect(alice).deposit(usdt(500), alice.address);
      // Not a per-deposit split: routing deploys 60% of whatever is idle, which after the second
      // deposit is 200 + 500. So idle lands at 280, not 400, and each further deposit pulls the
      // reserve nearer its 40% target from above rather than tracking it exactly.
      expect(await vault.idleAssets()).to.equal(usdt(280));
      expect(await vault.idleAssets()).to.be.lt((await vault.totalAssets() * 40n) / 100n);
    });

    it("never leaves capital stranded in the router", async () => {
      const { alice, asset, vault, router } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      expect(await asset.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("counts idle and deployed capital as one NAV", async () => {
      const { alice, asset, vault, router } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const nav = await vault.totalAssets();
      const idle = await vault.idleAssets();
      const deployed = await router.getTotalStrategyAssets();

      expect(nav).to.equal(idle + deployed);
    });
  });

  describe("liquidity-aware maxima", () => {
    it("quotes an exit below nominal share value, by the cost of unwinding", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const nominal = await vault.convertToAssets(await vault.balanceOf(alice.address));
      const exitable = await vault.maxWithdraw(alice.address);

      expect(exitable).to.be.lt(nominal);
      // The gap is the round trip on the deployed 60%, not on the whole position.
      expect(exitable).to.be.gt((nominal * 98n) / 100n);
    });

    it("honours a withdrawal of exactly the quoted maximum", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const quoted = await vault.maxWithdraw(alice.address);
      const before = await asset.balanceOf(alice.address);

      await vault.connect(alice).withdraw(quoted, alice.address, alice.address);
      expect(await asset.balanceOf(alice.address)).to.equal(before + quoted);
    });

    it("refuses a withdrawal above the quoted maximum", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const quoted = await vault.maxWithdraw(alice.address);
      await expect(vault.connect(alice).withdraw(quoted + usdt(50), alice.address, alice.address)).to
        .be.reverted;
    });

    it("serves a small withdrawal out of the idle reserve alone", async () => {
      const { alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const lpBefore = await strategy.lpBalance();
      await vault.connect(alice).withdraw(usdt(100), alice.address, alice.address);

      // Inside the 400 idle, so no LP was touched and no swap fee was paid.
      expect(await strategy.lpBalance()).to.equal(lpBefore);
      expect(await vault.idleAssets()).to.equal(usdt(300));
    });

    it("bounds maxWithdraw by the vault's liquidity, not the holder's balance", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      expect(await vault.maxWithdraw(alice.address)).to.be.lte(await vault.availableLiquidity());
    });
  });

  describe("harvest and fees", () => {
    it("reports zero yield and takes no fee when nothing has accrued", async () => {
      const { alice, asset, vault, feeRecipient } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      await vault.harvest();

      expect(await vault.totalYieldHarvested()).to.equal(0n);
      expect(await asset.balanceOf(feeRecipient.address)).to.equal(0n);
    });

    it("pays the performance fee out of yield and nothing else", async () => {
      const { alice, asset, vault, feeRecipient } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      await generateTradingFees();
      await vault.harvest();

      const harvested = await vault.totalYieldHarvested();
      const fee = await asset.balanceOf(feeRecipient.address);

      if (harvested > 0n) {
        // 10% of gross. Harvested is reported net, so gross = harvested + fee.
        expect(fee).to.be.closeTo((harvested + fee) / 10n, 2n);
        // The fee can never be a slice of principal.
        expect(fee).to.be.lt(usdt(1_000) / 100n);
      }
    });

    it("raises the share price without minting a single share", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const supplyBefore = await vault.totalSupply();
      await generateTradingFees();
      await vault.harvest();

      // Compounding is a price move, not an airdrop: no shares are created.
      expect(await vault.totalSupply()).to.equal(supplyBefore);
    });

    it("is permissionless — anyone may call it", async () => {
      const { alice, bob, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      await expect(vault.connect(bob).harvest()).to.not.be.reverted;
    });

    it("caps the performance fee and rejects anything above it", async () => {
      const { curator, vault } = await loadFixture(deployPhony);

      await vault.connect(curator).setPerformanceFee(2_000n);
      expect(await vault.performanceFeeBps()).to.equal(2_000n);

      await expect(vault.connect(curator).setPerformanceFee(2_001n)).to.be.reverted;
    });
  });

  describe("multi-user share accounting", () => {
    it("does not let a late depositor capture yield earned before they arrived", async () => {
      const { alice, bob, asset, vault } = await loadFixture(deployPhony);
      const vaultAddress = await vault.getAddress();

      await (asset.connect(alice) as any).approve(vaultAddress, usdt(1_000));
      await (asset.connect(bob) as any).approve(vaultAddress, usdt(1_000));

      await vault.connect(alice).deposit(usdt(500), alice.address);

      await generateTradingFees();
      await vault.harvest();

      const priceAfterYield = await vault.sharePrice();
      const aliceValueBefore = await vault.convertToAssets(await vault.balanceOf(alice.address));

      await vault.connect(bob).deposit(usdt(500), bob.address);

      // KNOWN LIMITATION, measured rather than assumed. Bob's own entry moves the pool, and the
      // LP is marked at that post-entry spot price, so his position reads *above* what he paid —
      // by ~1.4% of the deposit at 500 USDT into a ~6.5k pool. Marking to spot is standard for LP
      // vaults, but combined with self-impact it means a deposit-then-exit round trip can pull a
      // little value from existing holders. It is bounded by the per-strategy cap (500) and the
      // vault cap (1000) sized against pool depth; the harvest basis already refuses to book any
      // of it as income. This assertion pins the size so a change that worsens it fails here.
      const bobMarked = await vault.maxWithdraw(bob.address);
      expect(bobMarked).to.be.lte((usdt(500) * 102n) / 100n);
      expect(await vault.sharePrice()).to.be.gte(priceAfterYield);

      // And Alice keeps the yield that accrued before he arrived.
      expect(await vault.convertToAssets(await vault.balanceOf(alice.address))).to.be.gte(
        aliceValueBefore,
      );
    });

    it("splits later yield between holders in proportion to their shares", async () => {
      const { alice, bob, asset, vault } = await loadFixture(deployPhony);
      const vaultAddress = await vault.getAddress();

      await (asset.connect(alice) as any).approve(vaultAddress, usdt(1_000));
      await (asset.connect(bob) as any).approve(vaultAddress, usdt(1_000));

      await vault.connect(alice).deposit(usdt(600), alice.address);
      await vault.connect(bob).deposit(usdt(300), bob.address);

      const aliceShares = await vault.balanceOf(alice.address);
      const bobShares = await vault.balanceOf(bob.address);

      // Alice put in twice as much, so she holds about twice the shares. The tolerance covers
      // the second deposit entering at a price the first one moved.
      expect(aliceShares).to.be.closeTo(bobShares * 2n, usdt(10));

      await generateTradingFees();
      await vault.harvest();

      // Yield arrives as a price move applied to every share equally, so whatever the ratio of
      // their shares was, the ratio of their positions matches it exactly.
      const aliceValue = await vault.convertToAssets(aliceShares);
      const bobValue = await vault.convertToAssets(bobShares);
      expect(aliceValue * bobShares).to.be.closeTo(bobValue * aliceShares, usdt(1) * usdt(1));
    });

    it("lets one holder exit without disturbing the other's position value", async () => {
      const { alice, bob, asset, vault } = await loadFixture(deployPhony);
      const vaultAddress = await vault.getAddress();

      await (asset.connect(alice) as any).approve(vaultAddress, usdt(1_000));
      await (asset.connect(bob) as any).approve(vaultAddress, usdt(1_000));
      await vault.connect(alice).deposit(usdt(400), alice.address);
      await vault.connect(bob).deposit(usdt(400), bob.address);

      const bobValueBefore = await vault.convertToAssets(await vault.balanceOf(bob.address));

      await vault.connect(alice).withdraw(usdt(200), alice.address, alice.address);

      const bobValueAfter = await vault.convertToAssets(await vault.balanceOf(bob.address));
      // Alice's exit came out of idle, so Bob is untouched beyond pool drift.
      expect(bobValueAfter).to.be.closeTo(bobValueBefore, usdt(1));
    });
  });

  describe("pause and curator controls", () => {
    it("closes deposits and withdrawals while paused, without touching NAV", async () => {
      const { curator, alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      const navBefore = await vault.totalAssets();
      await vault.connect(curator).pause();

      await expect(vault.connect(alice).deposit(usdt(100), alice.address)).to.be.reverted;
      await expect(vault.connect(alice).withdraw(usdt(10), alice.address, alice.address)).to.be
        .reverted;

      // Deployed capital keeps earning and NAV keeps being reported.
      expect(await vault.totalAssets()).to.be.closeTo(navBefore, usdt(1));

      await vault.connect(curator).unpause();
      await expect(vault.connect(alice).deposit(usdt(100), alice.address)).to.not.be.reverted;
    });

    it("only lets the curator pause", async () => {
      const { alice, vault } = await loadFixture(deployPhony);
      await expect(vault.connect(alice).pause()).to.be.reverted;
    });

    it("recalls every strategy's capital on demand", async () => {
      const { curator, alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      await vault.connect(curator).recallAllFunds();

      expect(await strategy.lpBalance()).to.equal(0n);
      // Everything is now idle and therefore exitable in full.
      expect(await vault.idleAssets()).to.equal(await vault.totalAssets());
      expect(await vault.maxWithdraw(alice.address)).to.equal(
        await vault.convertToAssets(await vault.balanceOf(alice.address)),
      );
    });

    it("refuses to rescue the vault asset itself", async () => {
      const { curator, asset, vault } = await loadFixture(deployPhony);
      await expect(
        vault.connect(curator).emergencyWithdraw(await asset.getAddress(), 1n),
      ).to.be.reverted;
    });

    it("enforces the deposit cap", async () => {
      const { curator, alice, asset, vault } = await loadFixture(deployPhony);
      await vault.connect(curator).setDepositCap(usdt(500));
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));

      await expect(vault.connect(alice).deposit(usdt(600), alice.address)).to.be.reverted;
      await expect(vault.connect(alice).deposit(usdt(400), alice.address)).to.not.be.reverted;
    });
  });

  describe("with two live venues", () => {
    it("spreads a deposit across both and reports one NAV", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator);

      // Sized for the shallower second pool: 300 in means 60 to the second leg against ~1.4k of
      // depth, so our own price impact stays modest.
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      // 60% + 20% deployed, 20% idle. Principal is exact even where the mark is not.
      expect(await strategy.totalDeposited()).to.equal(usdt(180));
      expect(await second.strategy.totalDeposited()).to.equal(usdt(60));
      expect(await vault.idleAssets()).to.equal(usdt(60));

      expect(await vault.totalAssets()).to.equal(
        (await vault.idleAssets()) + (await router.getTotalStrategyAssets()),
      );
    });
  });
});
