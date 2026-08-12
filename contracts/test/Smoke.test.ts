import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { deployPhony, generateTradingFees, usdt } from "./fixtures";

/**
 * Proves the fork itself works before anything is asserted on top of it: real USDT, real pair,
 * real reserves, real deposit into real liquidity.
 */
describe("Fork sanity", () => {
  it("is forking a chain that has the real USDT and a real BDEX pair", async () => {
    const { asset, pair, pairAddress, strategy } = await loadFixture(deployPhony);

    expect(await asset.symbol()).to.equal("USDT");
    expect(await asset.decimals()).to.equal(6n);

    const [reserveAsset, reservePaired] = await strategy.reserves();
    expect(reserveAsset).to.be.gt(0n, "pair holds no USDT");
    expect(reservePaired).to.be.gt(0n, "pair holds no WBOT");

    expect(await pair.totalSupply()).to.be.gt(0n);
    expect(pairAddress).to.properAddress;
  });

  it("funds test accounts from a real holder rather than minting", async () => {
    const { alice, asset } = await loadFixture(deployPhony);
    // Not an equality check: these are well-known Hardhat addresses and other people have
    // already sent them USDT on the real testnet. The fixture tops accounts up, it does not
    // own their balance.
    expect(await asset.balanceOf(alice.address)).to.be.gte(usdt(50_000));
  });

  it("puts a deposit into real liquidity and can read its value back", async () => {
    const { alice, asset, vault, strategy } = await loadFixture(deployPhony);

    await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
    await vault.connect(alice).deposit(usdt(1_000), alice.address);

    // 60% routed to the LP leg, 40% held idle.
    expect(await strategy.lpBalance()).to.be.gt(0n, "no LP tokens minted");
    expect(await vault.idleAssets()).to.be.closeTo(usdt(400), usdt(1));

    // NAV marks the LP at the pool's spot ratio, and our own entry moved that ratio: the
    // paired tokens were bought along the curve, below the price they are then marked at. So
    // NAV can read slightly *above* the deposit. What must never overstate is the exitable
    // figure, which prices the round trip including the fee — that is what maxWithdraw uses.
    const nav = await vault.totalAssets();
    expect(nav).to.be.closeTo(usdt(1_000), usdt(20));

    const exitable = await vault.maxWithdraw(alice.address);
    expect(exitable).to.be.lt(usdt(1_000), "exit quote should cost the round trip");
    expect(exitable).to.be.gt(usdt(950));
  });

  it("honours a withdrawal of exactly the maximum it quoted", async () => {
    const { alice, asset, vault } = await loadFixture(deployPhony);

    await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
    await vault.connect(alice).deposit(usdt(1_000), alice.address);

    // The regression this pins down: sizing the LP burn on the spot mark rather than on
    // realisable value under-delivers by the swap fee, so the vault rejected withdrawals of
    // its own quoted maximum — off by 11 units of 4.4 million on testnet.
    const quoted = await vault.maxWithdraw(alice.address);
    expect(quoted).to.be.gt(0n);

    const before = await asset.balanceOf(alice.address);
    await vault.connect(alice).withdraw(quoted, alice.address, alice.address);

    expect(await asset.balanceOf(alice.address)).to.equal(before + quoted);
  });

  it("earns real trading fees when real volume goes through the pool", async () => {
    const { alice, asset, vault, strategy } = await loadFixture(deployPhony);

    await (asset.connect(alice) as any).approve(await vault.getAddress(), usdt(1_000));
    await vault.connect(alice).deposit(usdt(1_000), alice.address);

    const before = await strategy.totalAssets();
    await generateTradingFees();
    const after = await strategy.totalAssets();

    expect(after).to.be.gt(before, "LP position did not grow after real swap volume");
  });
});
