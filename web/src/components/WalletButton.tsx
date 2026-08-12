"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { AlertTriangle, Wallet } from "lucide-react";

import { LiquidButton } from "@/components/ui/liquid-glass-button";

/**
 * Wallet connection, rendered as a liquid glass button.
 *
 * RainbowKit's default `<ConnectButton />` renders its own markup and cannot be restyled,
 * so this goes through `ConnectButton.Custom` -- the render-prop API that hands over the
 * connection state and modal openers and lets the button be anything.
 *
 * Three states, and the middle one is the reason this is worth doing properly:
 *
 *   disconnected   -> "Connect wallet"
 *   wrong network  -> red, opens the chain switcher
 *   connected      -> chain chip + account, each opening its own modal
 *
 * Wrong-network is the only state here that gets a saturated colour, and it earns it: this
 * app is deployed to specific chains, and a user pointed at the wrong one will see an empty
 * vault and conclude the product is broken. That is a safety signal, not decoration, which
 * is the bar the design system sets for using red.
 */
export function WalletButton({
  label = "Connect wallet",
  full = false,
}: {
  label?: string;
  /** Stretch to the container width, for in-panel calls to action. */
  full?: boolean;
}) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
        // `mounted` guards the server/client boundary: wallet state does not exist during
        // SSR, so the button is rendered but hidden until it does. Hiding rather than
        // omitting keeps the nav from reflowing on hydration.
        const ready = mounted && authenticationStatus !== "loading";
        const connected =
          ready &&
          account &&
          chain &&
          (!authenticationStatus || authenticationStatus === "authenticated");

        return (
          <div
            aria-hidden={!ready}
            className={[
              full ? "flex w-full [&>*]:w-full" : "flex items-center gap-2",
              ready ? "" : "pointer-events-none select-none opacity-0",
            ].join(" ")}
          >
            {!connected ? (
              <LiquidButton
                type="button"
                variant="foreground"
                onClick={openConnectModal}
                className={full ? "w-full" : undefined}
              >
                <Wallet />
                {label}
              </LiquidButton>
            ) : chain.unsupported ? (
              <LiquidButton type="button" variant="destructive" onClick={openChainModal}>
                <AlertTriangle />
                Wrong network
              </LiquidButton>
            ) : (
              <>
                <LiquidButton
                  type="button"
                  size="sm"
                  onClick={openChainModal}
                  aria-label={`Connected to ${chain.name}. Switch network`}
                  title={chain.name}
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-primary"
                  />
                  {/* The chain name is the first thing to go when space is tight -- the dot
                      and the account address still tell you that you are connected. */}
                  <span className="hidden lg:inline">{chain.name}</span>
                </LiquidButton>

                <LiquidButton
                  type="button"
                  variant="foreground"
                  onClick={openAccountModal}
                  aria-label="Open account details"
                >
                  {account.displayName}
                </LiquidButton>
              </>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
