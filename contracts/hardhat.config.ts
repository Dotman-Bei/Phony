import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // BOT Chain's EVM target is pre-Shanghai, so PUSH0 must stay out of the bytecode.
      // Compiling to `paris` costs a few gas and removes an entire class of "deploys fine
      // locally, reverts on chain" failure.
      evmVersion: "paris",
      viaIR: false,
    },
  },
  networks: {
    // The in-process network forks BOT Chain testnet, so the test suite runs against the
    // real BDEX V2 deployment and the real USDT rather than stand-ins for them. There are no
    // mock contracts in this project to fall back on, which is the point: a swap in a test is
    // a swap through the same router the vault will use in production, priced by the same
    // reserves. Set NO_FORK=true for the handful of checks that need no external state.
    hardhat: {
      chainId: 31337,
      forking: {
        url: process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life",
        enabled: process.env.NO_FORK !== "true",
        // Pin a block for reproducible reserves; unpinned follows the live pool.
        blockNumber: process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined,
      },
      // Hardhat ships hardfork histories for the chains it knows and refuses to execute
      // historical blocks for the ones it does not. BOT Chain implements EIP-4844, so its
      // whole history is Cancun-capable as far as this fork is concerned.
      chains: {
        968: { hardforkHistory: { cancun: 0 } },
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    // BOT Chain testnet is chain 968 and is served from bohr.life, not a botchain.ai
    // subdomain. Both values are from the official dev docs:
    // https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/
    botTestnet: {
      url: process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life",
      chainId: Number(process.env.BOT_TESTNET_CHAIN_ID || 968),
      accounts,
    },
    botMainnet: {
      url: process.env.BOT_MAINNET_RPC || "https://rpc.botchain.ai",
      chainId: 677,
      accounts,
    },
  },
  etherscan: {
    // BOT Chain's explorer is Blockscout-flavoured; it accepts any non-empty key.
    apiKey: {
      botTestnet: process.env.EXPLORER_API_KEY || "empty",
      botMainnet: process.env.EXPLORER_API_KEY || "empty",
    },
    customChains: [
      {
        network: "botTestnet",
        chainId: Number(process.env.BOT_TESTNET_CHAIN_ID || 968),
        urls: {
          apiURL: process.env.BOT_TESTNET_EXPLORER_API || "https://scan.bohr.life/api",
          browserURL: process.env.BOT_TESTNET_EXPLORER || "https://scan.bohr.life",
        },
      },
      {
        network: "botMainnet",
        chainId: 677,
        urls: {
          apiURL: process.env.BOT_MAINNET_EXPLORER_API || "https://scan.botchain.ai/api",
          browserURL: "https://scan.botchain.ai",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
