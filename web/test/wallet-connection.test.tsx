import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { connect, disconnect, getAccount, getChainId, switchChain } from "wagmi/actions";

import {
  botChain,
  botTestnet,
  defaultChainId,
  hardhatChain,
  supportedChains,
  explorerUrlFor,
} from "@/lib/chains";
import { configuredChainIds, dataModeFor, deploymentFor, legsFor } from "@/lib/contracts";
import { createTestConfig, TEST_ACCOUNT } from "./fixtures";

/**
 * build.md §7.3 — "Wallet connection on BOT Chain".
 *
 * Uses wagmi's mock connector against the app's own chain definitions, not test-local copies.
 * That is the whole value of the file: a wallet test that connects to a chain the app does not
 * actually ship would pass while every user landed on the wrong network. These definitions were
 * wrong once — the testnet was configured as chain 678 on a hostname that does not resolve.
 */
describe("BOT Chain definitions", () => {
  it("defines mainnet as chain 677 on botchain.ai", () => {
    expect(botChain.id).to.equal(677);
    expect(botChain.nativeCurrency.symbol).to.equal("BOT");
    expect(botChain.rpcUrls.default.http[0]).to.contain("rpc.botchain.ai");
    expect(botChain.blockExplorers?.default.url).to.equal("https://scan.botchain.ai");
  });

  it("defines testnet as chain 968 on bohr.life, not a botchain.ai subdomain", () => {
    // The regression: 678 / testnet-rpc.botchain.ai, neither of which exists.
    expect(botTestnet.id).to.equal(968);
    expect(botTestnet.rpcUrls.default.http[0]).to.equal("https://rpc.bohr.life");
    expect(botTestnet.blockExplorers?.default.url).to.equal("https://scan.bohr.life");
    expect(botTestnet.testnet).to.equal(true);
  });

  it("offers mainnet, testnet and a local node", () => {
    expect(supportedChains.map((c) => c.id)).to.deep.equal([677, 968, 31337]);
    expect(hardhatChain.id).to.equal(31337);
  });

  it("builds explorer links per chain rather than hardcoding one host", () => {
    expect(explorerUrlFor(968, "tx", "0xabc")).to.equal("https://scan.bohr.life/tx/0xabc");
    expect(explorerUrlFor(677, "address", "0xdef")).to.equal(
      "https://scan.botchain.ai/address/0xdef",
    );
    // A chain with no explorer must yield nothing, not a broken relative link.
    expect(explorerUrlFor(31337, "tx", "0xabc")).to.equal("");
  });
});

describe("connecting a wallet", () => {
  it("starts disconnected", () => {
    const config = createTestConfig();
    expect(getAccount(config).isConnected).to.equal(false);
  });

  it("connects and reports the account and BOT Chain testnet", async () => {
    const config = createTestConfig();
    await connect(config, { connector: config.connectors[0] });

    await waitFor(() => expect(getAccount(config).isConnected).to.equal(true));
    expect(getAccount(config).address).to.equal(TEST_ACCOUNT);
    expect(getChainId(config)).to.equal(968);
  });

  it("disconnects cleanly", async () => {
    const config = createTestConfig();
    await connect(config, { connector: config.connectors[0] });
    await disconnect(config, { connector: config.connectors[0] });

    await waitFor(() => expect(getAccount(config).isConnected).to.equal(false));
    expect(getAccount(config).address).to.equal(undefined);
  });

  it("refuses a chain the app does not support", async () => {
    const config = createTestConfig();
    await connect(config, { connector: config.connectors[0] });

    // 1 = Ethereum mainnet, deliberately absent from the config.
    await expect(switchChain(config, { chainId: 1 as never })).rejects.toThrow();
    expect(getChainId(config)).to.equal(968);
  });
});

describe("what the app knows per chain", () => {
  it("has a deployment for testnet 968", () => {
    expect(configuredChainIds()).to.contain(968);

    const record = deploymentFor(968);
    expect(record).to.not.equal(null);
    expect(record?.asset.symbol).to.equal("USDT");
    expect(record?.asset.decimals).to.equal(6);
  });

  it("has a deployment for mainnet 677", () => {
    expect(configuredChainIds()).to.contain(677);

    const record = deploymentFor(677);
    expect(record).to.not.equal(null);
    expect(record?.asset.symbol).to.equal("USDT");
    expect(record?.asset.decimals).to.equal(6);

    // Mainnet's pool is ~250x thinner than testnet's, so it is deployed at a much smaller
    // cap. Pinning it here catches a testnet-sized manifest being shipped as mainnet — the
    // mistake a shared LEG_CAP in .env very nearly caused on the first mainnet deploy.
    expect(Number(record?.config.depositCap)).to.be.lessThan(100);
  });

  it("defaults to mainnet before a wallet connects", () => {
    // The hosted build sets no environment, so this fallback is what the live site uses.
    expect(defaultChainId).to.equal(677);
    expect(deploymentFor(defaultChainId)).to.not.equal(null);
  });

  it("reports live provenance on both chains, with no demo state to fall into", () => {
    for (const id of [677, 968]) {
      expect(dataModeFor(id)).to.equal("live");
      expect(deploymentFor(id)?.sources).to.equal("live");
    }
  });

  it("reports an unconfigured chain instead of guessing an address", () => {
    expect(dataModeFor(1)).to.equal("unconfigured");
    expect(deploymentFor(1)).to.equal(null);
    expect(legsFor(1)).to.deep.equal([]);
  });

  it("knows the venue behind each deployed leg", () => {
    const legs = legsFor(968);
    expect(legs.length).to.be.greaterThan(0);
    expect(legs[0].pairedSymbol).to.equal("WBOT");
    expect(legs[0].pair).to.match(/^0x[0-9a-fA-F]{40}$/);
    // The pair must not be one of our own contracts.
    expect(legs[0].pair).to.not.equal(legs[0].adapter);
  });
});
