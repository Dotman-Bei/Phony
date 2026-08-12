import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates a fresh deployer keypair and writes it into `contracts/.env`.
 *
 * For testnet work a throwaway key is the right default: it holds nothing but faucet tBOT,
 * so leaking it costs nothing, and it keeps a key that guards real funds off disk. The key
 * is written to the (gitignored) .env and never printed in full — read it out of the file
 * if you need to back it up.
 *
 * Refuses to overwrite an existing PRIVATE_KEY. Clear the line first if that is the intent;
 * silently replacing it would orphan whatever that address already owns on chain.
 *
 *   npx hardhat run scripts/newDeployer.ts
 */

const ENV_PATH = path.join(__dirname, "..", ".env");

function main() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error("contracts/.env does not exist. Copy .env.example to .env first.");
  }

  const env = fs.readFileSync(ENV_PATH, "utf8");
  const existing = /^PRIVATE_KEY=(.*)$/m.exec(env);

  if (!existing) {
    throw new Error("contracts/.env has no PRIVATE_KEY line to fill in.");
  }

  if (existing[1].trim() !== "") {
    throw new Error(
      "PRIVATE_KEY is already set in contracts/.env. Clear that line first if you really " +
        "want a new deployer — the current one may already own deployed contracts.",
    );
  }

  const wallet = ethers.Wallet.createRandom();
  fs.writeFileSync(ENV_PATH, env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${wallet.privateKey}`));

  const masked = `${wallet.privateKey.slice(0, 6)}...${wallet.privateKey.slice(-4)}`;

  console.log(`\n  New deployer written to contracts/.env`);
  console.log(`  ${"-".repeat(58)}`);
  console.log(`  address        ${wallet.address}`);
  console.log(`  private key    ${masked}  (full value is in .env, which git ignores)`);
  console.log(`\n  Fund it, then deploy:`);
  console.log(`    1. https://faucet.botchain.ai/basic  ->  ${wallet.address}`);
  console.log(`    2. npx hardhat run scripts/preflight.ts --network botTestnet`);
  console.log(`    3. npm run deploy:testnet\n`);
}

try {
  main();
} catch (error) {
  console.error(`\n  ${(error as Error).message}\n`);
  process.exitCode = 1;
}
