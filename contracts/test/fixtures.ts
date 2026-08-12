import { ethers } from "hardhat";
import { impersonateAccount, mine, setBalance } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Test fixtures — against the real BDEX deployment.
 *
 * This project contains no mock contracts, so the suite runs on a fork of BOT Chain testnet.
 * The asset is the chain's actual USDT and the yield source is a live BDEX V2 pair, which means
 * a swap in a test is a swap through the same router the vault uses in production, priced by the
 * same reserves and paying the same 0.3% fee.
 *
 * Two consequences worth knowing when reading the assertions:
 *
 *   1. Test USDT comes from impersonating a large holder, not from minting. There is no mint
 *      function available to us — that is the whole point.
 *   2. Yield is produced by *actually trading* against the pool (`generateTradingFees`), and a
 *      drawdown by *actually moving the price* (`crashPairedToken`). Neither is a setter.
 */

/** Real addresses on BOT Chain testnet (chain 968). */
export const ADDRESSES = {
  usdt: "0x75edC9335175Fc0552D51D48439F229c10420fe3",
  wbot: "0xD5452816194a3784dBa983426cCe7c122F4abd30",
  dexRouter: "0xD6425a02f0845B8D99e349C34D2E7A576E177345",
  /** Holds ~1e23 test USDT; the suite's source of funds. */
  whale: "0x3f14Aee7837002Be71F6567c01F55d86468F6a9c",
} as const;

export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

export const DEX_ROUTER_ABI = [
  "function factory() view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
];

export const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

/** 6-decimal USDT. Written out so the tests read in dollars, not base units. */
export const usdt = (whole: string | number) => ethers.parseUnits(whole.toString(), 6);

export async function deployPhony() {
  // Mine one local block before reading anything. Straight after forking, "latest" *is* the
  // fork block, which the node treats as historical and refuses to execute against without a
  // hardfork activation history for chain 968. One locally produced block moves every
  // subsequent read onto a block the node itself made.
  await mine(1);

  const [curator, alice, bob, feeRecipient] = await ethers.getSigners();

  const asset = new ethers.Contract(ADDRESSES.usdt, ERC20_ABI, ethers.provider);
  const dexRouter = new ethers.Contract(ADDRESSES.dexRouter, DEX_ROUTER_ABI, ethers.provider);

  const decimals = Number(await asset.decimals());
  if (decimals !== 6) {
    throw new Error(`Fork returned ${decimals}-decimal USDT; fixtures assume 6.`);
  }

  /* --- resolve the real pair through the real factory ------------------- */

  const factory = new ethers.Contract(
    await dexRouter.factory(),
    ["function getPair(address,address) view returns (address)"],
    ethers.provider,
  );
  const pairAddress: string = await factory.getPair(ADDRESSES.usdt, ADDRESSES.wbot);
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error("No USDT/WBOT pair on the forked chain — the fork may be misconfigured.");
  }
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, ethers.provider);

  /* --- fund the test accounts from a real holder ------------------------ */

  await impersonateAccount(ADDRESSES.whale);
  await setBalance(ADDRESSES.whale, ethers.parseEther("100"));
  const whale = await ethers.getSigner(ADDRESSES.whale);

  const funding = usdt(50_000);
  for (const account of [curator, alice, bob]) {
    await (asset.connect(whale) as any).transfer(account.address, funding);
  }

  /* --- deploy: vault -> router -> adapter ------------------------------- */

  const vault = await ethers.deployContract("BotVault", [
    ADDRESSES.usdt,
    "Phony RWA Vault",
    "brRWA",
    curator.address,
    feeRecipient.address,
  ]);

  const router = await ethers.deployContract("StrategyRouter", [
    ADDRESSES.usdt,
    await vault.getAddress(),
    curator.address,
  ]);

  const strategy = await ethers.deployContract("BdexV2LpStrategy", [
    ADDRESSES.usdt,
    await router.getAddress(),
    ADDRESSES.dexRouter,
    pairAddress,
    100n, // 1% max slippage
    "BDEX V2 - USDT/WBOT",
    curator.address,
  ]);

  // 60% deployed, 40% left idle as the instantly-exitable reserve.
  await router.addStrategy(await strategy.getAddress(), 6_000n, usdt(2_000));
  await vault.setStrategyRouter(await router.getAddress());
  await vault.setPerformanceFee(1_000n); // 10% of yield

  return {
    curator,
    alice,
    bob,
    feeRecipient,
    whale,
    asset,
    dexRouter,
    pair,
    pairAddress,
    vault,
    router,
    strategy,
    decimals,
  };
}

/**
 * Produce real trading fees by round-tripping volume through the pool.
 *
 * Each swap pays 0.3% into the reserves, which is exactly how a V2 LP earns. Trading both
 * directions leaves the price roughly where it started, so the fees show up as yield rather
 * than as a price move — the two effects are separable, and this helper isolates the first.
 */
export async function generateTradingFees(volume = usdt(2_000), rounds = 6) {
  const [, , , , trader] = await ethers.getSigners();

  const asset = new ethers.Contract(ADDRESSES.usdt, ERC20_ABI, ethers.provider);
  const wbot = new ethers.Contract(ADDRESSES.wbot, ERC20_ABI, ethers.provider);
  const dexRouter = new ethers.Contract(ADDRESSES.dexRouter, DEX_ROUTER_ABI, ethers.provider);

  await impersonateAccount(ADDRESSES.whale);
  await setBalance(ADDRESSES.whale, ethers.parseEther("100"));
  const whale = await ethers.getSigner(ADDRESSES.whale);
  await (asset.connect(whale) as any).transfer(trader.address, volume * BigInt(rounds));

  const deadline = ethers.MaxUint256;

  for (let i = 0; i < rounds; i++) {
    await (asset.connect(trader) as any).approve(ADDRESSES.dexRouter, volume);
    await (dexRouter.connect(trader) as any).swapExactTokensForTokens(
      volume,
      0,
      [ADDRESSES.usdt, ADDRESSES.wbot],
      trader.address,
      deadline,
    );

    const wbotHeld = await wbot.balanceOf(trader.address);
    await (wbot.connect(trader) as any).approve(ADDRESSES.dexRouter, wbotHeld);
    await (dexRouter.connect(trader) as any).swapExactTokensForTokens(
      wbotHeld,
      0,
      [ADDRESSES.wbot, ADDRESSES.usdt],
      trader.address,
      deadline,
    );
  }
}

/**
 * Crash the paired token by dumping a large amount of it into the pool.
 *
 * This is a genuine adverse price move, not a flag: WBOT gets cheaper in USDT terms, and a
 * position holding WBOT is worth less. It is how the drawdown assertions get their drawdown
 * now that no contract has a `setLpValueBps` to call.
 */
export async function crashPairedToken(usdtToSpend = usdt(3_000)) {
  const [, , , , , dumper] = await ethers.getSigners();

  const asset = new ethers.Contract(ADDRESSES.usdt, ERC20_ABI, ethers.provider);
  const wbot = new ethers.Contract(ADDRESSES.wbot, ERC20_ABI, ethers.provider);
  const dexRouter = new ethers.Contract(ADDRESSES.dexRouter, DEX_ROUTER_ABI, ethers.provider);

  await impersonateAccount(ADDRESSES.whale);
  await setBalance(ADDRESSES.whale, ethers.parseEther("100"));
  const whale = await ethers.getSigner(ADDRESSES.whale);
  await (asset.connect(whale) as any).transfer(dumper.address, usdtToSpend);

  // Buy WBOT, then sell strictly more than was bought so the pool ends up long WBOT and the
  // price ends below where it started.
  await (asset.connect(dumper) as any).approve(ADDRESSES.dexRouter, usdtToSpend);
  await (dexRouter.connect(dumper) as any).swapExactTokensForTokens(
    usdtToSpend,
    0,
    [ADDRESSES.usdt, ADDRESSES.wbot],
    dumper.address,
    ethers.MaxUint256,
  );

  const wbotHeld = await wbot.balanceOf(dumper.address);
  await (wbot.connect(dumper) as any).approve(ADDRESSES.dexRouter, wbotHeld);
  await (dexRouter.connect(dumper) as any).swapExactTokensForTokens(
    wbotHeld,
    0,
    [ADDRESSES.wbot, ADDRESSES.usdt],
    dumper.address,
    ethers.MaxUint256,
  );
}
