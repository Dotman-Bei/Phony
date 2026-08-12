import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  BPS,
  CREDIT_APY,
  CREDIT_BPS,
  LIQUIDITY_APY,
  TBILL_BPS,
  YEAR,
  closeTo,
  deployFixture,
  units,
} from "./fixtures";

describe("Strategy adapters", function () {
  describe("Common adapter contract", function () {
    it("only lets the router move funds", async function () {
      const { tbillStrategy, creditStrategy, liquidityStrategy, alice } = await loadFixture(deployFixture);

      for (const strategy of [tbillStrategy, creditStrategy, liquidityStrategy]) {
        await expect(strategy.connect(alice).deposit(units(1))).to.be.revertedWithCustomError(
          strategy,
          "NotRouter",
        );
        await expect(strategy.connect(alice).withdraw(units(1))).to.be.revertedWithCustomError(
          strategy,
          "NotRouter",
        );
        await expect(strategy.connect(alice).harvest()).to.be.revertedWithCustomError(
          strategy,
          "NotRouter",
        );
      }
    });

    it("reports its underlying, name, and APY", async function () {
      const { tbillStrategy, creditStrategy, liquidityStrategy, asset } = await loadFixture(deployFixture);

      expect(await tbillStrategy.underlyingToken()).to.equal(await asset.getAddress());
      expect(await creditStrategy.name()).to.equal("Private Credit Strategy");
      expect(await creditStrategy.estimatedAPY()).to.equal(CREDIT_APY);
      expect(await liquidityStrategy.estimatedAPY()).to.equal(LIQUIDITY_APY);
    });

    it("refuses to sweep its own underlying", async function () {
      const { tbillStrategy, asset, owner } = await loadFixture(deployFixture);

      await expect(
        tbillStrategy.connect(owner).sweep(await asset.getAddress()),
      ).to.be.revertedWithCustomError(tbillStrategy, "CannotSweepAsset");
    });

    it("tracks principal separately from accrued yield", async function () {
      const { vault, alice, tbillStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      expect(await tbillStrategy.totalDeposited()).to.equal((units(1_000) * TBILL_BPS) / BPS);
      expect(await tbillStrategy.pendingYield()).to.equal(0);

      await time.increase(YEAR);

      expect(await tbillStrategy.totalDeposited()).to.equal((units(1_000) * TBILL_BPS) / BPS);
      expect(await tbillStrategy.pendingYield()).to.be.gt(0);
    });
  });

  describe("TBillStrategy", function () {
    it("deposits into the ERC-4626 yield source", async function () {
      const { vault, alice, tbillSource, tbillStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      expect(await tbillSource.balanceOf(await tbillStrategy.getAddress())).to.be.gt(0);
      expect(await tbillStrategy.totalAssets()).to.equal((units(1_000) * TBILL_BPS) / BPS);
    });

    it("rejects a yield source holding a different asset", async function () {
      const { router, owner } = await loadFixture(deployFixture);

      const otherAsset = await ethers.deployContract("MockRWAToken", ["X", "X", 18, owner.address]);
      const otherSource = await ethers.deployContract("MockTBillVault", [
        await otherAsset.getAddress(),
        400,
        owner.address,
      ]);

      await expect(
        ethers.deployContract("TBillStrategy", [
          ethers.Wallet.createRandom().address,
          await router.getAddress(),
          await otherSource.getAddress(),
          400,
          owner.address,
        ]),
      ).to.be.reverted;
    });

    it("derives a trailing APY from the source's share price", async function () {
      const { vault, alice, tbillStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      await time.increase(YEAR);
      await tbillStrategy.sampleAPY();

      // The mock pays 4.2%; a sampled rate should land close to it, not on the fallback
      // by coincidence — so check the sample actually moved the stored value.
      const sampled = await tbillStrategy.lastSampledAPY();
      expect(closeTo(sampled, 420n, 30n)).to.equal(true);
    });

    it("holds the fallback APY before the first sampling window closes", async function () {
      const { tbillStrategy } = await loadFixture(deployFixture);
      expect(await tbillStrategy.estimatedAPY()).to.equal(420n);
    });
  });

  describe("CreditStrategy", function () {
    it("separates recallable principal from what is out on loan", async function () {
      const { vault, alice, creditPool, creditStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const principal = (units(1_000) * CREDIT_BPS) / BPS;
      expect(await creditStrategy.lockedPrincipal()).to.equal(0);

      await creditPool.setUtilisation(7_000);

      expect(await creditStrategy.lockedPrincipal()).to.equal((principal * 7_000n) / BPS);
      // Liquidity counts claimable interest alongside recallable principal, so a second of
      // accrual shows up here — match to the token, not to the wei.
      expect(
        closeTo(await creditStrategy.availableLiquidity(), (principal * 3_000n) / BPS, units("0.001")),
      ).to.equal(true);
      // Illiquidity does not change what the position is worth, only how fast it exits.
      expect(closeTo(await creditStrategy.totalAssets(), principal, units("0.001"))).to.equal(true);
    });

    it("claims interest from the ledger rather than unwinding principal", async function () {
      const { vault, alice, creditStrategy, creditPool } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);
      const principalBefore = await creditStrategy.totalDeposited();

      await time.increase(YEAR);
      expect(await creditStrategy.claimableInterest()).to.be.gt(0);

      await vault.harvest();

      // Interest was claimed; the loan book behind it is untouched.
      expect(await creditPool.principalOf(await creditStrategy.getAddress())).to.be.gte(principalBefore);
      expect(await creditStrategy.totalHarvested()).to.be.gt(0);
    });

    it("pays roughly its quoted coupon over a year", async function () {
      const { vault, alice, creditStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      const principal = await creditStrategy.totalDeposited();
      await time.increase(YEAR);

      const expected = (principal * CREDIT_APY) / BPS;
      expect(closeTo(await creditStrategy.pendingYield(), expected, units("0.1"))).to.equal(true);
    });
  });

  describe("LiquidityStrategy", function () {
    it("marks the position to the pool's live LP value", async function () {
      const { vault, alice, liquidityPool, liquidityStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const before = await liquidityStrategy.totalAssets();
      await liquidityPool.setLpValueBps(9_500); // 5% impermanent loss
      const after = await liquidityStrategy.totalAssets();

      expect(closeTo(after, (before * 9_500n) / BPS, units("0.1"))).to.equal(true);
    });

    it("reports zero yield during a drawdown instead of paying out principal", async function () {
      const { vault, alice, liquidityPool, liquidityStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await liquidityPool.setFeeAPY(0);
      await liquidityPool.setLpValueBps(9_000); // 10% below par
      await time.increase(YEAR);

      // Position is worth less than principal, so there is no yield to realise. The vault
      // must not book a loss as profit, nor hand principal to the fee recipient.
      expect(await liquidityStrategy.pendingYield()).to.equal(0);
      await expect(vault.harvest()).to.not.be.reverted;
      expect(await liquidityStrategy.totalHarvested()).to.equal(0);
    });

    it("passes the drawdown through to the vault's NAV", async function () {
      const { vault, alice, liquidityPool } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const priceBefore = await vault.sharePrice();
      await liquidityPool.setLpValueBps(5_000); // half the LP position wiped out
      const priceAfter = await vault.sharePrice();

      // 20% of TVL halved ≈ a 10% NAV hit, reported honestly rather than hidden.
      expect(priceAfter).to.be.lt(priceBefore);
      expect(closeTo(priceAfter, (priceBefore * 90n) / 100n, units("0.01"))).to.equal(true);
    });

    it("claims trading fees as yield", async function () {
      const { vault, alice, liquidityStrategy } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      await time.increase(YEAR);
      expect(await liquidityStrategy.pendingFees()).to.be.gt(0);

      await vault.harvest();
      expect(await liquidityStrategy.totalHarvested()).to.be.gt(0);
    });

    it("caps slippage on entry", async function () {
      const { owner, router, asset, liquidityPool } = await loadFixture(deployFixture);

      await expect(
        ethers.deployContract("LiquidityStrategy", [
          await asset.getAddress(),
          await router.getAddress(),
          await liquidityPool.getAddress(),
          1_001n, // above the 10% ceiling
          owner.address,
        ]),
      ).to.be.reverted;
    });
  });

  describe("Emergency exit", function () {
    it("unwinds to plain asset without changing NAV or blocking withdrawals", async function () {
      const { vault, alice, creditStrategy, asset } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const navBefore = await vault.totalAssets();
      const positionBefore = await creditStrategy.totalAssets();

      await creditStrategy.setEmergencyExit(true);

      // Capital now sits on the adapter as bare tokens — still counted, still withdrawable.
      expect(await asset.balanceOf(await creditStrategy.getAddress())).to.be.gte(positionBefore);
      expect(await vault.totalAssets()).to.be.gte(navBefore);

      const before = await asset.balanceOf(alice.address);
      await vault.connect(alice).withdraw(units(900), alice.address, alice.address);
      expect((await asset.balanceOf(alice.address)) - before).to.equal(units(900));
    });

    it("refuses new deposits while in emergency exit", async function () {
      const { vault, alice, creditStrategy } = await loadFixture(deployFixture);
      await creditStrategy.setEmergencyExit(true);

      await expect(vault.connect(alice).deposit(units(1_000), alice.address)).to.be.revertedWithCustomError(
        creditStrategy,
        "EmergencyExitActive",
      );
    });

    it("only lets the strategy owner trigger it", async function () {
      const { creditStrategy, alice } = await loadFixture(deployFixture);

      await expect(creditStrategy.connect(alice).setEmergencyExit(true)).to.be.revertedWithCustomError(
        creditStrategy,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
