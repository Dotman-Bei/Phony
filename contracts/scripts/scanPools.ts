import { ethers, network } from "hardhat";

import { configFor } from "./config";

/**
 * Read-only survey of every BDEX V2 pair that holds the vault asset, ranked by depth.
 *
 * The strategy's cap has to be sized against the pool it enters, and preflight only checks the
 * leg already in the config. This answers the prior question: on this chain, which pairs exist
 * at all, and is the one we picked the deepest one available?
 *
 *   npx hardhat run scripts/scanPools.ts --network botMainnet
 */

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];
const ERC20_ABI = ["function symbol() view returns (string)"];

async function main() {
  const config = configFor(network.name);
  const asset = config.asset.address.toLowerCase();

  const dexRouter = new ethers.Contract(
    config.dex.router,
    ["function factory() view returns (address)"],
    ethers.provider,
  );
  const factory = new ethers.Contract(
    await dexRouter.factory(),
    [
      "function allPairsLength() view returns (uint256)",
      "function allPairs(uint256) view returns (address)",
    ],
    ethers.provider,
  );

  const count = Number(await factory.allPairsLength());
  console.log(`\n  ${config.label} — BDEX V2 has ${count} pairs. Scanning for ${config.asset.symbol} depth.\n`);

  const found: { pair: string; other: string; symbol: string; depth: bigint }[] = [];

  for (let i = 0; i < count; i++) {
    const address: string = await factory.allPairs(i);
    const pair = new ethers.Contract(address, PAIR_ABI, ethers.provider);

    const [token0, token1] = await Promise.all([pair.token0(), pair.token1()]);
    const assetIsToken0 = token0.toLowerCase() === asset;
    if (!assetIsToken0 && token1.toLowerCase() !== asset) continue;

    const [r0, r1] = await pair.getReserves();
    const other: string = assetIsToken0 ? token1 : token0;

    let symbol = "?";
    try {
      symbol = await new ethers.Contract(other, ERC20_ABI, ethers.provider).symbol();
    } catch {
      /* a token without a string symbol is still a pair we can report by address */
    }

    found.push({ pair: address, other, symbol, depth: assetIsToken0 ? r0 : r1 });
  }

  found.sort((a, b) => (b.depth > a.depth ? 1 : b.depth < a.depth ? -1 : 0));

  if (found.length === 0) {
    console.log(`  No pair on this DEX holds ${config.asset.symbol}.\n`);
    return;
  }

  for (const entry of found) {
    const depth = Number(ethers.formatUnits(entry.depth, config.asset.decimals));
    console.log(
      `  ${entry.symbol.padEnd(10)} ${depth.toLocaleString("en-US", { maximumFractionDigits: 2 }).padStart(14)} ` +
        `${config.asset.symbol}   pair ${entry.pair}  paired ${entry.other}`,
    );
  }

  const deepest = found[0];
  const suggestedCap = Math.floor(
    Number(ethers.formatUnits(deepest.depth, config.asset.decimals)) * 0.075,
  );
  console.log(
    `\n  Deepest is ${config.asset.symbol}/${deepest.symbol}. At the same ~7.5% of depth the testnet ` +
      `leg uses, LEG_CAP would be ${suggestedCap} ${config.asset.symbol}.\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
