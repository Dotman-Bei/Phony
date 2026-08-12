import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import {
  BPS,
  CREDIT_BPS,
  LIQUIDITY_BPS,
  RESERVE_BPS,
  TBILL_BPS,
  YEAR,
  closeTo,
  deployFixture,
  deployIlliquidCreditFixture,
  units,
} from "./fixtures";

describe("BotVault", function () {
  describe("Deployment", function () {
    it("exposes ERC-4626 metadata for the tokenized RWA it wraps", async function () {
      const { vault, asset } = await loadFixture(deployFixture);

      expect(await vault.name()).to.equal("Phony RWA Vault");
      expect(await vault.symbol()).to.equal("brRWA");
      expect(await vault.asset()).to.equal(await asset.getAddress());
      expect(await vault.decimals()).to.equal(await asset.decimals());
      expect(await vault.totalAssets()).to.equal(0);
    });

    it("starts at a 1:1 share price", async function () {
      const { vault } = await loadFixture(deployFixture);
      expect(await vault.sharePrice()).to.equal(units(1));
    });

    it("defaults to a 10% performance fee, capped at 20%", async function () {
      const { vault, owner } = await loadFixture(deployFixture);

      expect(await vault.performanceFeeBps()).to.equal(1_000n);
      await expect(vault.connect(owner).setPerformanceFee(2_001n))
        .to.be.revertedWithCustomError(vault, "FeeTooHigh")
        .withArgs(2_001n, 2_000n);
    });
  });

  describe("Deposit", function () {
    it("mints shares 1:1 on the first deposit", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      const amount = units(1_000);

      await expect(vault.connect(alice).deposit(amount, alice.address))
        .to.emit(vault, "Deposit")
        .withArgs(alice.address, alice.address, amount, amount);

      expect(await vault.balanceOf(alice.address)).to.equal(amount);
      expect(await vault.totalAssets()).to.equal(amount);
    });

    it("routes the deposit across strategies by allocation weight", async function () {
      const { vault, alice, tbillStrategy, creditStrategy, liquidityStrategy } =
        await loadFixture(deployFixture);
      const amount = units(1_000);

      await vault.connect(alice).deposit(amount, alice.address);

      expect(await tbillStrategy.totalAssets()).to.equal((amount * TBILL_BPS) / BPS);
      expect(await creditStrategy.totalAssets()).to.equal((amount * CREDIT_BPS) / BPS);
      expect(await liquidityStrategy.totalAssets()).to.equal((amount * LIQUIDITY_BPS) / BPS);
    });

    it("leaves the unallocated remainder in the vault as the reserve buffer", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      const amount = units(1_000);

      await vault.connect(alice).deposit(amount, alice.address);

      expect(await vault.idleAssets()).to.equal((amount * RESERVE_BPS) / BPS);
      expect(await vault.deployedAssets()).to.equal((amount * (BPS - RESERVE_BPS)) / BPS);
      // The split is bookkeeping, not leakage: NAV still equals what went in.
      expect(await vault.totalAssets()).to.equal(amount);
    });

    it("prices the second depositor off the live NAV", async function () {
      const { vault, alice, bob } = await loadFixture(deployFixture);

      await vault.connect(alice).deposit(units(1_000), alice.address);
      await time.increase(YEAR);

      const previewed = await vault.previewDeposit(units(1_000));
      await vault.connect(bob).deposit(units(1_000), bob.address);

      // One extra second of accrual lands between the preview and the mined deposit, so
      // match to a few wei rather than exactly — the claim is that the quote is live NAV.
      expect(closeTo(await vault.balanceOf(bob.address), previewed, units("0.00001"))).to.equal(true);
      // Yield accrued to Alice before Bob arrived, so his shares cost more than 1:1.
      expect(await vault.balanceOf(bob.address)).to.be.lt(await vault.balanceOf(alice.address));
    });

    it("honours the deposit cap", async function () {
      const { vault, owner, alice } = await loadFixture(deployFixture);
      await vault.connect(owner).setDepositCap(units(1_000));

      await vault.connect(alice).deposit(units(600), alice.address);
      expect(await vault.maxDeposit(alice.address)).to.equal(units(400));

      // ERC-4626 checks `maxDeposit` before handing off to `_deposit`, so the cap surfaces
      // through the standard's own error. The internal `DepositCapExceeded` guard stays as
      // a backstop for any future path that reaches `_deposit` without that check.
      await expect(vault.connect(alice).deposit(units(500), alice.address)).to.be.revertedWithCustomError(
        vault,
        "ERC4626ExceededMaxDeposit",
      );
    });
  });

  describe("Mint", function () {
    it("charges the assets that previewMint quotes", async function () {
      const { vault, asset, alice } = await loadFixture(deployFixture);
      const shares = units(500);

      const quoted = await vault.previewMint(shares);
      const before = await asset.balanceOf(alice.address);
      await vault.connect(alice).mint(shares, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(shares);
      expect(before - (await asset.balanceOf(alice.address))).to.equal(quoted);
    });
  });

  describe("Withdraw and redeem", function () {
    it("returns principal from the reserve buffer without unwinding strategies", async function () {
      const { vault, asset, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const deployedBefore = await vault.deployedAssets();
      const balanceBefore = await asset.balanceOf(alice.address);

      // 50 is inside the 5% (= 50 token) buffer.
      await expect(vault.connect(alice).withdraw(units(50), alice.address, alice.address)).to.not.emit(
        vault,
        "FundsRecalled",
      );

      expect((await asset.balanceOf(alice.address)) - balanceBefore).to.equal(units(50));
      // Nothing was unwound — the deployed balance only moved by the accrual of one block.
      expect(await vault.deployedAssets()).to.be.gte(deployedBefore);
    });

    it("recalls from strategies when the buffer is not enough", async function () {
      const { vault, asset, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const balanceBefore = await asset.balanceOf(alice.address);
      await expect(vault.connect(alice).withdraw(units(800), alice.address, alice.address)).to.emit(
        vault,
        "FundsRecalled",
      );

      expect((await asset.balanceOf(alice.address)) - balanceBefore).to.equal(units(800));
    });

    it("pulls back proportionally, preserving the allocation split", async function () {
      const { vault, alice, tbillStrategy, creditStrategy, liquidityStrategy } =
        await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await vault.connect(alice).withdraw(units(500), alice.address, alice.address);

      const tbill = await tbillStrategy.totalAssets();
      const credit = await creditStrategy.totalAssets();
      const liquidity = await liquidityStrategy.totalAssets();
      const deployed = tbill + credit + liquidity;

      // Each leg keeps the share of *deployed* capital it started with: 40/35/20 of 95.
      const deployedTotalBps = BPS - RESERVE_BPS;
      expect(closeTo((tbill * BPS) / deployed, (TBILL_BPS * BPS) / deployedTotalBps, 5n)).to.equal(true);
      expect(closeTo((credit * BPS) / deployed, (CREDIT_BPS * BPS) / deployedTotalBps, 5n)).to.equal(true);
      expect(closeTo((liquidity * BPS) / deployed, (LIQUIDITY_BPS * BPS) / deployedTotalBps, 5n)).to.equal(
        true,
      );

      // The buffer is spent first and refills on the next deposit, so after a withdrawal
      // this large everything remaining is at work.
      expect(closeTo(deployed, units(500), units(1))).to.equal(true);
    });

    it("redeems the full position and burns every share", async function () {
      const { vault, asset, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const shares = await vault.balanceOf(alice.address);
      const before = await asset.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);

      expect(await vault.balanceOf(alice.address)).to.equal(0);
      expect((await asset.balanceOf(alice.address)) - before).to.be.gte(units(1_000) - 10n);
    });

    it("requires an allowance to withdraw on someone else's behalf", async function () {
      const { vault, alice, bob } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await expect(
        vault.connect(bob).withdraw(units(100), bob.address, alice.address),
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");

      await vault.connect(alice).approve(bob.address, units(200));
      await expect(vault.connect(bob).withdraw(units(100), bob.address, alice.address)).to.not.be.reverted;
    });
  });

  describe("Liquidity-aware maxima", function () {
    it("caps maxWithdraw at what the strategies can actually free", async function () {
      // 80% of credit principal is out on loan and cannot be recalled this block.
      const { vault, alice } = await loadFixture(deployIlliquidCreditFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const maxWithdraw = await vault.maxWithdraw(alice.address);

      // Buffer 50 + T-bill 400 + liquidity 200 + 20% of the 350 credit leg = 720.
      expect(closeTo(maxWithdraw, units(720), units(1))).to.equal(true);
      expect(maxWithdraw).to.be.lt(await vault.convertToAssets(await vault.balanceOf(alice.address)));
    });

    it("reverts rather than silently short-paying an oversized withdrawal", async function () {
      const { vault, alice } = await loadFixture(deployIlliquidCreditFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await expect(
        vault.connect(alice).withdraw(units(900), alice.address, alice.address),
      ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxWithdraw");
    });

    it("still pays out everything the strategies can free", async function () {
      const { vault, asset, alice } = await loadFixture(deployIlliquidCreditFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const withdrawable = await vault.maxWithdraw(alice.address);
      const before = await asset.balanceOf(alice.address);
      await vault.connect(alice).withdraw(withdrawable, alice.address, alice.address);

      expect((await asset.balanceOf(alice.address)) - before).to.equal(withdrawable);
    });
  });

  describe("Harvest and auto-compounding", function () {
    it("raises the share price as strategies accrue, with no user action", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);

      const before = await vault.sharePrice();
      await time.increase(YEAR);
      const after = await vault.sharePrice();

      expect(after).to.be.gt(before);
      // Weighted blend of 4.2/8.0/6.5 over 95% deployed ≈ 5.7% — comfortably inside 3–8%.
      const growthBps = ((after - before) * BPS) / before;
      expect(growthBps).to.be.gt(300n);
      expect(growthBps).to.be.lt(800n);
    });

    it("realises yield into the vault and charges the performance fee", async function () {
      const { vault, asset, treasury, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);
      await time.increase(YEAR);

      const treasuryBefore = await asset.balanceOf(treasury.address);
      await expect(vault.harvest()).to.emit(vault, "Harvested");
      const feeTaken = (await asset.balanceOf(treasury.address)) - treasuryBefore;

      expect(feeTaken).to.be.gt(0);
      expect(await vault.totalYieldHarvested()).to.be.gt(0);
      // The fee is 10% of yield, so it must be a small slice of a ~5.7% annual gain.
      expect(feeTaken).to.be.lt(units(10_000) / 100n);
    });

    it("compounds harvested yield back into the strategies", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(10_000), alice.address);
      await time.increase(YEAR);

      const deployedBefore = await vault.deployedAssets();
      await vault.harvest();

      // Harvest pulls yield out of the sources and immediately re-deploys it, so the
      // amount at work ends up higher than before rather than lower.
      expect(await vault.deployedAssets()).to.be.gt(deployedBefore);
    });

    it("leaves depositors better off than holding the raw RWA token", async function () {
      const { vault, asset, alice, bob } = await loadFixture(deployFixture);

      const bobBefore = await asset.balanceOf(bob.address); // Bob just holds.
      await vault.connect(alice).deposit(units(10_000), alice.address);

      await time.increase(YEAR);
      await vault.harvest();

      const aliceValue = await vault.convertToAssets(await vault.balanceOf(alice.address));
      expect(aliceValue).to.be.gt(units(10_000));
      expect(await asset.balanceOf(bob.address)).to.equal(bobBefore);
    });

    it("is a no-op, not a revert, when nothing has accrued", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await expect(vault.harvest()).to.not.be.reverted;
    });

    it("sends no fee when the fee is set to zero", async function () {
      const { vault, asset, owner, treasury, alice } = await loadFixture(deployFixture);
      await vault.connect(owner).setPerformanceFee(0);
      await vault.connect(alice).deposit(units(10_000), alice.address);
      await time.increase(YEAR);

      const before = await asset.balanceOf(treasury.address);
      await vault.harvest();

      expect(await asset.balanceOf(treasury.address)).to.equal(before);
    });
  });

  describe("Pause", function () {
    it("blocks deposits and withdrawals while paused", async function () {
      const { vault, owner, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await vault.connect(owner).pause();

      await expect(vault.connect(alice).deposit(units(1), alice.address)).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause",
      );
      await expect(
        vault.connect(alice).withdraw(units(1), alice.address, alice.address),
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      expect(await vault.maxDeposit(alice.address)).to.equal(0);
      expect(await vault.maxWithdraw(alice.address)).to.equal(0);
    });

    it("resumes cleanly on unpause", async function () {
      const { vault, owner, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await vault.connect(owner).pause();
      await vault.connect(owner).unpause();

      await expect(vault.connect(alice).deposit(units(100), alice.address)).to.not.be.reverted;
    });
  });

  describe("Curator controls", function () {
    it("restricts admin functions to the owner", async function () {
      const { vault, alice } = await loadFixture(deployFixture);

      for (const call of [
        vault.connect(alice).pause(),
        vault.connect(alice).setPerformanceFee(100),
        vault.connect(alice).setFeeRecipient(alice.address),
        vault.connect(alice).setDepositCap(units(1)),
        vault.connect(alice).setStrategyRouter(ethers.ZeroAddress),
        vault.connect(alice).recallAllFunds(),
      ]) {
        await expect(call).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      }
    });

    it("recalls every deployed asset without moving the share price", async function () {
      const { vault, owner, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      const priceBefore = await vault.sharePrice();
      await vault.connect(owner).recallAllFunds();

      expect(await vault.deployedAssets()).to.equal(0);
      // A block of accrual lands during the recall, so allow 0.1% rather than exact
      // equality. The point is that unwinding does not destroy value, not that time stops.
      expect(closeTo(await vault.sharePrice(), priceBefore, units("0.001"))).to.equal(true);
      expect(closeTo(await vault.idleAssets(), units(1_000), units(1))).to.equal(true);
    });

    it("drains the old router before switching to a new one", async function () {
      const { vault, router, owner, alice, asset } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await expect(vault.connect(owner).setStrategyRouter(ethers.ZeroAddress))
        .to.emit(vault, "StrategyRouterUpdated")
        .withArgs(await router.getAddress(), ethers.ZeroAddress);

      expect(await router.getTotalStrategyAssets()).to.equal(0);
      expect(closeTo(await asset.balanceOf(await vault.getAddress()), units(1_000), units(1))).to.equal(true);
    });

    it("rejects a router bound to a different vault or asset", async function () {
      const { vault, asset, owner, alice } = await loadFixture(deployFixture);

      const foreignRouter = await ethers.deployContract("StrategyRouter", [
        await asset.getAddress(),
        alice.address, // bound to something that is not this vault
        owner.address,
      ]);

      await expect(
        vault.connect(owner).setStrategyRouter(await foreignRouter.getAddress()),
      ).to.be.revertedWithCustomError(vault, "RouterVaultMismatch");
    });

    it("refuses to sweep the vault asset", async function () {
      const { vault, asset, owner, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(units(1_000), alice.address);

      await expect(
        vault.connect(owner).emergencyWithdraw(await asset.getAddress(), units(1)),
      ).to.be.revertedWithCustomError(vault, "CannotSweepAsset");
    });

    it("rescues an unrelated token sent to the vault by mistake", async function () {
      const { vault, owner } = await loadFixture(deployFixture);

      const stray = await ethers.deployContract("MockRWAToken", ["Stray", "STRAY", 18, owner.address]);
      await stray.mint(await vault.getAddress(), units(5));

      await expect(vault.connect(owner).emergencyWithdraw(await stray.getAddress(), units(5)))
        .to.emit(vault, "EmergencyWithdraw")
        .withArgs(await stray.getAddress(), units(5));

      expect(await stray.balanceOf(owner.address)).to.equal(units(5));
    });
  });

  describe("Multi-user share accounting", function () {
    it("splits accrued yield in proportion to time and size", async function () {
      const { vault, alice, bob } = await loadFixture(deployFixture);

      await vault.connect(alice).deposit(units(10_000), alice.address);
      await time.increase(YEAR / 2);
      await vault.connect(bob).deposit(units(10_000), bob.address);
      await time.increase(YEAR / 2);

      const aliceValue = await vault.convertToAssets(await vault.balanceOf(alice.address));
      const bobValue = await vault.convertToAssets(await vault.balanceOf(bob.address));

      // Alice was in for the whole year, Bob for half. Both gained; Alice gained more.
      expect(aliceValue).to.be.gt(units(10_000));
      expect(bobValue).to.be.gt(units(10_000));
      expect(aliceValue).to.be.gt(bobValue);
    });

    it("does not let a late depositor capture yield earned before they arrived", async function () {
      const { vault, alice, bob } = await loadFixture(deployFixture);

      await vault.connect(alice).deposit(units(10_000), alice.address);
      await time.increase(YEAR);
      await vault.connect(bob).deposit(units(10_000), bob.address);

      const bobValue = await vault.convertToAssets(await vault.balanceOf(bob.address));
      // Bob's position is worth what he paid, give or take rounding — not a share of
      // Alice's year. This is the inflation/backrun check that matters for a yield vault.
      expect(closeTo(bobValue, units(10_000), units(1))).to.equal(true);
    });

    it("lets everyone exit with more than they put in", async function () {
      const { vault, asset, alice, bob, carol } = await loadFixture(deployFixture);

      for (const user of [alice, bob, carol]) {
        await vault.connect(user).deposit(units(5_000), user.address);
      }
      await time.increase(YEAR);
      await vault.harvest();

      for (const user of [alice, bob, carol]) {
        const before = await asset.balanceOf(user.address);
        await vault.connect(user).redeem(await vault.balanceOf(user.address), user.address, user.address);
        expect((await asset.balanceOf(user.address)) - before).to.be.gt(units(5_000));
      }

      expect(await vault.totalSupply()).to.equal(0);
    });
  });
});
