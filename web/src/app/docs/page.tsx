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
          Architecture and deployed addresses.
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
              Holds the curator&apos;s whitelist and the weights between adapters. Deployment is
              sized against NAV rather than against each deposit, so the buffer is a level the
              vault returns to rather than one that erodes as capital is routed again;
              withdrawals are pulled proportionally so the distribution survives an exit;
              harvests are swept in one pass. Weights that do not sum to 100% leave the
              remainder idle in the vault as the reserve buffer — currently{" "}
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
    </div>
  );
}
