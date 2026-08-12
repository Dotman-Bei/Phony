import { ethers, network } from "hardhat";

import { configFor, reserveBufferBps, scaled } from "./config";

/**
 * Read-only preflight. Sends no transactions, so it is safe against mainnet.
 *
 * Every check here otherwise costs a failed deploy to discover: an RPC that does not resolve,
 * a chainId that disagrees with the config, a missing key, an unfunded deployer, an asset whose
 * decimals are not what the config assumes, a DEX pair that does not exist, or a pool too thin
 * to enter without moving the price.
 *
 *   npx hardhat run scripts/preflight.ts --network botTestnet
 */

const RULE = "-".repeat(64);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(24)}${value}`);

async function main() {
  const config = configFor(network.name);
  const expected = network.config.chainId;
  const problems: string[] = [];

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
  log("sources", "live protocol addresses (no mocks)");

  if (expected && expected !== chainId) {
    problems.push(
      `The RPC reports chainId ${chainId} but hardhat.config.ts expects ${expected}. ` +
        `Deploying would write a manifest the frontend cannot match to a chain.`,
    );
  }

  /* --- signer and gas -------------------------------------------------- */

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    problems.push("No signer. Set PRIVATE_KEY in contracts/.env before deploying.");
  }

  for (const signer of signers) {
    const balance = await ethers.provider.getBalance(signer.address);
    log("deployer", signer.address);
    log("gas balance", `${ethers.formatEther(balance)} BOT`);

    if (balance === 0n) {
      problems.push(
        network.name === "botTestnet"
          ? `${signer.address} has no gas. Claim tBOT at https://faucet.botchain.ai/basic`
          : `${signer.address} has no gas. Apply at https://forms.gle/QGWNnmthCDgL92uR9`,
      );
    }
  }

  /* --- the asset really exists and matches the config ------------------ */

  console.log(`  ${RULE}`);

  let decimals = config.asset.decimals;
  try {
    const asset = new ethers.Contract(
      config.asset.address,
      [
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function balanceOf(address) view returns (uint256)",
      ],
      ethers.provider,
    );
    const [symbol, dp] = await Promise.all([asset.symbol(), asset.decimals()]);
    decimals = Number(dp);
    log("asset", `${symbol} (${dp} dp) ${config.asset.address}`);

    if (decimals !== config.asset.decimals) {
      problems.push(
        `Asset reports ${decimals} decimals but config says ${config.asset.decimals}. ` +
          `Every amount would be wrong by a factor of 10^${Math.abs(decimals - config.asset.decimals)}.`,
      );
    }

    if (signers.length > 0) {
      const held = await asset.balanceOf(signers[0].address);
      log("deployer asset", `${ethers.formatUnits(held, decimals)} ${symbol}`);
      if (held === 0n) {
        console.log(
          `\n  note: the deployer holds no ${symbol}. Deploying is fine, but the e2e run ` +
            `needs some — acquire it by swapping BOT on BDEX.`,
        );
      }
    }
  } catch {
    problems.push(
      `No ERC-20 responded at ${config.asset.address}. On this chain that address is not the ` +
        `asset the config claims.`,
    );
  }

  /* --- the DEX and every leg's pair ------------------------------------ */

  try {
    const dexRouter = new ethers.Contract(
      config.dex.router,
      ["function factory() view returns (address)", "function WETH() view returns (address)"],
      ethers.provider,
    );
    const factoryAddress: string = await dexRouter.factory();
    log("BDEX router", `${config.dex.router}`);
    log("BDEX factory", factoryAddress);

    const factory = new ethers.Contract(
      factoryAddress,
      ["function getPair(address,address) view returns (address)"],
      ethers.provider,
    );

    for (const leg of config.legs) {
      const pairAddress: string = await factory.getPair(config.asset.address, leg.pairedToken);

      if (pairAddress === ethers.ZeroAddress) {
        problems.push(
          `No BDEX pair for ${config.asset.symbol}/${leg.pairedSymbol}; leg "${leg.key}" has ` +
            `nothing to provide liquidity to.`,
        );
        continue;
      }

      const pair = new ethers.Contract(
        pairAddress,
        [
          "function getReserves() view returns (uint112,uint112,uint32)",
          "function token0() view returns (address)",
        ],
        ethers.provider,
      );
      const [r0, r1] = await pair.getReserves();
      const token0: string = await pair.token0();
      const depth: bigint =
        token0.toLowerCase() === config.asset.address.toLowerCase() ? r0 : r1;

      log(
        `leg ${leg.key}`,
        `${pairAddress}  depth ${Number(ethers.formatUnits(depth, decimals)).toLocaleString("en-US")} ` +
          `${config.asset.symbol}  weight ${Number(leg.weightBps) / 100}%`,
      );

      if (depth === 0n) {
        problems.push(`Pair ${pairAddress} holds no ${config.asset.symbol}.`);
      } else if (scaled(leg.capWhole, decimals) > depth) {
        problems.push(
          `Leg "${leg.key}" cap is ${leg.capWhole} ${config.asset.symbol} but the pool only ` +
            `holds ${ethers.formatUnits(depth, decimals)}. Entering at the cap would be its own ` +
            `price impact — lower LEG_CAP.`,
        );
      }
    }
  } catch (error) {
    problems.push(
      `Could not read BDEX at ${config.dex.router}: ${(error as Error).message.split("\n")[0]}`,
    );
  }

  log("idle reserve", `${Number(reserveBufferBps(config)) / 100}%`);
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
