import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Withdraws the runner's entire position from a deployment.
 *
 * Useful when retiring a deployment, and it exercises the honest-maximum path from the outside:
 * the amount it can take out is `maxWithdraw`, not the nominal value of the shares. Because that
 * figure is derived from live pool reserves, it also applies a small margin — a trade landing
 * between the quote and the transaction moves the maximum, and the vault will correctly refuse
 * a request that has gone stale by even a few units.
 *
 *   VAULT_ADDRESS=0x… npx hardhat run scripts/exit.ts --network botTestnet
 */

const MARGIN_BPS = 9_950n; // request 99.5% of the quote

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;

  const vaultAddress = process.env.VAULT_ADDRESS || manifest?.contracts?.vault;
  if (!vaultAddress) {
    throw new Error("No vault address. Set VAULT_ADDRESS or deploy first.");
  }

  const [user] = await ethers.getSigners();
  const vault = await ethers.getContractAt("BotVault", vaultAddress);

  const assetAddress: string = await vault.asset();
  const asset = new ethers.Contract(
    assetAddress,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
    ],
    ethers.provider,
  );

  const decimals = Number(await asset.decimals());
  const symbol: string = await asset.symbol();
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(6)} ${symbol}`;

  const shares: bigint = await vault.balanceOf(user.address);
  if (shares === 0n) {
    console.log(`\n  ${user.address} holds no shares in ${vaultAddress}.\n`);
    return;
  }

  console.log(`\n  Exiting ${vaultAddress}`);
  console.log(`  ${"-".repeat(58)}`);
  console.log(`  shares          ${fmt(shares)}`);
  console.log(`  nominal value   ${fmt(await vault.convertToAssets(shares))}`);

  const quoted: bigint = await vault.maxWithdraw(user.address);
  const request = (quoted * MARGIN_BPS) / 10_000n;

  console.log(`  exitable now    ${fmt(quoted)}`);
  console.log(`  requesting      ${fmt(request)}  (99.5% of the quote)`);

  if (request === 0n) {
    console.log(`\n  Nothing can be freed this block.\n`);
    return;
  }

  const before: bigint = await asset.balanceOf(user.address);
  const tx = await vault.withdraw(request, user.address, user.address);
  const receipt = await tx.wait();
  const received: bigint = (await asset.balanceOf(user.address)) - before;

  console.log(`\n  received        ${fmt(received)}`);
  console.log(`  shares left     ${fmt(await vault.balanceOf(user.address))}`);
  console.log(`  gas             ${receipt?.gasUsed}`);
  console.log(`  tx              ${tx.hash}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
