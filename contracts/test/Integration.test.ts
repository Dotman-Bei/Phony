import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { crashPairedToken, deployPhony, generateTradingFees, usdt } from "./fixtures";

/**
 * End to end, against live BDEX liquidity.
 *
 * These are the claims the project is actually making, so they are tested where a mock cannot
 * help: yield that comes from somebody else's trades, a drawdown caused by a real price move, and
 * a curator with every admin key who still cannot take the money.
 */
describe("Integration", () => {
  describe("the full loop", () => {
    it("runs deposit -> allocate -> harvest -> withdraw against a real pool", async () => {
      const { alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const vaultAddress = await vault.getAddress();

      // Deposit.
      await (asset.connect(alice) as any).approve(vaultAddress, usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(usdt(1_000));

      // Allocate: real LP tokens, from a pair this repo does not own.
      expect(await strategy.lpBalance()).to.be.gt(0n);
      expect(await router.getTotalStrategyAssets()).to.be.gt(0n);

      // Harvest, after other people trade the pair.
      await generateTradingFees();
      const priceBefore = await vault.sharePrice();
      await vault.harvest();
      expect(await vault.sharePrice()).to.be.gte(priceBefore);

      // Withdraw everything the vault says it can free.
      const exitable = await vault.maxWithdraw(alice.address);
      const balanceBefore = await asset.balanceOf(alice.address);
      await vault.connect(alice).withdraw(exitable, alice.address, alice.address);

      expect(await asset.balanceOf(alice.address)).to.equal(balanceBefore + exitable);
      // A round trip through an AMM costs the fee, so ending with slightly less than 1000 is
      // the honest outcome, not a bug. Bound the loss instead of pretending there is none.
      expect(await asset.balanceOf(alice.address)).to.be.gt(usdt(49_970));
    });

    it("keeps NAV equal to idle plus every adapter, at every step", async () => {
      const { alice, asset, vault, router } = await loadFixture(deployPhony);
      const vaultAddress = await vault.getAddress();
      await (asset.connect(alice) as any).approve(vaultAddress, usdt(1_000));

      const check = async () => {
        expect(await vault.totalAssets()).to.equal(
          (await vault.idleAssets()) + (await router.getTotalStrategyAssets()),
        );
      };

      await check();
      await vault.connect(alice).deposit(usdt(600), alice.address);
      await check();
      await generateTradingFees();
      await vault.harvest();
      await check();
      await vault.connect(alice).withdraw(usdt(100), alice.address, alice.address);
      await check();
    });
  });

  describe("a real drawdown", () => {
    it("marks the loss into NAV in the block it happens", async () => {
      const { alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const navBefore = await vault.totalAssets();
      const priceBefore = await vault.sharePrice();

      // Dump WBOT into the pool: its price genuinely falls, and half our position is WBOT.
      await crashPairedToken();

      expect(await strategy.totalAssets()).to.be.lt(usdt(600));
      expect(await vault.totalAssets()).to.be.lt(navBefore);
      expect(await vault.sharePrice()).to.be.lt(priceBefore);
    });

    it("reports zero yield while underwater instead of paying out principal", async () => {
      const { alice, asset, vault, strategy, feeRecipient } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      await crashPairedToken();

      expect(await strategy.totalAssets()).to.be.lt(await strategy.totalDeposited());
      expect(await strategy.pendingYield()).to.equal(0n);

      await vault.harvest();

      expect(await vault.totalYieldHarvested()).to.equal(0n);
      // No fee on a loss. This is the invariant that keeps compounding honest.
      expect(await asset.balanceOf(feeRecipient.address)).to.equal(0n);
    });

    it("still lets a holder exit, at the reduced value", async () => {
      const { alice, asset, vault } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      await crashPairedToken();

      const exitable = await vault.maxWithdraw(alice.address);
      expect(exitable).to.be.gt(0n);
      expect(exitable).to.be.lt(usdt(1_000));

      await expect(vault.connect(alice).withdraw(exitable, alice.address, alice.address)).to.not.be
        .reverted;
    });
  });

  describe("the curator cannot take the money", () => {
    it("survives every admin call in sequence with the curator no richer", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const curatorBefore = await asset.balanceOf(curator.address);
      const navBefore = await vault.totalAssets();

      // Every lever the curator has, in one sequence.
      await vault.connect(curator).setPerformanceFee(2_000n);
      await vault.connect(curator).setDepositCap(usdt(5_000));
      await vault.connect(curator).pause();
      await vault.connect(curator).unpause();
      await router.connect(curator).updateStrategy(0, 5_000n, usdt(1_000), true);
      await router.connect(curator).rebalance();
      await strategy.connect(curator).setMaxSlippage(200n);
      await vault.connect(curator).recallAllFunds();
      await vault.connect(curator).deployIdleFunds();
      await router.connect(curator).removeStrategy(0);

      // Not a single unit of the asset moved to the curator.
      expect(await asset.balanceOf(curator.address)).to.equal(curatorBefore);

      // The depositor's claim survived. Compared against the principal rather than against
      // navBefore, because navBefore includes the entry's paper mark-up, which unwinding removes
      // on top of the real pool fees those moves cost.
      expect(await vault.totalAssets()).to.be.lte(navBefore);
      expect(await vault.totalAssets()).to.be.gt((usdt(1_000) * 98n) / 100n);
      expect(await vault.balanceOf(alice.address)).to.equal(usdt(1_000));
    });

    it("cannot point the vault at a router that does not agree about the asset", async () => {
      const { curator, vault } = await loadFixture(deployPhony);

      // A router built for a different asset must not be installable.
      const rogue = await ethers.deployContract("StrategyRouter", [
        "0xD5452816194a3784dBa983426cCe7c122F4abd30", // WBOT
        await vault.getAddress(),
        curator.address,
      ]);

      await expect(vault.connect(curator).setStrategyRouter(await rogue.getAddress())).to.be
        .reverted;
    });

    it("cannot sweep the vault asset out of a strategy", async () => {
      const { curator, alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      await expect(strategy.connect(curator).sweep(await asset.getAddress())).to.be.reverted;
    });

    it("cannot move a strategy's funds anywhere but back through the router", async () => {
      const { curator, alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      // The adapter only answers the router, even for its owner.
      await expect(strategy.connect(curator).withdraw(usdt(100))).to.be.reverted;
      await expect(strategy.connect(curator).harvest()).to.be.reverted;
    });
  });

  describe("emergency exit", () => {
    it("unwinds to plain asset without changing the depositor's claim or blocking exit", async () => {
      const { curator, alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      const navBefore = await vault.totalAssets();

      await strategy.connect(curator).setEmergencyExit(true);

      // LP gone, value held as the plain asset, and every unit of it now exitable.
      expect(await strategy.lpBalance()).to.equal(0n);
      expect(await strategy.availableLiquidity()).to.equal(await strategy.totalAssets());
      // Below navBefore because the paper mark-up goes with the LP position; above 98% of
      // principal because all that was really paid is one exit through the pool.
      expect(await vault.totalAssets()).to.be.lte(navBefore);
      expect(await vault.totalAssets()).to.be.gt((usdt(1_000) * 98n) / 100n);

      // Withdrawals keep working, and now cost no swap at all.
      const exitable = await vault.maxWithdraw(alice.address);
      await expect(vault.connect(alice).withdraw(exitable, alice.address, alice.address)).to.not.be
        .reverted;
    });

    it("refuses new deposits into a strategy in emergency exit", async () => {
      const { curator, alice, asset, vault, strategy } = await loadFixture(deployPhony);
      await strategy.connect(curator).setEmergencyExit(true);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      // The vault still accepts the deposit; it simply stays idle rather than being deployed.
      await vault.connect(alice).deposit(usdt(500), alice.address);

      expect(await strategy.totalDeposited()).to.equal(0n);
      expect(await vault.idleAssets()).to.equal(usdt(500));
    });

    it("only lets the strategy owner trigger it", async () => {
      const { alice, strategy } = await loadFixture(deployPhony);
      await expect(strategy.connect(alice).setEmergencyExit(true)).to.be.reverted;
    });
  });
});
