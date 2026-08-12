import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { configFor, reserveBufferBps, scaled, type NetworkConfig } from "./config";

/**
 * Deploys the Phony stack against real protocol addresses.
 *
 * Deployment order is vault -> router -> adapters, which inverts the naive reading of the
 * architecture. The reason is mutual binding: the router's `onlyVault` guard and each
 * adapter's `onlyRouter` guard are set at construction, so every layer needs the address of
 * the layer above it. The vault is then pointed at the router in a second transaction.
 *
 * Nothing here deploys a token or a yield source. The asset is the chain's USDT and the yield
 * source is a live BDEX pair, so the script's job before deploying anything is to prove those
 * exist, agree with the config, and hold real liquidity.
 */

interface LegRecord {
  key: string;
  name: string;
  risk: string;
  adapter: string;
  pair: string;
  pairedToken: string;
  pairedSymbol: string;
  weightBps: string;
  capWhole: string;
}

const RULE = "-".repeat(64);
const log = (label: string, value: string) => console.log(`  ${label.padEnd(30)}${value}`);

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

/** Confirms the configured asset really is the token the config claims it is. */
async function verifyAsset(config: NetworkConfig) {
  const asset = new ethers.Contract(config.asset.address, ERC20_ABI, ethers.provider);
  const [symbol, decimals] = await Promise.all([asset.symbol(), asset.decimals()]);

  if (Number(decimals) !== config.asset.decimals) {
    throw new Error(
      `Asset at ${config.asset.address} reports ${decimals} decimals, config says ` +
        `${config.asset.decimals}. Every amount in the deployment would be wrong by ` +
        `10^${Math.abs(Number(decimals) - config.asset.decimals)}.`,
    );
  }

  log("asset", `${symbol} (${decimals} dp) ${config.asset.address}`);
  return { symbol: String(symbol), decimals: Number(decimals) };
}

/** Resolves each leg's pair through the DEX factory and rejects empty pools. */
async function resolvePairs(config: NetworkConfig) {
  const dexRouter = new ethers.Contract(
    config.dex.router,
    ["function factory() view returns (address)"],
    ethers.provider,
  );
  const factoryAddress: string = await dexRouter.factory();
  const factory = new ethers.Contract(
    factoryAddress,
    ["function getPair(address,address) view returns (address)"],
    ethers.provider,
  );

  log("BDEX V2 router", config.dex.router);
  log("BDEX V2 factory", factoryAddress);

  const resolved: Array<{ leg: NetworkConfig["legs"][number]; pair: string; depth: bigint }> = [];

  for (const leg of config.legs) {
    const pairAddress: string = await factory.getPair(config.asset.address, leg.pairedToken);
    if (pairAddress === ethers.ZeroAddress) {
      throw new Error(
        `No BDEX V2 pair for ${config.asset.symbol}/${leg.pairedSymbol}. There is nothing to ` +
          `provide liquidity to, so this leg cannot be deployed.`,
      );
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
    const assetIsToken0 = token0.toLowerCase() === config.asset.address.toLowerCase();
    const depth: bigint = assetIsToken0 ? r0 : r1;

    if (depth === 0n) {
      throw new Error(`Pair ${pairAddress} holds no ${config.asset.symbol}. Refusing to deploy.`);
    }

    const cap = scaled(leg.capWhole, config.asset.decimals);
    if (cap > depth) {
      console.log(
        `\n  warning: ${leg.key} cap (${leg.capWhole} ${config.asset.symbol}) exceeds pool ` +
          `depth (${ethers.formatUnits(depth, config.asset.decimals)}). Entry at the cap ` +
          `would move the price against itself.\n`,
      );
    }

    log(
      `pair ${leg.key}`,
      `${pairAddress}  depth ${Number(
        ethers.formatUnits(depth, config.asset.decimals),
      ).toLocaleString("en-US")} ${config.asset.symbol}`,
    );

    resolved.push({ leg, pair: pairAddress, depth });
  }

  return resolved;
}

async function main() {
  const config = configFor(network.name);
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  Phony deployment -- ${config.label}`);
  console.log(`  ${RULE}`);
  log("network", `${network.name} (chainId ${chainId})`);
  log("deployer", deployer.address);
  log("balance", `${ethers.formatEther(balance)} BOT`);
  log("sources", "live protocol addresses (no mocks)");
  console.log(`  ${RULE}\n`);

  if (balance === 0n) {
    throw new Error(
      network.name === "botTestnet"
        ? "Deployer has no gas. Claim tBOT at https://faucet.botchain.ai/basic"
        : "Deployer has no gas. Apply at https://forms.gle/QGWNnmthCDgL92uR9",
    );
  }

  /* --- 1. Prove the external world is what the config says ------------- */

  const assetInfo = await verifyAsset(config);
  const pairs = await resolvePairs(config);
  console.log();

  const contracts: Record<string, string> = { asset: config.asset.address };

  /* --- 2. Vault ------------------------------------------------------- */

  const vault = await ethers.deployContract("BotVault", [
    config.asset.address,
    config.vault.name,
    config.vault.symbol,
    deployer.address,
    process.env.FEE_RECIPIENT || deployer.address,
  ]);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  contracts.vault = vaultAddress;
  log(`BotVault (${config.vault.symbol})`, vaultAddress);

  /* --- 3. Router ------------------------------------------------------ */

  const router = await ethers.deployContract("StrategyRouter", [
    config.asset.address,
    vaultAddress,
    deployer.address,
  ]);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  contracts.router = routerAddress;
  log("StrategyRouter", routerAddress);

  /* --- 4. One adapter per real venue ---------------------------------- */

  const legs: LegRecord[] = [];

  for (const { leg, pair } of pairs) {
    const adapter = await ethers.deployContract("BdexV2LpStrategy", [
      config.asset.address,
      routerAddress,
      config.dex.router,
      pair,
      config.maxSlippageBps,
      leg.name,
      deployer.address,
    ]);
    await adapter.waitForDeployment();
    const adapterAddress = await adapter.getAddress();

    contracts[leg.key] = adapterAddress;
    legs.push({
      key: leg.key,
      name: leg.name,
      risk: leg.risk,
      adapter: adapterAddress,
      pair,
      pairedToken: leg.pairedToken,
      pairedSymbol: leg.pairedSymbol,
      weightBps: leg.weightBps.toString(),
      capWhole: leg.capWhole.toString(),
    });

    log(`BdexV2LpStrategy (${leg.key})`, adapterAddress);
  }

  /* --- 5. Wire it together -------------------------------------------- */

  console.log(`\n  Configuring...`);

  for (const leg of legs) {
    await (
      await router.addStrategy(
        leg.adapter,
        BigInt(leg.weightBps),
        scaled(BigInt(leg.capWhole), assetInfo.decimals),
      )
    ).wait();
    log(`  registered ${leg.key}`, `${Number(leg.weightBps) / 100}% target`);
  }

  await (await vault.setStrategyRouter(routerAddress)).wait();
  log("  router bound to vault", "ok");

  await (await vault.setPerformanceFee(config.performanceFeeBps)).wait();
  log("  performance fee", `${Number(config.performanceFeeBps) / 100}% of yield`);

  if (config.depositCap > 0n) {
    await (await vault.setDepositCap(scaled(config.depositCap, assetInfo.decimals))).wait();
    log("  deposit cap", `${config.depositCap} ${assetInfo.symbol}`);
  }

  /* --- 6. Manifest ---------------------------------------------------- */

  const reserveBps = reserveBufferBps(config);

  const manifest = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    /** No mock yield sources exist in this deployment. Kept explicit for the frontend. */
    sources: "live" as const,
    asset: { address: config.asset.address, symbol: assetInfo.symbol, decimals: assetInfo.decimals },
    dex: { router: config.dex.router },
    contracts,
    legs,
    config: {
      allocationsBps: Object.fromEntries(legs.map((l) => [l.key, l.weightBps])),
      performanceFeeBps: config.performanceFeeBps.toString(),
      depositCap: config.depositCap.toString(),
      reserveBufferBps: reserveBps.toString(),
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify(manifest, null, 2));

  const verifyTarget = network.name === "botMainnet" ? "mainnet" : "testnet";

  console.log(`\n  ${RULE}`);
  log("manifest", `deployments/${network.name}.json`);
  log("idle reserve", `${Number(reserveBps) / 100}% (instantly exitable)`);
  console.log(`\n  Next:`);
  console.log(`    npm run export-abi           -> push addresses + ABIs to web/`);
  console.log(`    npm run verify:${verifyTarget.padEnd(14)}-> verify on BOTScan`);
  console.log(`    npm run e2e:${verifyTarget.padEnd(17)}-> full loop against real BDEX\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
