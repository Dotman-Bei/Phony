import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor, scaled } from "./config";

/**
 * Verifies every deployed contract on the BOT Chain explorer, reading addresses and
 * constructor arguments back out of the deployment manifest.
 *
 * Already-verified contracts are reported and skipped rather than treated as failures —
 * re-running this after a partial failure is the normal path, not an exception.
 *
 * Env fallbacks here use `||`, not `??`, and must keep matching `deploy.ts`. A key that is
 * present but blank in .env (`FEE_RECIPIENT=`) is an empty string, which `??` happily
 * passes through as a constructor argument the ABI encoder then rejects. The two scripts
 * disagreeing about that is a verification failure with a very unhelpful error message.
 */
async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json — run the deploy script first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const config = configFor(network.name);
  const c = manifest.contracts as Record<string, string>;
  const deployer = manifest.deployer as string;
  const d = config.asset.decimals;

  const targets: Array<{ name: string; address: string; args: unknown[] }> = [
    {
      name: "BotVault",
      address: c.vault,
      args: [
        c.asset,
        config.vault.name,
        config.vault.symbol,
        deployer,
        process.env.FEE_RECIPIENT || deployer,
      ],
    },
    { name: "StrategyRouter", address: c.router, args: [c.asset, c.vault, deployer] },
    {
      name: "TBillStrategy",
      address: c.tbillStrategy,
      args: [c.asset, c.router, c.tbillSource, config.mockRates.tbillApyBps, deployer],
    },
    { name: "CreditStrategy", address: c.creditStrategy, args: [c.asset, c.router, c.creditPool, deployer] },
    {
      name: "LiquidityStrategy",
      address: c.liquidityStrategy,
      args: [c.asset, c.router, c.liquidityPool, config.maxSlippageBps, deployer],
    },
  ];

  if (manifest.usesMocks) {
    targets.push(
      {
        name: "MockRWAToken",
        address: c.asset,
        args: [config.asset.name, config.asset.symbol, d, deployer],
      },
      { name: "MockTBillVault", address: c.tbillSource, args: [c.asset, config.mockRates.tbillApyBps, deployer] },
      {
        name: "MockCreditPool",
        address: c.creditPool,
        args: [c.asset, config.mockRates.creditApyBps, config.mockRates.creditUtilisationBps, deployer],
      },
      {
        name: "MockLiquidityPool",
        address: c.liquidityPool,
        args: [c.asset, process.env.PAIR_ADDRESS || c.asset, config.mockRates.liquidityApyBps, deployer],
      },
    );
  }

  console.log(`\n  Verifying ${targets.length} contracts on ${config.label}\n`);

  let verified = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const target of targets) {
    process.stdout.write(`  ${target.name.padEnd(22)} ${target.address}  `);
    try {
      await run("verify:verify", { address: target.address, constructorArguments: target.args });
      console.log("verified");
      verified++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(message)) {
        console.log("already verified");
        skipped++;
      } else {
        console.log("FAILED");
        console.log(`      ${message.split("\n")[0]}`);
        failed.push(target.name);
      }
    }
  }

  console.log(`\n  ${verified} verified · ${skipped} already verified · ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`  Retry: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
  console.log("");
  void scaled;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
