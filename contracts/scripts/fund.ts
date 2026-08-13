import { ethers, network } from "hardhat";

import { configFor } from "./config";

/**
 * Sends a test wallet what it needs to use the app: some native BOT for gas and some of the
 * vault asset to deposit.
 *
 * The asset is the chain's real USDT, so there is no faucet to call and no mint function to
 * abuse. If the runner is short, this buys USDT by swapping native BOT through the same BDEX
 * router the vault's strategy uses.
 *
 *   RECIPIENT=0xYourWallet npx hardhat run scripts/fund.ts --network botTestnet
 *
 * Optional: USDT_AMOUNT (default 3), GAS_AMOUNT in BOT (default 0.3, 0 to skip).
 */

async function main() {
  const recipient = process.env.RECIPIENT;
  if (!recipient || !ethers.isAddress(recipient)) {
    throw new Error("Set RECIPIENT to the wallet address you want funded.");
  }

  const config = configFor(network.name);
  const [sender] = await ethers.getSigners();

  const asset = new ethers.Contract(
    config.asset.address,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
    ],
    sender,
  );

  const decimals = Number(await asset.decimals());
  const symbol: string = await asset.symbol();
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(6)} ${symbol}`;

  const want = ethers.parseUnits(process.env.USDT_AMOUNT || "3", decimals);
  const gas = ethers.parseEther(process.env.GAS_AMOUNT || "0.3");

  console.log(`\n  Funding ${recipient}`);
  console.log(`  ${"-".repeat(58)}`);
  console.log(`  from            ${sender.address}`);

  /* --- buy the asset if we are short ----------------------------------- */

  let held: bigint = await asset.balanceOf(sender.address);
  console.log(`  sender holds    ${fmt(held)}`);

  if (held < want) {
    const dexRouter = new ethers.Contract(
      config.dex.router,
      [
        "function WETH() view returns (address)",
        "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
        "function getAmountsOut(uint256,address[]) view returns (uint256[])",
      ],
      sender,
    );

    const wbot: string = await dexRouter.WETH();
    const spend = ethers.parseEther(process.env.BOT_SPEND || "1");
    const quote = await dexRouter.getAmountsOut(spend, [wbot, config.asset.address]);

    console.log(`  swapping        ${ethers.formatEther(spend)} BOT -> ~${fmt(quote[1])} on BDEX`);

    await (
      await dexRouter.swapExactETHForTokens(
        0,
        [wbot, config.asset.address],
        sender.address,
        Math.floor(Date.now() / 1000) + 600,
        { value: spend },
      )
    ).wait();

    held = await asset.balanceOf(sender.address);
    console.log(`  sender holds    ${fmt(held)}`);
  }

  const send = held < want ? held : want;
  if (send === 0n) throw new Error("Nothing to send.");

  /* --- transfer -------------------------------------------------------- */

  const assetTx = await asset.transfer(recipient, send);
  await assetTx.wait();
  console.log(`\n  sent            ${fmt(send)}`);
  console.log(`  tx              ${assetTx.hash}`);

  if (gas > 0n) {
    const gasTx = await sender.sendTransaction({ to: recipient, value: gas });
    await gasTx.wait();
    console.log(`  sent            ${ethers.formatEther(gas)} BOT for gas`);
    console.log(`  tx              ${gasTx.hash}`);
  }

  console.log(`\n  recipient now holds ${fmt(await asset.balanceOf(recipient))} and ` +
    `${ethers.formatEther(await ethers.provider.getBalance(recipient))} BOT\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
