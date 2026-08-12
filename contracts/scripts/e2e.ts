import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * On-chain smoke test of the full loop against real protocols.
 *
 * deposit -> allocate into a live BDEX pair -> harvest real trading fees -> withdraw.
 *
 * The first step is the one that changed when the mocks went away: there is no faucet to call,
 * because the asset is the chain's real USDT. If the runner holds none, this script buys some
 * by swapping native BOT through BDEX — the same router the vault's strategy uses.
 */

const RULE = "-".repeat(58);
const step = (n: number, title: string) => {
  console.log(`\n  ${n}. ${title}`);
  console.log(`  ${"─".repeat(56)}`);
};

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [user] = await ethers.getSigners();

  const vault = await ethers.getContractAt("BotVault", manifest.contracts.vault);
  const router = await ethers.getContractAt("StrategyRouter", manifest.contracts.router);
  const asset = new ethers.Contract(
    manifest.asset.address,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
    ],
    user,
  );

  const decimals: number = manifest.asset.decimals;
  const symbol: string = manifest.asset.symbol;
  const fmt = (v: bigint, dp = 4) => `${Number(ethers.formatUnits(v, decimals)).toFixed(dp)} ${symbol}`;

  console.log(`\n  Phony end-to-end -- ${manifest.network} (chainId ${manifest.chainId})`);
  console.log(`  ${RULE}`);
  console.log(`  vault  ${manifest.contracts.vault}`);
  console.log(`  asset  ${manifest.asset.address}  (real ${symbol})`);
  console.log(`  user   ${user.address}`);

  /* --- 1. Acquire the asset -------------------------------------------- */

  step(1, `Acquire ${symbol}`);

  let held: bigint = await asset.balanceOf(user.address);
  console.log(`  balance ${fmt(held)}`);

  const target = ethers.parseUnits(process.env.E2E_AMOUNT || "20", decimals);

  if (held < target) {
    const wbot = await new ethers.Contract(
      manifest.dex.router,
      ["function WETH() view returns (address)"],
      user,
    ).WETH();

    const dexRouter = new ethers.Contract(
      manifest.dex.router,
      [
        "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
        "function getAmountsOut(uint256,address[]) view returns (uint256[])",
      ],
      user,
    );

    // Buy a little more than needed so gas-price noise does not leave us a cent short.
    const spend = ethers.parseEther(process.env.E2E_BOT_SPEND || "1");
    const quote = await dexRouter.getAmountsOut(spend, [wbot, manifest.asset.address]);

    console.log(
      `  swapping ${ethers.formatEther(spend)} BOT -> ~${fmt(quote[1])} through BDEX`,
    );

    const tx = await dexRouter.swapExactETHForTokens(
      0,
      [wbot, manifest.asset.address],
      user.address,
      Math.floor(Date.now() / 1000) + 600,
      { value: spend },
    );
    await tx.wait();

    held = await asset.balanceOf(user.address);
    console.log(`  balance ${fmt(held)}`);
  }

  if (held < target) {
    throw new Error(
      `Need at least ${fmt(target)} to run the loop; holding ${fmt(held)}. Raise E2E_BOT_SPEND ` +
        `or lower E2E_AMOUNT.`,
    );
  }

  /* --- 2. Deposit ------------------------------------------------------ */

  step(2, "Deposit and restake");

  if ((await asset.allowance(user.address, manifest.contracts.vault)) < target) {
    await (await asset.approve(manifest.contracts.vault, ethers.MaxUint256)).wait();
    console.log(`  approved the vault`);
  }

  const previewed = await vault.previewDeposit(target);
  const depositTx = await vault.deposit(target, user.address);
  const depositReceipt = await depositTx.wait();

  console.log(`  deposited     ${fmt(target)}`);
  console.log(`  shares        ${fmt(await vault.balanceOf(user.address))} (previewed ${fmt(previewed)})`);
  console.log(`  gas           ${depositReceipt?.gasUsed}`);
  console.log(`  tx            ${depositTx.hash}`);

  /* --- 3. Allocation --------------------------------------------------- */

  step(3, "Verify allocation into real liquidity");

  const [adapters, names, weights, , assets, apys] = await router.getStrategiesInfo();

  for (let i = 0; i < adapters.length; i++) {
    if (adapters[i] === ethers.ZeroAddress) continue;
    const adapter = await ethers.getContractAt("BdexV2LpStrategy", adapters[i]);
    console.log(
      `  ${names[i].padEnd(24)} ${fmt(assets[i], 4).padStart(16)}` +
        `  ${Number(weights[i]) / 100}% target  ${Number(apys[i]) / 100}% APY  LP ${await adapter.lpBalance()}`,
    );
  }

  console.log(`  idle reserve             ${fmt(await vault.idleAssets(), 4).padStart(16)}`);
  console.log(`  total NAV                ${fmt(await vault.totalAssets(), 4).padStart(16)}`);
  console.log(`  exitable this block      ${fmt(await vault.availableLiquidity(), 4).padStart(16)}`);

  /* --- 4. Harvest ------------------------------------------------------ */

  step(4, "Harvest real trading fees");

  const priceBefore = await vault.sharePrice();
  const harvestTx = await vault.harvest();
  const harvestReceipt = await harvestTx.wait();

  console.log(`  share price   ${ethers.formatUnits(priceBefore, decimals)} -> ${ethers.formatUnits(await vault.sharePrice(), decimals)}`);
  console.log(`  lifetime yield ${fmt(await vault.totalYieldHarvested())}`);
  console.log(`  gas           ${harvestReceipt?.gasUsed}`);
  console.log(`  tx            ${harvestTx.hash}`);
  console.log(
    `\n  note: fees accrue only when other people trade the pair. A harvest moments after a\n` +
      `  deposit will usually be zero, and that is the honest result rather than a bug.`,
  );

  /* --- 5. Withdraw ----------------------------------------------------- */

  step(5, "Withdraw");

  const exitable = await vault.maxWithdraw(user.address);

  // Leave a margin below the quote. `maxWithdraw` is derived from live pool reserves, so any
  // trade landing between this read and our transaction moves it — the first run of this
  // script asked for 8 units more than was available a block later and was correctly refused.
  // A UI needs the same haircut on its Max button for the same reason.
  const half = (exitable * 4_950n) / 10_000n;

  const withdrawTx = await vault.withdraw(half, user.address, user.address);
  const withdrawReceipt = await withdrawTx.wait();

  console.log(`  withdrawable  ${fmt(exitable)}  (requesting 99% of half, see note)`);
  console.log(`  withdrew      ${fmt(half)}`);
  console.log(`  remaining     ${fmt(await vault.balanceOf(user.address))} shares`);
  console.log(`  gas           ${withdrawReceipt?.gasUsed}`);
  console.log(`  tx            ${withdrawTx.hash}`);

  console.log(`\n  ${RULE}`);
  console.log(`  Full loop completed against real BDEX liquidity`);
  console.log(`  Position value ${fmt(await vault.convertToAssets(await vault.balanceOf(user.address)))}`);
  console.log(`  Vault TVL      ${fmt(await vault.totalAssets())}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
