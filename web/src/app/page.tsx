import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HeroProduct } from "@/components/HeroProduct";
import { LiquidButton } from "@/components/ui/liquid-glass-button";

const MECHANICS = [
  {
    index: "01",
    title: "Deposit once",
    body: "Send a tokenized RWA to an ERC-4626 vault and receive brRWA shares. Standard interface, so wallets, explorers, and aggregators read the position without integration work.",
  },
  {
    index: "02",
    title: "The router allocates",
    body: "A curator-whitelisted strategy router deploys capital up to its target share of NAV and leaves the remainder idle in the vault, where it earns nothing and stays instantly withdrawable. Weights, caps and retirement are the curator's; moving money anywhere else is not.",
  },
  {
    index: "03",
    title: "Yield compounds itself",
    body: "Harvested yield lands in the vault while share supply stays fixed, so every share silently gains value. There is nothing to claim and no reward token to sell.",
  },
];

const PROPERTIES = [
  {
    title: "NAV is a live read, not a stored number",
    body: "totalAssets() queries every adapter on every call, so the share price reflects strategy value at block time. A drawdown in the liquidity leg shows up immediately rather than at the next rebase.",
  },
  {
    title: "Withdrawal maximums tell the truth",
    body: "An LP position cannot be unwound at its spot mark — the paired half has to be sold, and that sale pays the pool's fee. maxWithdraw prices the exit the way the exit will actually execute, so the UI never quotes an exit the chain will refuse.",
  },
  {
    title: "The curator cannot take the money",
    body: "Every admin path moves capital between the vault and whitelisted adapters, or back. There is no route from onlyOwner to an arbitrary transfer, and the vault asset is excluded from the rescue function.",
  },
];

const FAQ = [
  {
    q: "What exactly is being restaked?",
    a: "A tokenized real-world asset that otherwise sits in a wallet earning a single flat rate. On BOT Chain today that is the chain's own USDT, held by 287k addresses and not minted by this project. The vault accepts it, keeps it working in a live venue, and returns it on demand. The asset never leaves the ERC-20 rails it arrived on.",
  },
  {
    q: "Where does the yield actually come from?",
    a: "The trading fees of a live BDEX V2 USDT/WBOT pair — other people's swaps, each paying the pool's 0.3%. Not a rate an admin sets. It sits behind a strategy adapter implementing one interface, so another venue is a config entry and one adapter rather than a change to the vault.",
  },
  {
    q: "What happens if a strategy loses money?",
    a: "The LP leg's principal can fall — impermanent loss is real — and the vault marks it to live pool value rather than carrying it at cost. A drawdown reduces NAV and therefore the share price, immediately and visibly. Harvest only ever frees the surplus over principal, so a position underwater reports zero yield instead of paying a loss out as a distribution.",
  },
  {
    q: "Is this deployed with real yield sources?",
    a: "Yes, and there are no mock contracts in the repository to fall back on — not in the contracts, and not behind the tests, which run against a fork of the live chain. An earlier build shipped three legs backed by mock yield sources and disclosed them as 'demo'; deleting them was the better answer than labelling them. A T-bill leg and a credit leg remain designed for but unbuilt, because BOT Chain has no such venue yet.",
  },
  {
    q: "Who can pause or unwind the vault?",
    a: "The curator can pause deposits and withdrawals, recall all capital from strategies into the vault, and retire a strategy. Recalling does not change NAV — the capital moves, it does not disappear — and a retired strategy must return everything it holds or the transaction reverts.",
  },
];

export default function LandingPage() {
  return (
    <>
      <section className="hero">
        <div className="hero-grid" aria-hidden="true" />

        <div className="shell hero-inner">
          <div className="hero-copy">
            <span className="eyebrow">RWA restaking primitive</span>
            <h1 className="lit-heading">Tokenized real-world assets, put back to work.</h1>
            <p className="lead">
              An ERC-4626 vault on BOT Chain that accepts a tokenized RWA, routes it across
              whitelisted yield strategies, and compounds the proceeds into the share price.
              One deposit, one position, no claiming.
            </p>

            <div className="hero-actions">
              <LiquidButton asChild variant="foreground" size="xl">
                <Link href="/vault">Open the vault</Link>
              </LiquidButton>
              <LiquidButton asChild size="xl">
                <Link href="/docs">
                  Read the architecture <ArrowRight size={14} strokeWidth={2} />
                </Link>
              </LiquidButton>
            </div>
          </div>

          <HeroProduct />
        </div>
      </section>

      <section className="section">
        <div className="wide">
          <div className="section-head">
            <span className="eyebrow">The loop</span>
            <h2 className="lit-heading">Deposit, allocate, compound, withdraw.</h2>
            <p className="lead">
              A tokenized treasury earns one rate and does nothing else. It cannot be
              collateralised, looped, or composed. This is the missing layer.
            </p>
          </div>

          <div className="cards-3">
            {MECHANICS.map((item) => (
              <article className="card lit-edge" key={item.index}>
                <span className="panel-index">{item.index}</span>
                <h3 className="card-title" style={{ marginTop: 18 }}>
                  {item.title}
                </h3>
                <p style={{ marginTop: 14, color: "var(--muted)", fontSize: 15, lineHeight: "24px" }}>
                  {item.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wide">
          <div className="split-wide" style={{ gap: 48, alignItems: "start" }}>
            <div>
              <span className="eyebrow">Design properties</span>
              <h2 className="lit-heading" style={{ marginTop: 20 }}>
                Built to be inspected.
              </h2>
              <p className="lead prose" style={{ marginTop: 20 }}>
                Three decisions that a depositor can verify on chain rather than take on
                trust.
              </p>
            </div>

            <div>
              {PROPERTIES.map((item) => (
                <div className="policy-card" key={item.title}>
                  <h4>{item.title}</h4>
                  <p>{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="content">
          <div className="section-head">
            <span className="eyebrow">Questions</span>
            <h2 className="lit-heading">What you would ask before depositing.</h2>
          </div>

          <div className="faq-list">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <span className="faq-cross" aria-hidden="true" />
                </summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section style={{ paddingBottom: "var(--section)" }}>
        <div className="wide">
          <div className="closing-cta">
            <span className="eyebrow">Ready when you are</span>
            <h2 className="lit-heading" style={{ marginTop: 18 }}>
              Open the vault.
            </h2>
            <p className="lead">
              Connect a wallet on BOT Chain, deposit a tokenized RWA, and watch the share
              price do the work.
            </p>
            <div className="hero-actions">
              <LiquidButton asChild variant="foreground" size="xl">
                <Link href="/vault">Deposit &amp; restake</Link>
              </LiquidButton>
              <LiquidButton asChild size="xl">
                <Link href="/strategies">Inspect the strategies</Link>
              </LiquidButton>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
