import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor } from "./config";

/**
 * Verifies every contract this project deployed, reading addresses and constructor arguments
 * back out of the deployment manifest.
 *
 * Only our own contracts appear here. The asset and the BDEX pair belong to other people and
 * are already verified on BOTScan — there is nothing of ours to attach to them.
 *
 * Env fallbacks use `||`, never `??`, and must keep matching `deploy.ts`: a key that is present
 * but blank in .env (`FEE_RECIPIENT=`) is an empty string, which `??` passes straight through
 * as a constructor argument that the ABI encoder then rejects with an unhelpful error.
 *
 * Already-verified contracts are reported and skipped rather than treated as failures —
 * re-running after a partial failure is the normal path, not an exception.
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
  const legs = (manifest.legs ?? []) as Array<{
    key: string;
    name: string;
    adapter: string;
    pair: string;
  }>;

  const targets: Array<{ name: string; address: string; args: unknown[] }> = [
    {
      name: "BotVault",
      address: c.vault,
      args: [
        manifest.asset.address,
        config.vault.name,
        config.vault.symbol,
        deployer,
        process.env.FEE_RECIPIENT || deployer,
      ],
    },
    {
      name: "StrategyRouter",
      address: c.router,
      args: [manifest.asset.address, c.vault, deployer],
    },
    ...legs.map((leg) => ({
      name: `BdexV2LpStrategy (${leg.key})`,
      address: leg.adapter,
      args: [
        manifest.asset.address,
        c.router,
        manifest.dex.router,
        leg.pair,
        config.maxSlippageBps,
        leg.name,
        deployer,
      ],
    })),
  ];

  console.log(`\n  Verifying ${targets.length} contracts on ${config.label}\n`);

  let verified = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const target of targets) {
    process.stdout.write(`  ${target.name.padEnd(30)} ${target.address}  `);
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
