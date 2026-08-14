import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor, reserveBufferBps, scaled } from "./config";

/**
 * Migrates a deployment onto a freshly compiled router and adapters, keeping the vault.
 *
 * Rotating an adapter is enough when only the adapter changed; this is for when the *router*
 * changed, which needs the vault re-pointed. The vault keeps its address either way, so published
 * links, verified explorer pages and depositors' share balances all survive.
 *
 * Sequence, and the order matters:
 *   1. `recallAllFunds` — pull every strategy's capital back to the vault, so nothing is left
 *      behind an adapter the vault is about to stop talking to
 *   2. deploy the new router, then adapters bound to it
 *   3. `setStrategyRouter` — the vault checks the router agrees about both the asset and itself
 *   4. register the adapters, then `deployIdleFunds`
 *
 * The cost is one round trip through each pool: real fees, printed below rather than glossed.
 *
 *   npx hardhat run scripts/migrateRouter.ts --network botTestnet
 */

const RULE = "-".repeat(64);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(28)}${value}`);

async function main() {
  const config = configFor(network.name);
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [curator] = await ethers.getSigners();

  const vault = await ethers.getContractAt("BotVault", manifest.contracts.vault);
  const oldRouter = await ethers.getContractAt("StrategyRouter", manifest.contracts.router);

  const decimals: number = manifest.asset.decimals;
  const symbol: string = manifest.asset.symbol;
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(6)} ${symbol}`;

  console.log(`\n  Router migration -- ${config.label}`);
  console.log(`  ${RULE}`);
  log("curator", curator.address);
  log("vault (unchanged)", manifest.contracts.vault);
  log("old router", manifest.contracts.router);
  log("gas balance", `${ethers.formatEther(await ethers.provider.getBalance(curator.address))} BOT`);

  const navBefore: bigint = await vault.totalAssets();
  const supplyBefore: bigint = await vault.totalSupply();
  log("NAV before", fmt(navBefore));
  log("shares before", fmt(supplyBefore));

  /* --- 1. bring every strategy's capital home --------------------------- */

  console.log(`\n  Recalling capital...`);
  const recallTx = await vault.recallAllFunds();
  const recallReceipt = await recallTx.wait();
  log("  recalled", `gas ${recallReceipt?.gasUsed}  tx ${recallTx.hash}`);
  log("  vault idle", fmt(await vault.idleAssets()));
  log("  still deployed", fmt(await oldRouter.getTotalStrategyAssets()));

  /* --- 2. new router, then adapters bound to it ------------------------- */

  console.log(`\n  Deploying...`);
  const router = await ethers.deployContract("StrategyRouter", [
    manifest.asset.address,
    manifest.contracts.vault,
    curator.address,
  ]);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  log("  StrategyRouter", routerAddress);

  const legs: Array<Record<string, string>> = [];

  for (const legConfig of config.legs) {
    const existing = manifest.legs?.find((l: { key: string }) => l.key === legConfig.key);
    if (!existing) throw new Error(`Manifest has no leg "${legConfig.key}" to migrate.`);

    const adapter = await ethers.deployContract("BdexV2LpStrategy", [
      manifest.asset.address,
      routerAddress,
      manifest.dex.router,
      existing.pair,
      config.maxSlippageBps,
      legConfig.name,
      curator.address,
    ]);
    await adapter.waitForDeployment();
    const adapterAddress = await adapter.getAddress();

    legs.push({ ...existing, adapter: adapterAddress });
    log(`  ${legConfig.key}`, adapterAddress);
  }

  /* --- 3. re-point the vault -------------------------------------------- */

  console.log(`\n  Re-pointing the vault...`);
  const pointTx = await vault.setStrategyRouter(routerAddress);
  await pointTx.wait();
  log("  router bound", `tx ${pointTx.hash}`);

  /* --- 4. register and redeploy ----------------------------------------- */

  for (const leg of legs) {
    const legConfig = config.legs.find((l) => l.key === leg.key)!;
    const tx = await router.addStrategy(
      leg.adapter,
      legConfig.weightBps,
      scaled(legConfig.capWhole, decimals),
    );
    await tx.wait();
    log(`  registered ${leg.key}`, `${Number(legConfig.weightBps) / 100}% target`);
  }

  const deployTx = await vault.deployIdleFunds();
  const deployReceipt = await deployTx.wait();
  log("  redeployed", `gas ${deployReceipt?.gasUsed}  tx ${deployTx.hash}`);

  /* --- 5. report and rewrite the manifest ------------------------------- */

  const navAfter: bigint = await vault.totalAssets();
  const supplyAfter: bigint = await vault.totalSupply();

  console.log(`\n  ${RULE}`);
  log("NAV after", fmt(navAfter));
  log("shares after", supplyAfter === supplyBefore ? `${fmt(supplyAfter)}  unchanged` : "CHANGED!");
  log(
    "NAV change",
    `${navAfter >= navBefore ? "+" : "-"}${fmt(
      navAfter >= navBefore ? navAfter - navBefore : navBefore - navAfter,
    )}  (round trip through the pool)`,
  );
  log("idle reserve", `${Number(reserveBufferBps(config)) / 100}% target`);

  manifest.contracts.router = routerAddress;
  for (const leg of legs) manifest.contracts[leg.key] = leg.adapter;
  manifest.legs = legs;
  manifest.migratedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n  Next:`);
  console.log(`    npm run export-abi`);
  console.log(`    npm run verify:${network.name === "botMainnet" ? "mainnet" : "testnet"}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
