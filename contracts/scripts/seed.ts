import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Seeds a deployment with real activity: deposits from several accounts, time advanced
 * between them, and harvests recorded on chain.
 *
 * The point is the portfolio page. Its yield chart plots `Harvested` events and nothing
 * else, so a freshly deployed vault renders an empty state — correct, but it makes the
 * page impossible to review. This script produces genuine history rather than letting the
 * frontend fake one.
 *
 * Time travel only works on a local Hardhat node. On testnet the script still deposits and
 * harvests; yield is simply whatever has accrued in wall-clock time.
 */

const MONTH = 30 * 24 * 60 * 60;

async function advance(seconds: number): Promise<boolean> {
  try {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest at deployments/${network.name}.json -- deploy first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.usesMocks) {
    throw new Error("Refusing to seed a deployment wired to live yield sources.");
  }

  const c = manifest.contracts as Record<string, string>;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  // Fall back to the deployer when the network exposes a single key, as testnets do.
  const users = signers.length >= 4 ? signers.slice(1, 4) : [deployer, deployer, deployer];

  const vault = await ethers.getContractAt("BotVault", c.vault);
  const asset = await ethers.getContractAt("MockRWAToken", c.asset);
  const decimals = Number(await asset.decimals());
  const symbol = await asset.symbol();

  const amount = (whole: number) => ethers.parseUnits(whole.toString(), decimals);
  const fmt = (v: bigint) => `${Number(ethers.formatUnits(v, decimals)).toFixed(2)} ${symbol}`;

  console.log(`\n  Seeding ${network.name}`);
  console.log(`  ${"-".repeat(56)}`);

  const canTimeTravel = await advance(1);
  if (!canTimeTravel) {
    console.log(`  note: this network does not support time travel; yield will be small.\n`);
  }

  const deposits = [12_000, 8_500, 20_000];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const value = amount(deposits[i]);

    if ((await asset.balanceOf(user.address)) < value) {
      await (await asset.connect(deployer).mint(user.address, value * 2n)).wait();
    }
    if ((await asset.allowance(user.address, c.vault)) < value) {
      await (await asset.connect(user).approve(c.vault, ethers.MaxUint256)).wait();
    }

    await (await vault.connect(user).deposit(value, user.address)).wait();
    console.log(`  deposit   ${fmt(value)} from ${user.address.slice(0, 10)}...`);

    if (canTimeTravel) {
      await advance(MONTH);
      await (await vault.harvest()).wait();
      console.log(`  harvest   month ${i + 1}  ->  share price ${ethers.formatUnits(await vault.sharePrice(), decimals)}`);
    }
  }

  // A partial exit, so the history has all three event types in it.
  if (users[1] !== deployer) {
    const trim = amount(2_000);
    if ((await vault.maxWithdraw(users[1].address)) >= trim) {
      await (await vault.connect(users[1]).withdraw(trim, users[1].address, users[1].address)).wait();
      console.log(`  withdraw  ${fmt(trim)}`);
    }
  }

  if (canTimeTravel) {
    await advance(MONTH);
    await (await vault.harvest()).wait();
    console.log(`  harvest   final`);
  }

  console.log(`  ${"-".repeat(56)}`);
  console.log(`  TVL              ${fmt(await vault.totalAssets())}`);
  console.log(`  deployed         ${fmt(await vault.deployedAssets())}`);
  console.log(`  idle reserve     ${fmt(await vault.idleAssets())}`);
  console.log(`  lifetime yield   ${fmt(await vault.totalYieldHarvested())}`);
  console.log(`  share price      ${ethers.formatUnits(await vault.sharePrice(), decimals)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
