"use client";

import Link from "next/link";
import { useChainId } from "wagmi";

import { AnimatedNavigationTabs, type NavTabItem } from "@/components/ui/animated-navigation-tabs";
import { FooterBackgroundGradient, TextHoverEffect } from "@/components/ui/hover-footer";
import { PhonyMark } from "@/components/ui/phony-mark";
import { WalletButton } from "@/components/WalletButton";
import { explorerUrlFor, supportedChains } from "@/lib/chains";
import { addressFor, legsFor } from "@/lib/contracts";

const GITHUB = "https://github.com/Dotman-Bei/Phony";

const NAV: NavTabItem[] = [
  { id: 1, tile: "Vault", href: "/vault" },
  { id: 2, tile: "Strategies", href: "/strategies" },
  { id: 3, tile: "Portfolio", href: "/portfolio" },
  { id: 4, tile: "Docs", href: "/docs" },
];

export function SiteNav() {
  return (
    <header className="site-nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Phony home">
          <span className="brand-mark" aria-hidden="true">
            <PhonyMark size={30} />
          </span>
          <span>
            <span className="brand-name">Phony</span>
            <span className="brand-subtitle">RWA restaking</span>
          </span>
        </Link>

        <AnimatedNavigationTabs items={NAV} className="nav-tabs" />

        <div className="nav-tail">
          <WalletButton label="Connect Wallet" />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const chainId = useChainId();

  // The explorer follows the active chain: mainnet is BOTScan on botchain.ai, testnet is
  // BOTScan on bohr.life. A hardcoded link here would send half of all visitors to the
  // wrong chain's explorer.
  const explorer =
    supportedChains.find((c) => c.id === chainId)?.blockExplorers?.default.url ??
    "https://scan.botchain.ai";

  // Contract links come from the deployment manifest, so they cannot drift from what is
  // actually deployed, and they disappear rather than 404 on a chain with no deployment.
  const vault = addressFor(chainId, "vault");
  const pair = legsFor(chainId)[0]?.pair;

  const onChain = [
    vault ? { label: "Vault contract", href: explorerUrlFor(chainId, "address", vault) } : null,
    pair ? { label: "BDEX liquidity pool", href: explorerUrlFor(chainId, "address", pair) } : null,
    { label: "Explorer", href: explorer },
  ].filter(Boolean) as Array<{ label: string; href: string }>;

  return (
    <footer className="site-footer relative overflow-hidden">
      <FooterBackgroundGradient />

      <div className="shell relative z-10">
        <div className="grid grid-cols-1 gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
          <div className="flex flex-col gap-4 lg:pr-6">
            <Link href="/" className="brand" aria-label="Phony home">
              <span className="brand-mark" aria-hidden="true">
                <PhonyMark size={30} />
              </span>
              <span>
                <span className="brand-name">Phony</span>
                <span className="brand-subtitle">RWA restaking</span>
              </span>
            </Link>
            <p style={{ fontSize: 13, lineHeight: "21px", color: "var(--muted)", maxWidth: 260 }}>
              An ERC-4626 vault that takes a tokenized real-world asset, puts it to work in a live
              BDEX pair, and compounds the fees into the share price.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { label: "Vault", href: "/vault" },
              { label: "Strategies", href: "/strategies" },
              { label: "Portfolio", href: "/portfolio" },
              { label: "Docs", href: "/docs" },
            ]}
          />

          <FooterColumn title="On chain" links={onChain} external />

          <FooterColumn
            title="BOT Chain"
            links={[
              { label: "Network", href: "https://www.botchain.ai/en" },
              { label: "Developer docs", href: "https://dev-docs.botchain.ai" },
              { label: "Testnet faucet", href: "https://faucet.botchain.ai/basic" },
              { label: "Source", href: GITHUB },
            ]}
            external
          />
        </div>

        <div
          className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderTop: "1px solid var(--line-soft)" }}
        >
          <span className="micro" style={{ color: "var(--faint)" }}>
            Unaudited build. Yield is real trading fees and can be negative.
          </span>
          <span className="micro" style={{ color: "var(--faint)" }}>
            MIT licensed · © {new Date().getFullYear()} Phony
          </span>
        </div>
      </div>

      {/* Wordmark. Decorative, and heavy enough to be worth withholding from small screens. */}
      <div className="relative z-10 hidden h-72 -mb-24 -mt-28 lg:flex">
        <TextHoverEffect text="Phony" />
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
  external = false,
}: {
  title: string;
  links: Array<{ label: string; href: string }>;
  external?: boolean;
}) {
  if (links.length === 0) return null;

  return (
    <div>
      <h4 className="micro" style={{ color: "var(--text)", marginBottom: 14 }}>
        {title}
      </h4>
      <ul className="flex flex-col gap-2.5">
        {links.map((link) => (
          <li key={link.label}>
            {external ? (
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 13, color: "var(--muted)" }}
                className="transition-colors hover:!text-[var(--structure-pale)]"
              >
                {link.label}
              </a>
            ) : (
              <Link
                href={link.href}
                style={{ fontSize: 13, color: "var(--muted)" }}
                className="transition-colors hover:!text-[var(--structure-pale)]"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
