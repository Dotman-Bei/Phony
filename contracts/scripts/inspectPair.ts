import { ethers, network } from "hardhat";

import { configFor } from "./config";

/**
 * Read-only due diligence on a single BDEX V2 pair before a leg is pointed at it.
 *
 * Depth alone does not make a pool safe to enter. This prints what the other side actually is,
 * how the pool prices it, how much LP supply exists, and what a round trip through it costs at
 * a few sizes — the numbers that decide whether a cap is sane.
 *
 *   PAIR=0x... npx hardhat run scripts/inspectPair.ts --network botMainnet
 */

async function main() {
  const config = configFor(network.name);
  const pairAddress = process.env.PAIR;
  if (!pairAddress) throw new Error("Set PAIR=0x... to the pair you want inspected.");

  const asset = config.asset.address;
  const pair = new ethers.Contract(
    pairAddress,
    [
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function getReserves() view returns (uint112,uint112,uint32)",
      "function totalSupply() view returns (uint256)",
      "function factory() view returns (address)",
    ],
    ethers.provider,
  );

  const meta = (address: string) =>
    new ethers.Contract(
      address,
      [
        "function symbol() view returns (string)",
        "function name() view returns (string)",
        "function decimals() view returns (uint8)",
        "function totalSupply() view returns (uint256)",
      ],
      ethers.provider,
    );

  const [token0, token1, reserves, lpSupply, factoryAddress] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
    pair.totalSupply(),
    pair.factory(),
  ]);

  const assetIsToken0 = token0.toLowerCase() === asset.toLowerCase();
  const other: string = assetIsToken0 ? token1 : token0;
  const assetReserve: bigint = assetIsToken0 ? reserves[0] : reserves[1];
  const otherReserve: bigint = assetIsToken0 ? reserves[1] : reserves[0];

  const token = meta(other);
  const [symbol, name, decimals, supply] = await Promise.all([
    token.symbol(),
    token.name(),
    token.decimals(),
    token.totalSupply(),
  ]);

  // The factory must be the one this DEX router uses, or the "pair" is a look-alike whose
  // reserves an attacker controls.
  const dexRouter = new ethers.Contract(
    config.dex.router,
    ["function factory() view returns (address)"],
    ethers.provider,
  );
  const registered: string = await new ethers.Contract(
    await dexRouter.factory(),
    ["function getPair(address,address) view returns (address)"],
    ethers.provider,
  ).getPair(asset, other);

  const dp = Number(decimals);
  const assetWhole = Number(ethers.formatUnits(assetReserve, config.asset.decimals));
  const otherWhole = Number(ethers.formatUnits(otherReserve, dp));

  console.log(`\n  Pair ${pairAddress}  (${config.label})`);
  console.log(`  ${"-".repeat(72)}`);
  console.log(`  asset side       ${assetWhole.toLocaleString("en-US")} ${config.asset.symbol}`);
  console.log(`  paired side      ${otherWhole.toLocaleString("en-US")} ${symbol}`);
  console.log(`  paired token     ${name} (${symbol}, ${dp} dp)  ${other}`);
  console.log(`  paired supply    ${Number(ethers.formatUnits(supply, dp)).toLocaleString("en-US")} ${symbol}`);
  console.log(`  price            1 ${symbol} = ${(assetWhole / otherWhole).toFixed(6)} ${config.asset.symbol}`);
  console.log(`  pool value       ~${(assetWhole * 2).toLocaleString("en-US")} ${config.asset.symbol} (both sides)`);
  console.log(`  LP supply        ${ethers.formatUnits(lpSupply, 18)}`);
  console.log(`  factory          ${factoryAddress}`);
  console.log(
    `  registered       ${registered.toLowerCase() === pairAddress.toLowerCase() ? "yes — this is the factory's canonical pair" : `NO — factory says ${registered}`}`,
  );

  /* --- what a round trip actually costs at a few sizes ------------------ */

  const quoter = new ethers.Contract(
    config.dex.router,
    ["function getAmountsOut(uint256,address[]) view returns (uint256[])"],
    ethers.provider,
  );

  console.log(`\n  Round trip ${config.asset.symbol} -> ${symbol} -> ${config.asset.symbol}:`);
  for (const size of [100, 1_000, 5_000, 10_000, 25_000]) {
    const amountIn = ethers.parseUnits(String(size), config.asset.decimals);
    if (amountIn > assetReserve) {
      console.log(`    ${String(size).padStart(6)}  exceeds the pool's ${config.asset.symbol} reserve`);
      continue;
    }
    try {
      const out = (await quoter.getAmountsOut(amountIn, [asset, other]))[1];
      const back = (await quoter.getAmountsOut(out, [other, asset]))[1];
      const loss = Number(ethers.formatUnits(amountIn - back, config.asset.decimals));
      console.log(
        `    ${String(size).padStart(6)}  returns ${Number(ethers.formatUnits(back, config.asset.decimals)).toFixed(2)}  ` +
          `— costs ${loss.toFixed(2)} (${((loss / size) * 100).toFixed(2)}%)`,
      );
    } catch (error) {
      console.log(`    ${String(size).padStart(6)}  quote reverted: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
