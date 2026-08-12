"use client";

import { useChainId } from "wagmi";
import { ExternalLink } from "lucide-react";

import { ModeBadge, Panel } from "@/components/primitives";
import { useVaultData } from "@/hooks/useVault";
import { deploymentFor } from "@/lib/contracts";
import { explorerUrlFor } from "@/lib/chains";
import { formatBps } from "@/lib/format";

const CONTRACT_ROWS: Array<{ key: string; label: string; note: string }> = [
  { key: "vault", label: "BotVault", note: "ERC-4626 vault, share token brRWA" },
  { key: "router", label: "StrategyRouter", note: "Allocation and rebalancing engine" },
  { key: "wbotLp", label: "BdexV2LpStrategy", note: "Single-sided LP adapter for a BDEX V2 pair" },
  { key: "asset", label: "Asset", note: "USDT — the chain's own token, not one we minted" },
];

const RESEARCH = [
  {
    name: "StakeKit / Yield.xyz",
    repo: "stakekit/yield.xyz",
    url: "https://github.com/stakekit/yield.xyz",
    applied:
      "Their unified yield API across 70+ networks establishes that aggregation needs one standardised interface per source. Phony's IStrategyAdapter is that interface, scoped to RWA yield on BOT Chain.",
  },
  {
    name: "Ditto Network — curator vault",
    repo: "dittonetwork/curator-vault",
    url: "https://github.com/dittonetwork/curator-vault",
    applied:
      "The curator pattern, reduced to its safe core: the curator may whitelist adapters, weight them, and retire them, but every capital path leads back to the vault. There is no owner-controlled arbitrary transfer.",
  },
  {
    name: "OpenZeppelin Contracts",
    repo: "OpenZeppelin/openzeppelin-contracts",
    url: "https://github.com/OpenZeppelin/openzeppelin-contracts",
    applied:
      "BotVault inherits ERC4626, Ownable, Pausable and ReentrancyGuard directly. The virtual-shares defence against first-depositor inflation comes with the base implementation.",
  },
  {
    name: "ERC-3643 / T-REX",
    repo: "aboudjem/ERC-3643",
    url: "https://github.com/aboudjem/ERC-3643",
    applied:
      "Not implemented, but the adapter interface is deliberately narrow enough that a future ERC3643Adapter could enforce identity and compliance checks before deposit without changing the vault.",
  },
  {
    name: "VaultWatch",
    repo: "VaultWatch/vaultwatch-contracts",
    url: "https://github.com/VaultWatch",
    applied:
      "Their keeper-orchestration pattern informed the HarvestBot: batch every strategy into one transaction, emit events for auditability, and gate execution on yield clearing a multiple of gas cost.",
  },
];

export default function DocsPage() {
  const chainId = useChainId();
  const vault = useVaultData();
  const deployment = deploymentFor(chainId);

  return (
    <div className="content section stack-32">
      <header>
        <span className="eyebrow">Documentation</span>
        <h1 className="lit-heading" style={{ marginTop: 16 }}>
          How Phony works.
        </h1>
        <p className="lead" style={{ marginTop: 18 }}>
          Architecture, deployed addresses, and the open-source research the design is built
          on.
        </p>
        <div style={{ marginTop: 22 }}>
          <ModeBadge mode={vault.mode} />
        </div>
      </header>

      <Panel index="01" title="Architecture" state="Three layers">
        <div className="panel-body stack-16">
          <div className="policy-card">
            <h4>BotVault — the deposit interface</h4>
            <p>
              An ERC-4626 vault over one tokenized RWA. Deposits mint brRWA shares priced off
              live NAV; withdrawals burn them. totalAssets() sums the vault&apos;s idle balance
              and every adapter&apos;s holdings on every call, so the share price is a
              measurement rather than a stored figure. maxWithdraw is bounded by what the
              strategies can actually free this block.
            </p>
          </div>

          <div className="policy-card">
            <h4>StrategyRouter — the allocation engine</h4>
            <p>
              Holds the curator&apos;s whitelist and the weights between adapters. Deposits are
              split by weight; withdrawals are pulled proportionally so the distribution
              survives an exit; harvests are swept in one pass. Weights that do not sum to
              100% leave the remainder idle in the vault as the reserve buffer — currently{" "}
              {formatBps(vault.reserveBps, 0)}.
            </p>
          </div>

          <div className="policy-card">
            <h4>Strategy adapters — the yield boundary</h4>
            <p>
              Each implements deposit, withdraw, harvest, totalAssets, availableLiquidity, and
              an APY estimate. BaseStrategy enforces the invariant that makes compounding
              safe: yield equals totalAssets minus principal, and harvest transfers exactly
              that and never more. A strategy in drawdown reports zero yield instead of paying
              principal out as profit.
            </p>
          </div>
        </div>
      </Panel>

      <Panel index="02" title="The compounding mechanism" state="No rebasing">
        <div className="panel-body">
          <p style={{ fontSize: 15, lineHeight: "25px", color: "var(--text-secondary)" }}>
            Harvested yield is transferred into the vault while total share supply stays
            fixed. NAV rises, supply does not, so convertToAssets returns more for the same
            share. Nothing is minted, nothing is claimed, and no balance rebases — which is
            why the position stays composable with any protocol that understands ERC-4626.
          </p>
          <p style={{ marginTop: 16, fontSize: 15, lineHeight: "25px", color: "var(--muted)" }}>
            harvest() is permissionless and pays the caller nothing. The HarvestBot keeper
            runs it on a schedule, holding until pending yield clears a multiple of the
            estimated gas cost, with a time backstop so a quiet vault is still swept.
          </p>
        </div>
      </Panel>

      <Panel
        index="03"
        title="Deployed contracts"
        state={deployment ? deployment.network : "Not deployed"}
      >
        {deployment ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Role</th>
                  <th>Address</th>
                </tr>
              </thead>
              <tbody>
                {CONTRACT_ROWS.map((row) => {
                  const address = deployment.contracts[row.key];
                  if (!address) return null;
                  return (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td style={{ whiteSpace: "normal", color: "var(--muted)" }}>{row.note}</td>
                      <td>
                        <a
                          className="text-link"
                          href={explorerUrlFor(chainId, "address", address)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                        >
                          {address.slice(0, 10)}…{address.slice(-6)}
                          <ExternalLink size={10} strokeWidth={2.5} />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel-body">
            <div className="empty-state" data-note="No deployment">
              No Phony deployment on this network. Switch to BOT Chain Testnet.
            </div>
          </div>
        )}
      </Panel>

      <Panel index="04" title="Research basis" state="Five references">
        <div className="panel-body stack-16">
          {RESEARCH.map((item) => (
            <div className="policy-card" key={item.repo}>
              <h4>
                <a className="text-link" href={item.url} target="_blank" rel="noreferrer">
                  {item.name}
                </a>{" "}
                <span className="micro" style={{ marginLeft: 6 }}>
                  {item.repo}
                </span>
              </h4>
              <p>{item.applied}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel index="05" title="Security posture" state="MVP">
        <div className="panel-body stack-12">
          <dl className="stack-0">
            <div className="quote-row">
              <dt>Reentrancy</dt>
              <dd>ReentrancyGuard on every external entrypoint in vault, router, adapters</dd>
            </div>
            <div className="quote-row">
              <dt>Overflow</dt>
              <dd>Solidity 0.8 checked arithmetic throughout</dd>
            </div>
            <div className="quote-row">
              <dt>Strategy failure</dt>
              <dd>Per-strategy caps, emergency exit per adapter, vault-wide pause and recall</dd>
            </div>
            <div className="quote-row">
              <dt>Curator power</dt>
              <dd>No admin path to an arbitrary transfer; vault asset excluded from rescue</dd>
            </div>
            <div className="quote-row">
              <dt>Price oracles</dt>
              <dd>None. Yield is measured against principal held by each adapter</dd>
            </div>
            <div className="quote-row">
              <dt>Audit status</dt>
              <dd>Unaudited hackathon build. Deposit accordingly</dd>
            </div>
          </dl>
        </div>
      </Panel>
    </div>
  );
}
