import { ethers, network } from "hardhat";

import { configFor } from "./config";

/**
 * Read-only preflight for a deployment.
 *
 * Every failure mode this catches costs a real deploy attempt to discover otherwise: an RPC
 * that does not resolve, a chainId that disagrees with `hardhat.config.ts`, a missing
 * PRIVATE_KEY, or a deployer with no gas. It sends no transactions, so it is safe to run
 * against mainnet.
 *
 *   npx hardhat run scripts/preflight.ts --network botTestnet
 */

const RULE = "-".repeat(58);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(22)}${value}`);

async function main() {
  const config = configFor(network.name);
  const expected = network.config.chainId;

  console.log(`\n  Preflight -- ${config.label}`);
  console.log(`  ${RULE}`);

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const block = await ethers.provider.getBlockNumber();
  const fee = await ethers.provider.getFeeData();

  log("rpc", (network.config as { url?: string }).url ?? "in-process");
  log("chainId", expected && expected !== chainId ? `${chainId}  (config says ${expected}!)` : `${chainId}`);
  log("block", block.toLocaleString("en-US"));
  log("gas price", `${ethers.formatUnits(fee.gasPrice ?? 0n, "gwei")} gwei`);
  log("sources", config.useMocks ? "mock RWA yield sources" : "live protocol addresses");

  const problems: string[] = [];

  if (expected && expected !== chainId) {
    problems.push(
      `The RPC reports chainId ${chainId} but hardhat.config.ts expects ${expected}. ` +
        `Deploying would write a manifest the frontend cannot match to a chain.`,
    );
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    problems.push("No signer. Set PRIVATE_KEY in contracts/.env before deploying.");
  }

  for (const signer of signers) {
    const balance = await ethers.provider.getBalance(signer.address);
    log("deployer", signer.address);
    log("balance", `${ethers.formatEther(balance)} BOT`);

    if (balance === 0n) {
      problems.push(
        network.name === "botTestnet"
          ? `${signer.address} has no gas. Claim 10 tBOT at https://faucet.botchain.ai/basic`
          : `${signer.address} has no gas. Apply for support at https://forms.gle/QGWNnmthCDgL92uR9`,
      );
    }
  }

  if (!config.useMocks) {
    const missing = Object.entries({
      ASSET_ADDRESS: config.asset.address,
      TBILL_YIELD_SOURCE: config.external.tbillYieldSource,
      CREDIT_POOL: config.external.creditPool,
      LIQUIDITY_POOL: config.external.liquidityPool,
    })
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      problems.push(`Live mode needs real addresses. Unset: ${missing.join(", ")}`);
    }
  }

  console.log(`  ${RULE}`);

  if (problems.length > 0) {
    console.log(`\n  Not ready to deploy:\n`);
    problems.forEach((p) => console.log(`    - ${p}`));
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Ready. Next: npx hardhat run scripts/deploy.ts --network ${network.name}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
