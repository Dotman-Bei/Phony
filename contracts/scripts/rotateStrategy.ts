import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor, scaled } from "./config";

/**
 * Replaces a deployed strategy adapter with a freshly compiled one, in place.
 *
 * This is the curator path the architecture was built around, and it is worth preferring over a
 * full redeploy: the vault and router keep their addresses, so every link already published — the
 * README, the explorer pages, a judge's bookmark — stays valid, and depositors keep their shares.
 *
 * Sequence:
 *   1. deploy the new adapter against the same real pair
 *   2. `removeStrategy` the old one, which unwinds it and returns the capital to the vault
 *   3. `addStrategy` the new one at the same weight and cap
 *   4. `deployIdleFunds` so the recovered capital goes back to work
 *
 * NAV should be unchanged across this apart from the round trip through the pool, which is the
 * 0.3% swap fee on the paired half — real money, and the reason not to do this casually.
 *
 *   LEG=wbotLp npx hardhat run scripts/rotateStrategy.ts --network botTestnet
 */

const RULE = "-".repeat(64);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(26)}${value}`);

async function main() {
  const config = configFor(network.name);
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const legKey = process.env.LEG || manifest.legs?.[0]?.key;
  const legRecord = manifest.legs?.find((l: { key: string }) => l.key === legKey);
  const legConfig = config.legs.find((l) => l.key === legKey);

  if (!legRecord || !legConfig) {
    throw new Error(`No leg "${legKey}" in both the manifest and scripts/config.ts.`);
  }

  const [curator] = await ethers.getSigners();
  const vault = await ethers.getContractAt("BotVault", manifest.contracts.vault);
  const router = await ethers.getContractAt("StrategyRouter", manifest.contracts.router);

  const decimals: number = manifest.asset.decimals;
  const symbol: string = manifest.asset.symbol;
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(6)} ${symbol}`;

  console.log(`\n  Rotating leg "${legKey}" -- ${config.label}`);
  console.log(`  ${RULE}`);
  log("curator", curator.address);
  log("vault", manifest.contracts.vault);
  log("router", manifest.contracts.router);
  log("old adapter", legRecord.adapter);

  const navBefore: bigint = await vault.totalAssets();
  const supplyBefore: bigint = await vault.totalSupply();
  log("NAV before", fmt(navBefore));
  log("shares before", fmt(supplyBefore));

  /* --- find the strategy id the router knows it by --------------------- */

  const [adapters] = await router.getStrategiesInfo();
  const strategyId = adapters.findIndex(
    (a: string) => a.toLowerCase() === legRecord.adapter.toLowerCase(),
  );
  if (strategyId < 0) {
    throw new Error(`Router does not hold ${legRecord.adapter}; nothing to rotate.`);
  }
  log("strategy id", String(strategyId));

  /* --- 1. deploy the replacement ---------------------------------------- */

  console.log(`\n  Deploying replacement...`);
  const adapter = await ethers.deployContract("BdexV2LpStrategy", [
    manifest.asset.address,
    manifest.contracts.router,
    manifest.dex.router,
    legRecord.pair,
    config.maxSlippageBps,
    legConfig.name,
    curator.address,
  ]);
  await adapter.waitForDeployment();
  const newAdapter = await adapter.getAddress();
  log("new adapter", newAdapter);

  /* --- 2. retire the old one ------------------------------------------- */

  console.log(`\n  Retiring the old adapter...`);
  const removeTx = await router.removeStrategy(strategyId);
  const removeReceipt = await removeTx.wait();
  log("  removed", `gas ${removeReceipt?.gasUsed}  tx ${removeTx.hash}`);
  log("  vault idle now", fmt(await vault.idleAssets()));

  /* --- 3. register the replacement ------------------------------------- */

  const addTx = await router.addStrategy(
    newAdapter,
    legConfig.weightBps,
    scaled(legConfig.capWhole, decimals),
  );
  await (await addTx).wait?.();
  log("  registered", `${Number(legConfig.weightBps) / 100}% target  tx ${addTx.hash}`);

  /* --- 4. put the recovered capital back to work ----------------------- */

  const deployTx = await vault.deployIdleFunds();
  const deployReceipt = await deployTx.wait();
  log("  redeployed", `gas ${deployReceipt?.gasUsed}  tx ${deployTx.hash}`);

  /* --- 5. report and rewrite the manifest ------------------------------ */

  const navAfter: bigint = await vault.totalAssets();
  const supplyAfter: bigint = await vault.totalSupply();

  console.log(`\n  ${RULE}`);
  log("NAV after", fmt(navAfter));
  log("shares after", fmt(supplyAfter));
  log(
    "NAV change",
    `${navAfter >= navBefore ? "+" : "-"}${fmt(
      navAfter >= navBefore ? navAfter - navBefore : navBefore - navAfter,
    )}  (round trip through the pool)`,
  );
  log("share supply change", supplyAfter === supplyBefore ? "none, as expected" : "CHANGED!");

  legRecord.adapter = newAdapter;
  manifest.contracts[legKey] = newAdapter;
  manifest.rotatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n  Next:`);
  console.log(`    npm run export-abi`);
  console.log(`    npm run verify:${network.name === "botMainnet" ? "mainnet" : "testnet"}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
