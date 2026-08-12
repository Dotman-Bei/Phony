import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HeroProduct } from "@/components/HeroProduct";

const MECHANICS = [
  {
    index: "01",
    title: "Deposit once",
    body: "Send a tokenized RWA to an ERC-4626 vault and receive brRWA shares. Standard interface, so wallets, explorers, and aggregators read the position without integration work.",
  },
  {
    index: "02",
    title: "The router allocates",
    body: "A curator-whitelisted strategy router splits the deposit by weight across treasury bills, private credit, and RWA liquidity. Unallocated weight stays idle as a reserve buffer for cheap withdrawals.",
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
    body: "Private credit principal is out on loan and cannot be recalled in-block. maxWithdraw reports what the strategies can actually free, so the UI never quotes an exit the chain will refuse.",
  },
  {
    title: "The curator cannot take the money",
    body: "Every admin path moves capital between the vault and whitelisted adapters, or back. There is no route from onlyOwner to an arbitrary transfer, and the vault asset is excluded from the rescue function.",
  },
];

const FAQ = [
  {
    q: "What exactly is being restaked?",
    a: "A tokenized real-world asset — a treasury bill, a private credit note, a commodity receipt — that otherwise sits in a wallet earning a single flat rate. The vault accepts it, keeps it productive across several yield sources at once, and returns it on demand. The asset never leaves the ERC-20 rails it arrived on.",
  },
  {
    q: "Where does the yield actually come from?",
    a: "Three sources, weighted by the curator: an ERC-4626 tokenized treasury product, a private credit pool, and a single-sided RWA liquidity position that earns trading fees. Each sits behind a strategy adapter implementing one interface, so a source can be swapped without touching the vault.",
  },
  {
    q: "What happens if a strategy loses money?",
    a: "The liquidity leg is the only one whose principal can fall, and the vault marks it to live pool value rather than carrying it at cost. A drawdown reduces NAV and therefore the share price, immediately and visibly. Harvest only ever transfers the surplus over principal, so a loss can never be booked as profit or paid out as a fee.",
  },
  {
    q: "Is this deployed with real yield sources?",
    a: "The badge on every data surface answers that per network. The testnet deployment runs real contracts, real transactions, and real share accounting against mock yield sources that pay simulated coupons — labelled 'demo' everywhere it appears. Mainnet points the same adapters at production protocol addresses.",
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
              <Link href="/vault" className="primary-action">
                Open the vault
              </Link>
              <Link href="/docs" className="hero-action">
                Read the architecture <ArrowRight size={14} strokeWidth={2} />
              </Link>
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
              <Link href="/vault" className="primary-action">
                Deposit & restake
              </Link>
              <Link href="/strategies" className="hero-action">
                Inspect the strategies
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
