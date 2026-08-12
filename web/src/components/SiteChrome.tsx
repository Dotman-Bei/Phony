"use client";

import Link from "next/link";
import { useChainId } from "wagmi";

import { AnimatedNavigationTabs, type NavTabItem } from "@/components/ui/animated-navigation-tabs";
import { PhonyMark } from "@/components/ui/phony-mark";
import { WalletButton } from "@/components/WalletButton";
import { supportedChains } from "@/lib/chains";

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
  // The explorer follows the active chain: mainnet is BOTScan on botchain.ai, testnet is
  // BOTScan on bohr.life. A hardcoded link here would send half of all visitors to the
  // wrong chain's explorer.
  const chainId = useChainId();
  const explorer =
    supportedChains.find((c) => c.id === chainId)?.blockExplorers?.default.url ??
    "https://scan.botchain.ai";

  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <span className="footer-note">
          Phony — BOT Chain Builder Challenge #2, RWA Applications track.
          <br />
          ERC-4626 vault, strategy router, three RWA yield adapters. MIT licensed.
        </span>
        <nav className="footer-links" aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <a href={explorer} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <a href="https://www.botchain.ai/en" target="_blank" rel="noreferrer">
            BOT Chain
          </a>
        </nav>
      </div>
    </footer>
  );
}
