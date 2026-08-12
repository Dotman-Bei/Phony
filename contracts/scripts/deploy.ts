import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor, scaled } from "./config";

/**
 * Deploys the full Phony stack and writes a deployment manifest that both
 * `verify.ts` and the frontend read.
 *
 * Deployment order is vault -> router -> adapters, which inverts the naive reading of the
 * architecture. The reason is mutual binding: the router's `onlyVault` guard and each
 * adapter's `onlyRouter` guard are set at construction, so every layer needs the address
 * of the layer above it. The vault is then pointed at the router in a second transaction,
 * which is also the only moment the two are allowed to disagree about each other.
 */

interface Manifest {
  network: string;
  chainId: number;
  deployer: string;
  timestamp: string;
  usesMocks: boolean;
  contracts: Record<string, string>;
  config: {
    allocationsBps: Record<string, string>;
    performanceFeeBps: string;
    depositCap: string;
    reserveBufferBps: string;
  };
}

const RULE = "-".repeat(58);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(30)}${value}`);

async function main() {
  const config = configFor(network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Phony deployment -- ${config.label}`);
  console.log(`  ${RULE}`);
  log("network", `${network.name} (chainId ${chainId})`);
  log("deployer", deployer.address);
  log("balance", `${ethers.formatEther(balance)} BOT`);
  log("sources", config.useMocks ? "mock RWA yield sources" : "live protocol addresses");
  console.log(`  ${RULE}\n`);

  if (balance === 0n) {
    throw new Error(
      "Deployer has no gas. Apply for BOT Chain gas support at https://forms.gle/QGWNnmthCDgL92uR9",
    );
  }

  const contracts: Record<string, string> = {};

  /* --- 1. Asset ------------------------------------------------------- */

  let assetAddress: string;
  if (config.useMocks) {
    const asset = await ethers.deployContract("MockRWAToken", [
      config.asset.name,
      config.asset.symbol,
      config.asset.decimals,
      deployer.address,
    ]);
    await asset.waitForDeployment();
    assetAddress = await asset.getAddress();
    log(`MockRWAToken (${config.asset.symbol})`, assetAddress);
  } else {
    if (!config.asset.address) throw new Error("ASSET_ADDRESS is required when useMocks is false.");
    assetAddress = config.asset.address;
    log("Asset (existing)", assetAddress);
  }
  contracts.asset = assetAddress;

  /* --- 2. Vault ------------------------------------------------------- */

  const vault = await ethers.deployContract("BotVault", [
    assetAddress,
    config.vault.name,
    config.vault.symbol,
    deployer.address,
    process.env.FEE_RECIPIENT || deployer.address,
  ]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  contracts.vault = vaultAddress;
  log(`BotVault (${config.vault.symbol})`, vaultAddress);

  /* --- 3. Router ------------------------------------------------------ */

  const router = await ethers.deployContract("StrategyRouter", [
    assetAddress,
    vaultAddress,
    deployer.address,
  ]);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  contracts.router = routerAddress;
  log("StrategyRouter", routerAddress);

  /* --- 4. Yield sources ----------------------------------------------- */

  let tbillSource: string;
  let creditPool: string;
  let liquidityPool: string;

  if (config.useMocks) {
    const source = await ethers.deployContract("MockTBillVault", [
      assetAddress,
      config.mockRates.tbillApyBps,
      deployer.address,
    ]);
    await source.waitForDeployment();
    tbillSource = await source.getAddress();

    const pool = await ethers.deployContract("MockCreditPool", [
      assetAddress,
      config.mockRates.creditApyBps,
      config.mockRates.creditUtilisationBps,
      deployer.address,
    ]);
    await pool.waitForDeployment();
    creditPool = await pool.getAddress();

    const lp = await ethers.deployContract("MockLiquidityPool", [
      assetAddress,
      // Stand-in for the TBILL/USDC pair address until a real DEX pair exists.
      process.env.PAIR_ADDRESS || assetAddress,
      config.mockRates.liquidityApyBps,
      deployer.address,
    ]);
    await lp.waitForDeployment();
    liquidityPool = await lp.getAddress();

    // The mock sources pay yield by minting, standing in for a real issuer's coupon.
    const assetContract = await ethers.getContractAt("MockRWAToken", assetAddress);
    for (const minter of [tbillSource, creditPool, liquidityPool]) {
      await (await assetContract.setMinter(minter, true)).wait();
    }

    log("MockTBillVault", tbillSource);
    log("MockCreditPool", creditPool);
    log("MockLiquidityPool", liquidityPool);
  } else {
    const { tbillYieldSource, creditPool: cp, liquidityPool: lp } = config.external;
    if (!tbillYieldSource || !cp || !lp) {
      throw new Error(
        "TBILL_YIELD_SOURCE, CREDIT_POOL and LIQUIDITY_POOL must all be set when useMocks is false.",
      );
    }
    tbillSource = tbillYieldSource;
    creditPool = cp;
    liquidityPool = lp;
    log("T-Bill source (existing)", tbillSource);
    log("Credit pool (existing)", creditPool);
    log("Liquidity pool (existing)", liquidityPool);
  }

  contracts.tbillSource = tbillSource;
  contracts.creditPool = creditPool;
  contracts.liquidityPool = liquidityPool;

  /* --- 5. Strategy adapters ------------------------------------------- */

  const tbillStrategy = await ethers.deployContract("TBillStrategy", [
    assetAddress,
    routerAddress,
    tbillSource,
    config.mockRates.tbillApyBps,
    deployer.address,
  ]);
  await tbillStrategy.waitForDeployment();
  contracts.tbillStrategy = await tbillStrategy.getAddress();
  log("TBillStrategy", contracts.tbillStrategy);

  const creditStrategy = await ethers.deployContract("CreditStrategy", [
    assetAddress,
    routerAddress,
    creditPool,
    deployer.address,
  ]);
  await creditStrategy.waitForDeployment();
  contracts.creditStrategy = await creditStrategy.getAddress();
  log("CreditStrategy", contracts.creditStrategy);

  const liquidityStrategy = await ethers.deployContract("LiquidityStrategy", [
    assetAddress,
    routerAddress,
    liquidityPool,
    config.maxSlippageBps,
    deployer.address,
  ]);
  await liquidityStrategy.waitForDeployment();
  contracts.liquidityStrategy = await liquidityStrategy.getAddress();
  log("LiquidityStrategy", contracts.liquidityStrategy);

  /* --- 6. Wire it together -------------------------------------------- */

  console.log(`\n  Configuring...`);

  const d = config.asset.decimals;
  await (
    await router.addStrategy(
      contracts.tbillStrategy,
      config.allocations.tbillBps,
      scaled(config.caps.tbill, d),
    )
  ).wait();
  await (
    await router.addStrategy(
      contracts.creditStrategy,
      config.allocations.creditBps,
      scaled(config.caps.credit, d),
    )
  ).wait();
  await (
    await router.addStrategy(
      contracts.liquidityStrategy,
      config.allocations.liquidityBps,
      scaled(config.caps.liquidity, d),
    )
  ).wait();
  log("  strategies registered", "3");

  await (await vault.setStrategyRouter(routerAddress)).wait();
  log("  router bound to vault", "ok");

  await (await vault.setPerformanceFee(config.performanceFeeBps)).wait();
  log("  performance fee", `${Number(config.performanceFeeBps) / 100}%`);

  if (config.depositCap > 0n) {
    await (await vault.setDepositCap(scaled(config.depositCap, d))).wait();
    log("  deposit cap", `${config.depositCap} ${config.asset.symbol}`);
  }

  const reserveBps =
    10_000n - config.allocations.tbillBps - config.allocations.creditBps - config.allocations.liquidityBps;

  /* --- 7. Manifest ---------------------------------------------------- */

  const manifest: Manifest = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    usesMocks: config.useMocks,
    contracts,
    config: {
      allocationsBps: {
        tbill: config.allocations.tbillBps.toString(),
        credit: config.allocations.creditBps.toString(),
        liquidity: config.allocations.liquidityBps.toString(),
      },
      performanceFeeBps: config.performanceFeeBps.toString(),
      depositCap: config.depositCap.toString(),
      reserveBufferBps: reserveBps.toString(),
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify(manifest, null, 2));

  const verifyTarget = network.name === "botMainnet" ? "mainnet" : "testnet";

  console.log(`\n  ${RULE}`);
  log("manifest", `deployments/${network.name}.json`);
  log("reserve buffer", `${Number(reserveBps) / 100}%`);
  console.log(`\n  Next:`);
  console.log(`    npm run export-abi           -> push addresses + ABIs to web/`);
  console.log(`    npm run verify:${verifyTarget.padEnd(14)}-> verify on the BOT Chain explorer`);
  console.log(`    npx hardhat run scripts/e2e.ts --network ${network.name}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
