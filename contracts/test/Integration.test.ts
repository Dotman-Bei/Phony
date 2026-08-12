import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { BPS, YEAR, closeTo, deployFixture, units } from "./fixtures";

/**
 * The loop the product is judged on: deposit → allocate → harvest → withdraw.
 * These tests run it end to end rather than exercising a single contract.
 */
describe("Integration — the full Phony loop", function () {
  it("runs deposit → allocate → harvest → withdraw and returns more than went in", async function () {
    const { vault, asset, alice, tbillStrategy, creditStrategy, liquidityStrategy } =
      await loadFixture(deployFixture);

    // 1. Deposit
    const principal = units(50_000);
    const balanceBefore = await asset.balanceOf(alice.address);
    await vault.connect(alice).deposit(principal, alice.address);

    const shares = await vault.balanceOf(alice.address);
    expect(shares).to.equal(principal);

    // 2. Allocate — capital is at work across all three legs, buffer held back.
    expect(await tbillStrategy.totalAssets()).to.be.gt(0);
    expect(await creditStrategy.totalAssets()).to.be.gt(0);
    expect(await liquidityStrategy.totalAssets()).to.be.gt(0);
    expect(await vault.idleAssets()).to.equal(units(2_500));

    // 3. Harvest — a year passes, the keeper compounds.
    await time.increase(YEAR);
    await expect(vault.harvest()).to.emit(vault, "Harvested");
    expect(await vault.totalYieldHarvested()).to.be.gt(0);

    // 4. Withdraw — the whole position, principal plus compounded yield.
    await vault.connect(alice).redeem(shares, alice.address, alice.address);

    const returned = (await asset.balanceOf(alice.address)) - balanceBefore;
    expect(returned).to.be.gt(0);
    expect(await vault.balanceOf(alice.address)).to.equal(0);

    // Blended net APY: ~5.7% gross across the deployed 95%, less the 10% fee.
    const netApyBps = (returned * BPS) / principal;
    expect(netApyBps).to.be.gt(400n);
    expect(netApyBps).to.be.lt(600n);
  });

  it("keeps NAV whole across a full cycle — no value leaks into any contract", async function () {
    const { vault, router, asset, alice, bob, tbillStrategy, creditStrategy, liquidityStrategy } =
      await loadFixture(deployFixture);

    await vault.connect(alice).deposit(units(20_000), alice.address);
    await vault.connect(bob).deposit(units(30_000), bob.address);
    await time.increase(YEAR / 2);
    await vault.harvest();
    await vault.connect(alice).withdraw(units(5_000), alice.address, alice.address);
    await time.increase(YEAR / 2);
    await vault.harvest();

    const nav = await vault.totalAssets();
    const parts =
      (await asset.balanceOf(await vault.getAddress())) +
      (await tbillStrategy.totalAssets()) +
      (await creditStrategy.totalAssets()) +
      (await liquidityStrategy.totalAssets());

    expect(nav).to.equal(parts);
    // The router is a conduit, never a holder.
    expect(await asset.balanceOf(await router.getAddress())).to.equal(0);
  });

  it("survives a curator rotating the whole strategy set mid-flight", async function () {
    const { vault, router, owner, alice, asset, tbillStrategy } = await loadFixture(deployFixture);
    await vault.connect(alice).deposit(units(10_000), alice.address);
    await time.increase(YEAR / 4);

    const navBefore = await vault.totalAssets();

    // Retire the credit and liquidity legs, concentrate into T-bills.
    await router.removeStrategy(2);
    await router.removeStrategy(1);
    await router.updateStrategy(0, 9_500, 0, true);
    await router.rebalance();
    await vault.connect(owner).deployIdleFunds();

    expect(await vault.totalAssets()).to.be.gte(navBefore);
    expect(await tbillStrategy.totalAssets()).to.be.gt(0);

    // The depositor is unaffected and can still exit in full.
    const before = await asset.balanceOf(alice.address);
    await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
    expect((await asset.balanceOf(alice.address)) - before).to.be.gt(units(10_000));
  });

  it("lets the curator pause, recall, and resume without loss", async function () {
    const { vault, owner, alice, asset } = await loadFixture(deployFixture);
    await vault.connect(alice).deposit(units(10_000), alice.address);
    await time.increase(YEAR / 4);

    const navBefore = await vault.totalAssets();

    await vault.connect(owner).pause();
    await vault.connect(owner).recallAllFunds();
    expect(await vault.deployedAssets()).to.equal(0);
    expect(await vault.totalAssets()).to.be.gte(navBefore);

    await vault.connect(owner).unpause();
    await vault.connect(owner).deployIdleFunds();
    expect(await vault.deployedAssets()).to.be.gt(0);

    const before = await asset.balanceOf(alice.address);
    await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
    expect((await asset.balanceOf(alice.address)) - before).to.be.gt(units(10_000));
  });

  it("handles three depositors churning in and out over a year", async function () {
    const { vault, asset, alice, bob, carol } = await loadFixture(deployFixture);
    const principals = new Map<string, bigint>();

    for (const user of [alice, bob, carol]) {
      const amount = units(10_000);
      principals.set(user.address, amount);
      await vault.connect(user).deposit(amount, user.address);
    }

    for (let quarter = 0; quarter < 4; quarter++) {
      await time.increase(YEAR / 4);
      await vault.harvest();

      // Bob tops up each quarter; Carol trims.
      await vault.connect(bob).deposit(units(1_000), bob.address);
      principals.set(bob.address, principals.get(bob.address)! + units(1_000));

      const trim = units(500);
      await vault.connect(carol).withdraw(trim, carol.address, carol.address);
      principals.set(carol.address, principals.get(carol.address)! - trim);
    }

    for (const user of [alice, bob, carol]) {
      const before = await asset.balanceOf(user.address);
      await vault.connect(user).redeem(await vault.balanceOf(user.address), user.address, user.address);
      const out = (await asset.balanceOf(user.address)) - before;

      // Everyone ends ahead of the principal still in the vault at the end.
      expect(out).to.be.gt(principals.get(user.address)!);
    }

    expect(await vault.totalSupply()).to.equal(0);
    expect(await vault.totalAssets()).to.be.lt(units("0.01"));
  });

  it("cannot be drained by a curator with full admin rights", async function () {
    const { vault, router, owner, alice, asset, tbillStrategy } = await loadFixture(deployFixture);
    await vault.connect(alice).deposit(units(10_000), alice.address);

    const ownerBefore = await asset.balanceOf(owner.address);

    // Everything the curator is allowed to do, in sequence.
    await vault.connect(owner).setPerformanceFee(2_000);
    await vault.connect(owner).setFeeRecipient(owner.address);
    await vault.connect(owner).recallAllFunds();
    await vault.connect(owner).setStrategyRouter(ethers.ZeroAddress);
    await router.connect(owner).updateStrategy(0, 0, 0, false);
    await tbillStrategy.connect(owner).setEmergencyExit(true);
    await vault.connect(owner).pause();

    // No path moved depositor principal to the curator.
    expect(await asset.balanceOf(owner.address)).to.equal(ownerBefore);

    await vault.connect(owner).unpause();
    const before = await asset.balanceOf(alice.address);
    await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address);
    expect(closeTo((await asset.balanceOf(alice.address)) - before, units(10_000), units(1))).to.equal(true);
  });

  it("prices shares consistently whether yield is harvested or left to accrue", async function () {
    const { vault, owner, alice, bob } = await loadFixture(deployFixture);
    await vault.connect(owner).setPerformanceFee(0);

    await vault.connect(alice).deposit(units(10_000), alice.address);
    await vault.connect(bob).deposit(units(10_000), bob.address);

    await time.increase(YEAR);

    const priceBefore = await vault.sharePrice();
    await vault.harvest();
    const priceAfter = await vault.sharePrice();

    // With no fee, harvesting only moves assets between the sources and the vault. It must
    // not move the share price — that is what makes "auto-compounding" not a rebasing lie.
    expect(closeTo(priceAfter, priceBefore, units("0.001"))).to.equal(true);
  });
});
