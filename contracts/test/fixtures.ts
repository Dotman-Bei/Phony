import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import type {
  BotVault,
  StrategyRouter,
  TBillStrategy,
  CreditStrategy,
  LiquidityStrategy,
  MockRWAToken,
  MockTBillVault,
  MockCreditPool,
  MockLiquidityPool,
} from "../typechain-types";

export const BPS = 10_000n;
export const DECIMALS = 18;

/** Allocation weights. These sum to 9500, so 5% of TVL stays idle in the vault as the
 *  reserve buffer — the same split the product spec shows in the allocation chart. */
export const TBILL_BPS = 4_000n;
export const CREDIT_BPS = 3_500n;
export const LIQUIDITY_BPS = 2_000n;
export const RESERVE_BPS = BPS - TBILL_BPS - CREDIT_BPS - LIQUIDITY_BPS;

export const TBILL_APY = 420n; // 4.20%
export const CREDIT_APY = 800n; // 8.00%
export const LIQUIDITY_APY = 650n; // 6.50%

export const YEAR = 365 * 24 * 60 * 60;

export function units(amount: string | number): bigint {
  return ethers.parseUnits(amount.toString(), DECIMALS);
}

export interface Deployment {
  owner: HardhatEthersSigner;
  treasury: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  asset: MockRWAToken;
  vault: BotVault;
  router: StrategyRouter;
  tbillSource: MockTBillVault;
  creditPool: MockCreditPool;
  liquidityPool: MockLiquidityPool;
  tbillStrategy: TBillStrategy;
  creditStrategy: CreditStrategy;
  liquidityStrategy: LiquidityStrategy;
}

export interface DeployOptions {
  /** Share of credit principal out on loan and therefore not recallable, in bps. */
  creditUtilisationBps?: bigint;
  /** Skip registering the three strategies, leaving a bare vault + empty router. */
  skipStrategies?: boolean;
}

/**
 * Full Phony stack on top of mock RWA yield sources.
 *
 * Deployment order is vault → router → adapters, which is the reverse of the naive
 * reading: the router's `onlyVault` guard and the adapters' `onlyRouter` guard both bind
 * at construction, so each layer needs the address of the one above it.
 */
export async function deployFixture(options: DeployOptions = {}): Promise<Deployment> {
  const { creditUtilisationBps = 0n, skipStrategies = false } = options;
  const [owner, treasury, alice, bob, carol] = await ethers.getSigners();

  const asset = await ethers.deployContract("MockRWAToken", [
    "Tokenized T-Bill",
    "TBILL",
    DECIMALS,
    owner.address,
  ]);

  const vault = await ethers.deployContract("BotVault", [
    await asset.getAddress(),
    "Phony RWA Vault",
    "brRWA",
    owner.address,
    treasury.address,
  ]);

  const router = await ethers.deployContract("StrategyRouter", [
    await asset.getAddress(),
    await vault.getAddress(),
    owner.address,
  ]);

  const tbillSource = await ethers.deployContract("MockTBillVault", [
    await asset.getAddress(),
    TBILL_APY,
    owner.address,
  ]);

  const creditPool = await ethers.deployContract("MockCreditPool", [
    await asset.getAddress(),
    CREDIT_APY,
    creditUtilisationBps,
    owner.address,
  ]);

  const liquidityPool = await ethers.deployContract("MockLiquidityPool", [
    await asset.getAddress(),
    ethers.Wallet.createRandom().address, // stand-in for the TBILL/USDC pair
    LIQUIDITY_APY,
    owner.address,
  ]);

  // The mock sources pay yield by minting, standing in for a real issuer's coupon.
  await asset.setMinter(await tbillSource.getAddress(), true);
  await asset.setMinter(await creditPool.getAddress(), true);
  await asset.setMinter(await liquidityPool.getAddress(), true);

  const routerAddress = await router.getAddress();

  const tbillStrategy = await ethers.deployContract("TBillStrategy", [
    await asset.getAddress(),
    routerAddress,
    await tbillSource.getAddress(),
    TBILL_APY,
    owner.address,
  ]);

  const creditStrategy = await ethers.deployContract("CreditStrategy", [
    await asset.getAddress(),
    routerAddress,
    await creditPool.getAddress(),
    owner.address,
  ]);

  const liquidityStrategy = await ethers.deployContract("LiquidityStrategy", [
    await asset.getAddress(),
    routerAddress,
    await liquidityPool.getAddress(),
    100n, // 1% max slippage
    owner.address,
  ]);

  if (!skipStrategies) {
    await router.addStrategy(await tbillStrategy.getAddress(), TBILL_BPS, 0);
    await router.addStrategy(await creditStrategy.getAddress(), CREDIT_BPS, 0);
    await router.addStrategy(await liquidityStrategy.getAddress(), LIQUIDITY_BPS, 0);
  }

  await vault.setStrategyRouter(routerAddress);

  for (const user of [alice, bob, carol]) {
    await asset.mint(user.address, units(1_000_000));
    await asset.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
  }

  return {
    owner,
    treasury,
    alice,
    bob,
    carol,
    asset,
    vault,
    router,
    tbillSource,
    creditPool,
    liquidityPool,
    tbillStrategy,
    creditStrategy,
    liquidityStrategy,
  };
}

/**
 * Same stack, but 80% of credit principal is out on loan. Exercises the partial-liquidity
 * path that `BotVault.maxWithdraw` exists to report honestly.
 */
export async function deployIlliquidCreditFixture(): Promise<Deployment> {
  return deployFixture({ creditUtilisationBps: 8_000n });
}

/** Vault and router deployed, but no strategies registered yet. */
export async function deployBareFixture(): Promise<Deployment> {
  return deployFixture({ skipStrategies: true });
}

/** Assert two bigints are within `tolerance` of each other, for rounding-tolerant checks. */
export function closeTo(actual: bigint, expected: bigint, tolerance: bigint): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff <= tolerance;
}
