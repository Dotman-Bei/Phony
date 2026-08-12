import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * On-chain smoke test of the complete business loop against a live deployment.
 *
 * The Hardhat suite proves the logic; this proves the *deployment* — that the addresses in
 * the manifest are wired to each other, that the explorer will show real events, and that
 * a wallet with real gas can complete the loop. Run it on testnet before mainnet, and once
 * on mainnet after deploying.
 *
 * Note: on a live chain, yield accrues in wall-clock time. A run immediately after deploy
 * will report a very small harvest — that is correct, not a failure.
 */
async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const c = manifest.contracts as Record<string, string>;
  const [user] = await ethers.getSigners();

  const vault = await ethers.getContractAt("BotVault", c.vault);
  const router = await ethers.getContractAt("StrategyRouter", c.router);
  const asset = await ethers.getContractAt("MockRWAToken", c.asset);

  const decimals = Number(await asset.decimals());
  const symbol = await asset.symbol();
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(4)} ${symbol}`;

  const step = (n: number, label: string) => console.log(`\n  ${n}. ${label}\n  ${"─".repeat(56)}`);

  console.log(`\n  Phony end-to-end — ${network.name}`);
  console.log(`  vault ${c.vault}`);
  console.log(`  user  ${user.address}`);

  /* 1 — funding */
  step(1, "Acquire test tokens");
  let balance = await asset.balanceOf(user.address);
  if (balance < ethers.parseUnits("100", decimals) && manifest.usesMocks) {
    console.log(`  balance ${fmt(balance)} — claiming from the faucet`);
    await (await asset.faucet()).wait();
    balance = await asset.balanceOf(user.address);
  }
  console.log(`  balance ${fmt(balance)}`);
  if (balance === 0n) throw new Error("No test tokens available.");

  /* 2 — deposit */
  step(2, "Deposit and restake");
  const depositAmount = balance / 10n;

  const allowance = await asset.allowance(user.address, c.vault);
  if (allowance < depositAmount) {
    await (await asset.approve(c.vault, ethers.MaxUint256)).wait();
    console.log(`  approved the vault`);
  }

  const previewShares = await vault.previewDeposit(depositAmount);
  const depositTx = await vault.deposit(depositAmount, user.address);
  const depositReceipt = await depositTx.wait();

  console.log(`  deposited     ${fmt(depositAmount)}`);
  console.log(`  shares        ${fmt(await vault.balanceOf(user.address))} (previewed ${fmt(previewShares)})`);
  console.log(`  gas           ${depositReceipt?.gasUsed}`);
  console.log(`  tx            ${depositTx.hash}`);

  /* 3 — allocation */
  step(3, "Verify allocation across strategies");
  const info = await router.getStrategiesInfo();
  for (let i = 0; i < info.adapters.length; i++) {
    if (info.adapters[i] === ethers.ZeroAddress) continue;
    console.log(
      `  ${info.names[i].padEnd(26)} ${fmt(info.assets[i]).padStart(20)}  ` +
        `${Number(info.allocationsBps[i]) / 100}% target  ${Number(info.apys[i]) / 100}% APY`,
    );
  }
  console.log(`  ${"reserve buffer (idle)".padEnd(26)} ${fmt(await vault.idleAssets()).padStart(20)}`);
  console.log(`  ${"total NAV".padEnd(26)} ${fmt(await vault.totalAssets()).padStart(20)}`);
  console.log(`  ${"weighted APY".padEnd(26)} ${(Number(await router.weightedAPY()) / 100).toFixed(2)}%`.padEnd(50));

  /* 4 — harvest */
  step(4, "Harvest and compound");
  const priceBefore = await vault.sharePrice();
  const harvestTx = await vault.harvest();
  const harvestReceipt = await harvestTx.wait();

  console.log(`  share price   ${ethers.formatUnits(priceBefore, decimals)} → ${ethers.formatUnits(await vault.sharePrice(), decimals)}`);
  console.log(`  lifetime yield ${fmt(await vault.totalYieldHarvested())}`);
  console.log(`  gas           ${harvestReceipt?.gasUsed}`);
  console.log(`  tx            ${harvestTx.hash}`);

  /* 5 — withdraw */
  step(5, "Withdraw");
  const shares = await vault.balanceOf(user.address);
  const half = shares / 2n;
  const before = await asset.balanceOf(user.address);

  const redeemTx = await vault.redeem(half, user.address, user.address);
  const redeemReceipt = await redeemTx.wait();
  const received = (await asset.balanceOf(user.address)) - before;

  console.log(`  redeemed      ${fmt(half)} shares`);
  console.log(`  received      ${fmt(received)}`);
  console.log(`  remaining     ${fmt(await vault.balanceOf(user.address))} shares`);
  console.log(`  gas           ${redeemReceipt?.gasUsed}`);
  console.log(`  tx            ${redeemTx.hash}`);

  /* summary */
  console.log(`\n  ${"─".repeat(58)}`);
  console.log(`  Full loop completed: deposit → allocate → harvest → withdraw`);
  console.log(`  Position value ${fmt(await vault.convertToAssets(await vault.balanceOf(user.address)))}`);
  console.log(`  Vault TVL      ${fmt(await vault.totalAssets())}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
