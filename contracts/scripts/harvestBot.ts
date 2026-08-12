import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * HarvestBot — the keeper that makes "auto-compounding" literally true.
 *
 * The vault compounds by having yield land in it while share supply stays fixed, so
 * somebody has to call `harvest()`. That call is permissionless and the caller gains
 * nothing from it, which means it will not happen on its own — hence this bot.
 *
 * The only interesting decision it makes is *when*. Harvesting sweeps every strategy in
 * one transaction, so the gas cost is roughly fixed while the yield realised grows with
 * time. Harvesting too often burns more gas than it compounds. The bot therefore holds
 * until pending yield clears `minYieldMultiple` × the estimated gas cost, with a maximum
 * interval as a backstop so a quiet vault still gets swept.
 *
 * Run: npx hardhat run scripts/harvestBot.ts --network botTestnet
 * Env: HARVEST_INTERVAL_SEC, HARVEST_MIN_YIELD_MULTIPLE, HARVEST_MAX_IDLE_HOURS, HARVEST_ONCE
 */

const POLL_INTERVAL_SEC = Number(process.env.HARVEST_INTERVAL_SEC || 300);
const MIN_YIELD_MULTIPLE = Number(process.env.HARVEST_MIN_YIELD_MULTIPLE || 5);
const MAX_IDLE_HOURS = Number(process.env.HARVEST_MAX_IDLE_HOURS || 24);
const RUN_ONCE = process.env.HARVEST_ONCE === "true";

interface HarvestDecision {
  shouldHarvest: boolean;
  reason: string;
  pendingYield: bigint;
  gasCost: bigint;
  hoursSinceHarvest: number;
}

function loadManifest() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — deploy first.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

async function evaluate(
  vault: Awaited<ReturnType<typeof ethers.getContractAt>>,
  strategies: Array<Awaited<ReturnType<typeof ethers.getContractAt>>>,
  decimals: number,
): Promise<HarvestDecision> {
  let pendingYield = 0n;
  for (const strategy of strategies) {
    pendingYield += await (strategy as any).pendingYield();
  }

  const lastHarvest = await (vault as any).lastHarvestTime();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const hoursSinceHarvest = Number(now - lastHarvest) / 3600;

  // Price the call the same way the chain will.
  let gasCost = 0n;
  try {
    const gasEstimate = await (vault as any).harvest.estimateGas();
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    gasCost = gasEstimate * gasPrice;
  } catch {
    // A revert here usually means "nothing to harvest yet"; treat it as prohibitive.
    return {
      shouldHarvest: false,
      reason: "harvest() is not currently callable",
      pendingYield,
      gasCost: 0n,
      hoursSinceHarvest,
    };
  }

  if (pendingYield === 0n) {
    return { shouldHarvest: false, reason: "no yield accrued", pendingYield, gasCost, hoursSinceHarvest };
  }

  // Gas is paid in BOT, yield is denominated in the RWA token. Comparing them exactly
  // needs a price oracle the MVP deliberately does not have, so the bot compares
  // magnitudes after normalising decimals and leans on the multiple as the safety margin.
  const normalisedYield = decimals >= 18 ? pendingYield / 10n ** BigInt(decimals - 18) : pendingYield * 10n ** BigInt(18 - decimals);
  const threshold = gasCost * BigInt(MIN_YIELD_MULTIPLE);

  if (normalisedYield >= threshold) {
    return {
      shouldHarvest: true,
      reason: `yield is ${MIN_YIELD_MULTIPLE}×+ the gas cost`,
      pendingYield,
      gasCost,
      hoursSinceHarvest,
    };
  }

  if (hoursSinceHarvest >= MAX_IDLE_HOURS) {
    return {
      shouldHarvest: true,
      reason: `${MAX_IDLE_HOURS}h backstop reached`,
      pendingYield,
      gasCost,
      hoursSinceHarvest,
    };
  }

  return {
    shouldHarvest: false,
    reason: `yield below the ${MIN_YIELD_MULTIPLE}× gas threshold`,
    pendingYield,
    gasCost,
    hoursSinceHarvest,
  };
}

async function main() {
  const manifest = loadManifest();
  const c = manifest.contracts as Record<string, string>;
  const [keeper] = await ethers.getSigners();

  const vault = await ethers.getContractAt("BotVault", c.vault);
  const asset = await ethers.getContractAt("MockRWAToken", c.asset);
  const decimals = Number(await asset.decimals());
  const symbol = await asset.symbol();

  const strategies = await Promise.all([
    ethers.getContractAt("TBillStrategy", c.tbillStrategy),
    ethers.getContractAt("CreditStrategy", c.creditStrategy),
    ethers.getContractAt("LiquidityStrategy", c.liquidityStrategy),
  ]);

  console.log(`\n  HarvestBot — ${network.name}`);
  console.log(`  ${"─".repeat(58)}`);
  console.log(`  vault      ${c.vault}`);
  console.log(`  keeper     ${keeper.address}`);
  console.log(`  policy     harvest at ${MIN_YIELD_MULTIPLE}× gas, or every ${MAX_IDLE_HOURS}h`);
  console.log(`  poll       every ${POLL_INTERVAL_SEC}s${RUN_ONCE ? " (single pass)" : ""}`);
  console.log(`  ${"─".repeat(58)}\n`);

  const tick = async () => {
    const stamp = new Date().toISOString().slice(11, 19);
    try {
      const decision = await evaluate(vault, strategies, decimals);
      const yieldStr = `${Number(ethers.formatUnits(decision.pendingYield, decimals)).toFixed(4)} ${symbol}`;

      if (!decision.shouldHarvest) {
        console.log(`  ${stamp}  hold      ${yieldStr.padEnd(22)} ${decision.reason}`);
        return;
      }

      console.log(`  ${stamp}  harvest   ${yieldStr.padEnd(22)} ${decision.reason}`);

      const tx = await (vault as any).harvest();
      const receipt = await tx.wait();

      const priceAfter = await (vault as any).sharePrice();
      console.log(
        `  ${stamp}  done      tx ${receipt.hash.slice(0, 10)}…  gas ${receipt.gasUsed}  ` +
          `share price ${ethers.formatUnits(priceAfter, decimals)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.log(`  ${stamp}  error     ${message}`);
    }
  };

  await tick();
  if (RUN_ONCE) return;

  setInterval(tick, POLL_INTERVAL_SEC * 1000);
  // Hold the process open — Hardhat scripts exit as soon as main() resolves otherwise.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
