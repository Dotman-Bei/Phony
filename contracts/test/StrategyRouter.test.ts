import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { ADDRESSES, addSecondLeg, deployPhony, usdt } from "./fixtures";

/**
 * StrategyRouter — with two live BDEX venues behind it.
 *
 * Weights, caps, proportional withdrawal and rebalancing say nothing about a router holding one
 * strategy, and there is no mock adapter here to stand a second one up with. So the second leg is
 * another real pair, which has a consequence worth stating: rebalancing moves capital through two
 * pools and pays their fees, so NAV legitimately falls a little every time. A mock would have made
 * these assertions exact and would have hidden that cost.
 */
describe("StrategyRouter", () => {
  describe("whitelisting", () => {
    it("registers a strategy and tracks total allocation", async () => {
      const { router, strategy } = await loadFixture(deployPhony);

      expect(await router.strategyCount()).to.equal(1n);
      expect(await router.totalAllocationBps()).to.equal(6_000n);

      const [adapters] = await router.getStrategiesInfo();
      expect(adapters[0]).to.equal(await strategy.getAddress());
    });

    it("rejects an allocation that would exceed 100%", async () => {
      const { curator, router } = await loadFixture(deployPhony);

      // 6000 already allocated; another 4001 would overshoot.
      await expect(addSecondLeg(router, curator, 4_001n)).to.be.reverted;
      await expect(addSecondLeg(router, curator, 4_000n)).to.not.be.reverted;
      expect(await router.totalAllocationBps()).to.equal(10_000n);
    });

    it("rejects an adapter whose underlying is not the vault asset", async () => {
      const { curator, router, pairAddress } = await loadFixture(deployPhony);

      // Same real pair, but this adapter takes WBOT as its asset rather than USDT.
      const wrong = await ethers.deployContract("BdexV2LpStrategy", [
        ADDRESSES.wbot,
        await router.getAddress(),
        ADDRESSES.dexRouter,
        pairAddress,
        100n,
        "wrong underlying",
        curator.address,
      ]);

      await expect(
        router.connect(curator).addStrategy(await wrong.getAddress(), 1_000n, usdt(100)),
      ).to.be.reverted;
    });

    it("refuses to register the same adapter twice", async () => {
      const { curator, router, strategy } = await loadFixture(deployPhony);

      await expect(
        router.connect(curator).addStrategy(await strategy.getAddress(), 1_000n, usdt(100)),
      ).to.be.reverted;
    });

    it("only lets the curator manage the whitelist", async () => {
      const { alice, router, strategy } = await loadFixture(deployPhony);

      await expect(
        router.connect(alice).addStrategy(await strategy.getAddress(), 1_000n, usdt(100)),
      ).to.be.reverted;
      await expect(router.connect(alice).removeStrategy(0)).to.be.reverted;
      await expect(router.connect(alice).updateStrategy(0, 5_000n, usdt(100), true)).to.be.reverted;
    });
  });

  describe("routing", () => {
    it("only accepts routing calls from the vault", async () => {
      const { alice, curator, router } = await loadFixture(deployPhony);

      await expect(router.connect(alice).routeDeposit(usdt(10))).to.be.reverted;
      await expect(router.connect(curator).routeDeposit(usdt(10))).to.be.reverted;
    });

    it("splits a deposit across two venues by weight", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      expect(await strategy.totalDeposited()).to.equal(usdt(180));
      expect(await second.strategy.totalDeposited()).to.equal(usdt(60));
    });

    it("skips a deactivated strategy when placing new deposits", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await router.connect(curator).updateStrategy(0, 6_000n, usdt(2_000), false);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      expect(await strategy.totalDeposited()).to.equal(0n);
      expect(await second.strategy.totalDeposited()).to.equal(usdt(60));
    });

    it("respects a per-strategy cap and leaves the excess idle", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);

      await router.connect(curator).updateStrategy(0, 6_000n, usdt(100), true);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
      await vault.connect(alice).deposit(usdt(1_000), alice.address);

      // 60% of 1000 is 600, but the cap is 100.
      expect(await strategy.totalDeposited()).to.equal(usdt(100));
      expect(await vault.idleAssets()).to.equal(usdt(900));
    });

    it("never leaves capital resting in the router", async () => {
      const { curator, alice, asset, vault, router } = await loadFixture(deployPhony);
      await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);
      await vault.connect(alice).withdraw(usdt(50), alice.address, alice.address);

      expect(await asset.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("draws a large withdrawal from both venues", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      const firstBefore = await strategy.totalAssets();
      const secondBefore = await second.strategy.totalAssets();

      // More than the 60 idle, so strategies must be unwound proportionally.
      await vault.connect(alice).withdraw(usdt(200), alice.address, alice.address);

      expect(await strategy.totalAssets()).to.be.lt(firstBefore);
      expect(await second.strategy.totalAssets()).to.be.lt(secondBefore);
    });
  });

  describe("removal", () => {
    it("returns the retired strategy's capital to the vault", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(500));
      await vault.connect(alice).deposit(usdt(500), alice.address);

      const navBefore = await vault.totalAssets();
      await router.connect(curator).removeStrategy(0);

      expect(await strategy.totalAssets()).to.equal(0n);
      expect(await strategy.lpBalance()).to.equal(0n);
      expect(await vault.idleAssets()).to.equal(await vault.totalAssets());
      // Unwinding pays the pool's fee, so NAV falls by the round trip and no more.
      expect(await vault.totalAssets()).to.be.closeTo(navBefore, usdt(5));
      expect(await router.totalAllocationBps()).to.equal(0n);
    });

    it("frees the adapter address for re-registration", async () => {
      const { curator, router, strategy } = await loadFixture(deployPhony);

      await router.connect(curator).removeStrategy(0);
      await expect(
        router.connect(curator).addStrategy(await strategy.getAddress(), 6_000n, usdt(2_000)),
      ).to.not.be.reverted;
    });

    it("leaves a hole rather than reindexing, so ids stay stable", async () => {
      const { curator, router } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await router.connect(curator).removeStrategy(0);

      const [adapters] = await router.getStrategiesInfo();
      expect(adapters[0]).to.equal(ethers.ZeroAddress);
      expect(adapters[1]).to.equal(await second.strategy.getAddress());
      expect(await router.strategyCount()).to.equal(2n);
    });
  });

  describe("rebalancing", () => {
    it("pulls drifted allocations back toward their targets", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      // Flip the weights: the small leg becomes the large one.
      await router.connect(curator).updateStrategy(0, 2_000n, usdt(2_000), true);
      await router.connect(curator).updateStrategy(1, 6_000n, usdt(2_000), true);

      const firstBefore = await strategy.totalAssets();
      await router.connect(curator).rebalance();

      // Capital left the over-weight leg.
      expect(await strategy.totalAssets()).to.be.lt(firstBefore);
      expect(await second.strategy.totalAssets()).to.be.gt(0n);
    });

    it("costs the round trip through the pools and nothing more", async () => {
      const { curator, alice, asset, vault, router } = await loadFixture(deployPhony);
      await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      const navBefore = await vault.totalAssets();
      const supplyBefore = await vault.totalSupply();

      await router.connect(curator).rebalance();

      // Real pools charge for this; a mock would have shown NAV unchanged. What must not move is
      // the share count — a rebalance is not a mint.
      expect(await vault.totalSupply()).to.equal(supplyBefore);
      expect(await vault.totalAssets()).to.be.closeTo(navBefore, usdt(5));
    });

    it("empties a strategy that has been deactivated", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);
      expect(await strategy.totalAssets()).to.be.gt(0n);

      await router.connect(curator).updateStrategy(0, 0n, usdt(2_000), false);
      await router.connect(curator).rebalance();

      expect(await strategy.lpBalance()).to.equal(0n);
    });

    it("only lets the curator rebalance", async () => {
      const { alice, router } = await loadFixture(deployPhony);
      await expect(router.connect(alice).rebalance()).to.be.reverted;
    });
  });

  describe("views", () => {
    it("packs the strategy explorer payload into one call", async () => {
      const { curator, alice, asset, vault, router } = await loadFixture(deployPhony);
      await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      const [adapters, names, allocations, caps, assets, apys, actives] =
        await router.getStrategiesInfo();

      expect(adapters.length).to.equal(2);
      expect(names[0]).to.equal("BDEX V2 - USDT/WBOT");
      expect(names[1]).to.equal("BDEX V2 - second venue");
      expect(allocations[0]).to.equal(6_000n);
      expect(allocations[1]).to.equal(2_000n);
      expect(caps[0]).to.equal(usdt(2_000));
      expect(assets[0]).to.be.gt(0n);
      expect(apys[0]).to.equal(0n); // realised only, and nothing harvested yet
      expect(actives[0]).to.equal(true);
    });

    it("reports zero weighted APY on an empty router", async () => {
      const { curator, router } = await loadFixture(deployPhony);
      await router.connect(curator).removeStrategy(0);

      expect(await router.weightedAPY()).to.equal(0n);
    });

    it("sums assets and exitable liquidity across both venues", async () => {
      const { curator, alice, asset, vault, router, strategy } = await loadFixture(deployPhony);
      const second = await addSecondLeg(router, curator, 2_000n);

      await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(300));
      await vault.connect(alice).deposit(usdt(300), alice.address);

      const total = await router.getTotalStrategyAssets();
      expect(total).to.equal(
        (await strategy.totalAssets()) + (await second.strategy.totalAssets()),
      );

      // Exitable is strictly less than held: unwinding either leg pays its pool's fee.
      expect(await router.getAvailableLiquidity()).to.be.lt(total);
    });
  });
});
