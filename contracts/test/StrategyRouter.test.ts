import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  BPS,
  CREDIT_APY,
  CREDIT_BPS,
  LIQUIDITY_APY,
  LIQUIDITY_BPS,
  RESERVE_BPS,
  TBILL_APY,
  TBILL_BPS,
  YEAR,
  closeTo,
  deployBareFixture,
  deployFixture,
  units,
} from "./fixtures";

describe("StrategyRouter", function () {
  describe("Whitelisting", function () {
    it("registers a strategy and tracks total allocation", async function () {
      const { router, tbillStrategy } = await loadFixture(deployBareFixture);

      await expect(router.addStrategy(await tbillStrategy.getAddress(), 4_000, 0))
        .to.emit(router, "StrategyAdded")
        .withArgs(0, await tbillStrategy.getAddress(), 4_000, 0);

      expect(await router.strategyCount()).to.equal(1);
      expect(await router.totalAllocationBps()).to.equal(4_000);
    });

    it("rejects allocations that would exceed 100%", async function () {
      const { router, tbillStrategy, creditStrategy } = await loadFixture(deployBareFixture);

      await router.addStrategy(await tbillStrategy.getAddress(), 7_000, 0);
      await expect(router.addStrategy(await creditStrategy.getAddress(), 4_000, 0))
        .to.be.revertedWithCustomError(router, "AllocationExceedsMax")
        .withArgs(11_000, 10_000);
    });

    it("rejects an adapter whose underlying is not the vault asset", async function () {
      const { router, owner, alice } = await loadFixture(deployBareFixture);

      const otherAsset = await ethers.deployContract("MockRWAToken", [
        "Other",
        "OTHER",
        18,
        owner.address,
      ]);
      const otherPool = await ethers.deployContract("MockCreditPool", [
        await otherAsset.getAddress(),
        500,
        0,
        owner.address,
      ]);
      const foreign = await ethers.deployContract("CreditStrategy", [
        await otherAsset.getAddress(),
        await router.getAddress(),
        await otherPool.getAddress(),
        owner.address,
      ]);

      await expect(router.addStrategy(await foreign.getAddress(), 1_000, 0)).to.be.revertedWithCustomError(
        router,
        "AdapterAssetMismatch",
      );
      void alice;
    });

    it("refuses to register the same adapter twice", async function () {
      const { router, tbillStrategy } = await loadFixture(deployBareFixture);

      await router.addStrategy(await tbillStrategy.getAddress(), 3_000, 0);
      await expect(router.addStrategy(await tbillStrategy.getAddress(), 1_000, 0))
        .to.be.revertedWithCustomError(router, "AdapterAlreadyRegistered")
        .withArgs(await tbillStrategy.getAddress());
    });

    it("only lets the curator manage the whitelist", async function () {
      const { router, tbillStrategy, alice } = await loadFixture(deployBareFixture);

      await expect(
        router.connect(alice).addStrategy(await tbillStrategy.getAddress(), 1_000, 0),
      ).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
      await expect(router.connect(alice).rebalance()).to.be.revertedWithCustomError(
        router,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Routing", function () {
    it("only accepts routing calls from the vault", async function () {
      const { router, alice } = await loadFixture(deployFixture);

      await expect(router.connect(alice).routeDeposit(units(100))).to.be.revertedWithCustomError(
        router,
        "NotVault",
      );
      await expect(router.connect(alice).routeWithdraw(units(100))).to.be.revertedWithCustomError(
        router,
        "NotVault",
      );
    });

    it("skips deactivated strategies when placing new deposits", async function () {
      const { router, vault, alice, creditStrategy } = await loadFixture(deployFixture);

      await router.updateStrategy(1, CREDIT_BPS, 0, false);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      expect(await creditStrategy.totalAssets()).to.equal(0);
      // The credit leg's 35% falls back to the vault's idle buffer rather than piling into
      // the remaining strategies — weights are absolute, not renormalised.
      expect(await vault.idleAssets()).to.equal((units(1_000) * (RESERVE_BPS + CREDIT_BPS)) / BPS);
    });

    it("respects per-strategy deposit caps", async function () {
      const { router, vault, alice, tbillStrategy } = await loadFixture(deployFixture);

      await router.updateStrategy(0, TBILL_BPS, units(100), true);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      // The T-bill leg wanted 400 but is capped at 100; the other 300 stays in the buffer.
      expect(await tbillStrategy.totalAssets()).to.equal(units(100));
      expect(await vault.idleAssets()).to.equal(units(50) + units(300));
      expect(await vault.totalAssets()).to.equal(units(1_000));
    });

    it("never leaves capital resting in the router", async function () {
      const { router, vault, asset, alice } = await loadFixture(deployFixture);

      await vault.connect(alice).deposit(units(1_000), alice.address);
      expect(await asset.balanceOf(await router.getAddress())).to.equal(0);

      await vault.connect(alice).withdraw(units(700), alice.address, alice.address);
      expect(await asset.balanceOf(await router.getAddress())).to.equal(0);

      await time.increase(YEAR);
      await vault.harvest();
      expect(await asset.balanceOf(await router.getAddress())).to.equal(0);
    });
  });

  describe("Removal", function () {
    it("returns the retired strategy's capital to the vault", async function () {
      const { router, vault, alice, tbillStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const navBefore = await vault.totalAssets();
      await expect(router.removeStrategy(0)).to.emit(router, "StrategyRemoved");

      expect(await tbillStrategy.totalAssets()).to.equal(0);
      expect(await router.totalAllocationBps()).to.equal(CREDIT_BPS + LIQUIDITY_BPS);
      // NAV is preserved — the capital moved, it did not disappear.
      expect(await vault.totalAssets()).to.be.gte(navBefore);
    });

    it("refuses to retire a strategy it cannot fully unwind", async function () {
      const { router, vault, creditPool, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      // Borrowers draw down after the capital is already lent: 80% is now unrecallable.
      // Removing the strategy here would drop live assets out of NAV, so it must revert.
      await creditPool.setUtilisation(8_000);

      await expect(router.removeStrategy(1)).to.be.revertedWithCustomError(router, "StrategyNotEmpty");
    });

    it("frees the adapter address for re-registration", async function () {
      const { router, tbillStrategy } = await loadFixture(deployFixture);

      await router.removeStrategy(0);
      await expect(router.addStrategy(await tbillStrategy.getAddress(), TBILL_BPS, 0)).to.not.be.reverted;
      expect(await router.strategyCount()).to.equal(4);
    });
  });

  describe("Rebalancing", function () {
    it("pulls drifted allocations back to their target weights", async function () {
      const { router, vault, alice, tbillStrategy, creditStrategy, liquidityStrategy } =
        await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      // Re-weight hard: the T-bill leg should end up dominant.
      // Lower the outgoing legs before raising the incoming one — the running total is
      // checked on every call, so the order matters.
      await router.updateStrategy(1, 1_000, 0, true);
      await router.updateStrategy(2, 500, 0, true);
      await router.updateStrategy(0, 8_000, 0, true);

      await expect(router.rebalance()).to.emit(router, "Rebalanced");

      const tbill = await tbillStrategy.totalAssets();
      const credit = await creditStrategy.totalAssets();
      const liquidity = await liquidityStrategy.totalAssets();
      const deployed = tbill + credit + liquidity;

      // Targets normalise against totalAllocationBps (9500), not 10000.
      expect(closeTo((tbill * BPS) / deployed, (8_000n * BPS) / 9_500n, 20n)).to.equal(true);
      expect(closeTo((credit * BPS) / deployed, (1_000n * BPS) / 9_500n, 20n)).to.equal(true);
      expect(closeTo((liquidity * BPS) / deployed, (500n * BPS) / 9_500n, 20n)).to.equal(true);
    });

    it("does not change NAV", async function () {
      const { router, vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      const before = await vault.totalAssets();
      // Lower the outgoing legs before raising the incoming one — the running total is
      // checked on every call, so the order matters.
      await router.updateStrategy(1, 1_000, 0, true);
      await router.updateStrategy(2, 500, 0, true);
      await router.updateStrategy(0, 8_000, 0, true);
      await router.rebalance();

      expect(closeTo(await vault.totalAssets(), before, units("0.01"))).to.equal(true);
    });

    it("empties a strategy that has been deactivated", async function () {
      const { router, vault, alice, creditStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      expect(await creditStrategy.totalAssets()).to.be.gt(0);
      await router.updateStrategy(1, 0, 0, false);
      await router.rebalance();

      expect(await creditStrategy.totalAssets()).to.equal(0);
    });
  });

  describe("Views", function () {
    it("reports a TVL-weighted APY across live strategies", async function () {
      const { router, vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      const expected =
        (TBILL_BPS * TBILL_APY + CREDIT_BPS * CREDIT_APY + LIQUIDITY_BPS * LIQUIDITY_APY) /
        (TBILL_BPS + CREDIT_BPS + LIQUIDITY_BPS);

      expect(closeTo(await router.weightedAPY(), expected, 5n)).to.equal(true);
    });

    it("returns zero weighted APY on an empty router", async function () {
      const { router } = await loadFixture(deployFixture);
      expect(await router.weightedAPY()).to.equal(0);
    });

    it("packs the strategy explorer payload into one call", async function () {
      const { router, vault, alice, tbillStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const info = await router.getStrategiesInfo();

      expect(info.adapters.length).to.equal(3);
      expect(info.adapters[0]).to.equal(await tbillStrategy.getAddress());
      expect(info.names[0]).to.equal("T-Bill Strategy");
      expect(info.names[1]).to.equal("Private Credit Strategy");
      expect(info.names[2]).to.equal("RWA Liquidity Strategy");
      expect(info.allocationsBps[1]).to.equal(CREDIT_BPS);
      expect(info.assets[0]).to.equal((units(1_000) * TBILL_BPS) / BPS);
      expect(info.actives[2]).to.equal(true);
    });

    it("leaves a hole rather than reindexing when a strategy is removed", async function () {
      const { router, vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await router.removeStrategy(1);
      const info = await router.getStrategiesInfo();

      // Ids stay stable so the frontend's cached rows do not shift under it.
      expect(info.adapters.length).to.equal(3);
      expect(info.adapters[1]).to.equal(ethers.ZeroAddress);
      expect(info.adapters[2]).to.not.equal(ethers.ZeroAddress);
    });
  });
});
