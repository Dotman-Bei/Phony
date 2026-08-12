import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteFooter, SiteNav } from "@/components/SiteChrome";
import { GlassFilter } from "@/components/ui/liquid-glass-button";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  // Browser-tab title, kept to the bare name so the tab reads "Phony" beside the mark.
  // The descriptive version lives on the Open Graph card below, where there is room for
  // it and where search and link previews actually use it.
  title: "Phony",
  description:
    "An ERC-4626 vault that accepts tokenized real-world assets and routes them into auto-compounding RWA yield strategies. Built for the BOT Chain Builder Challenge.",
  openGraph: {
    title: "Phony — RWA yield restaking on BOT Chain",
    description:
      "Deposit tokenized RWAs once. The vault allocates across treasury bills, private credit, and RWA liquidity, and compounds the yield into your share price.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0118",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dark` is a class, not an OS preference. This page is dark unconditionally, so
    // leaving `dark:` utilities on `prefers-color-scheme` would give anyone whose OS is in
    // light mode the light-background bevel on a dark page.
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="page-body">
        <Providers>
          <SiteNav />
          <main>{children}</main>
          <SiteFooter />
        </Providers>
        {/* Mounted once: SVG filter ids are global, so the glass buttons all point here. */}
        <GlassFilter />
      </body>
    </html>
  );
}
