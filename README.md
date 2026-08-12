# Phony

**RWA yield restaking and strategy vault on BOT Chain.**

An ERC-4626 vault that accepts a tokenized real-world asset, routes it across whitelisted
RWA yield strategies, and compounds the proceeds into the share price. One deposit, one
position, nothing to claim.

Built for the **BOT Chain Builder Challenge #2**, RWA Applications track (RWA Restaking ·
Product Aggregation · Infrastructure).

---

## The problem

A tokenized treasury bill sits in a wallet earning one flat rate. It cannot be used as
collateral, looped, or composed into anything. Meanwhile ETH has EigenLayer, Lido, Aave and
a dozen yield routers. RWA holders have three siloed dashboards, quarterly distributions,
and manual reinvestment that costs them 15–20% of effective APY to idle cash and friction.

Phony is the missing layer: one deposit interface, several yield sources behind it,
and compounding that happens whether or not the holder is paying attention.

---

## Architecture

```
                Investor            Curator            Harvest Bot
                    |                  |                    |
                    v                  v                    v
        +-------------------------------------------------------+
        |                      BotVault.sol                      |
        |                  (ERC-4626, brRWA)                     |
        |  deposit / withdraw / redeem / mint                    |
        |  totalAssets() = idle + every adapter, read live       |
        |  maxWithdraw() bounded by real strategy liquidity      |
        |  pause · recall · performance fee on yield only        |
        +---------------------------+---------------------------+
                                    |
                                    v
        +-------------------------------------------------------+
        |                  StrategyRouter.sol                    |
        |  whitelist · weights · caps · proportional withdraw    |
        |  batched harvest · rebalance                           |
        |  unallocated weight = the vault's idle reserve buffer  |
        +------+--------------------+-------------------+--------+
               |                    |                   |
               v                    v                   v
        +--------------+   +-----------------+   +----------------+
        | TBillStrategy|   | CreditStrategy  |   |LiquidityStrategy|
        |   LOW risk   |   |  MEDIUM risk    |   |   HIGH risk    |
        |  ERC-4626    |   | credit pool     |   |  RWA/stable LP |
        |  T-bill vault|   | (notice period) |   |  (can draw down)|
        +--------------+   +-----------------+   +----------------+
                    all implement IStrategyAdapter
```

### The three decisions that define the design

**1. NAV is a measurement, not a stored number.** `totalAssets()` queries every adapter on
every call. A drawdown in the liquidity leg moves the share price in the same block, rather
than at the next rebase. There is no cached TVL to go stale.

**2. Withdrawal maximums tell the truth.** Private credit principal is out on loan and
cannot be recalled in-block. `maxWithdraw` reports what the strategies can actually free,
so the UI never quotes an exit the chain will refuse. This is the one place most vault
clones quietly lie.

**3. The curator cannot take the money.** Every `onlyOwner` path moves capital between the
vault and a whitelisted adapter, or back. There is no route from an admin function to an
arbitrary transfer, and the vault asset is explicitly excluded from the rescue function.
`Integration.test.ts` exercises every admin call in sequence and asserts the curator's
balance is unchanged.

### Auto-compounding, precisely

Harvested yield is transferred into the vault while total share supply stays fixed. NAV
rises, supply does not, so `convertToAssets` returns more for the same share. Nothing is
minted, no balance rebases, and the position stays composable with anything that
understands ERC-4626.

`BaseStrategy` enforces the invariant that makes this safe:

```
yield = totalAssets() - totalDeposited
```

`harvest()` frees exactly that difference and never more, so principal can never be paid
out as yield and booked as profit. A strategy in drawdown reports zero yield.

---

## Repository layout

```
contracts/          Hardhat workspace — Solidity, tests, deploy + keeper scripts
  contracts/        BotVault, StrategyRouter, interfaces, strategies, mocks
  test/             79 tests: unit, adapter, and full-loop integration
  scripts/          deploy · verify · seed · e2e · harvestBot · exportAbi
web/                Next.js 16 frontend — the Kyvrane horizon-light design system
  src/app/          landing · /vault · /strategies · /portfolio · /docs
  src/lib/          chains, wagmi, contract bindings, formatting
  src/hooks/        useVaultData, useActivity, useVaultActions
```

---

## Live deployment — BOT Chain Testnet (chain 968)

All nine contracts are deployed and **verified with source** on
[BOTScan](https://scan.bohr.life). The full deposit → allocate → harvest → withdraw loop
has run on chain.

| | Address |
|---|---|
| **BotVault** (brRWA) | [`0xDcB2D4A08E10850845507B4ddfF95bfFE2411cE5`](https://scan.bohr.life/address/0xDcB2D4A08E10850845507B4ddfF95bfFE2411cE5#code) |
| **StrategyRouter** | [`0xe0040b6bCA2b68eFA75D0243B98AB71843C2c5B3`](https://scan.bohr.life/address/0xe0040b6bCA2b68eFA75D0243B98AB71843C2c5B3#code) |
| TBillStrategy — low risk | [`0x2d18B99ECcC1C9afc23e0E03fA95979292Da00d1`](https://scan.bohr.life/address/0x2d18B99ECcC1C9afc23e0E03fA95979292Da00d1#code) |
| CreditStrategy — medium risk | [`0x231F6ed0d020376e2c35FC18802BC7c8d0Ffa5CB`](https://scan.bohr.life/address/0x231F6ed0d020376e2c35FC18802BC7c8d0Ffa5CB#code) |
| LiquidityStrategy — high risk | [`0x3f7eE71A09970fb8792413FbeB5046fBD2f5486A`](https://scan.bohr.life/address/0x3f7eE71A09970fb8792413FbeB5046fBD2f5486A#code) |
| TBILL asset (mock RWA) | [`0x6F1C75f7844c6Ffb1b1d676767a8749cfD5CDD21`](https://scan.bohr.life/address/0x6F1C75f7844c6Ffb1b1d676767a8749cfD5CDD21#code) |
| MockTBillVault — yield source | [`0x4eFd1A552cdb90467EF6531A01a789fA2a8d4735`](https://scan.bohr.life/address/0x4eFd1A552cdb90467EF6531A01a789fA2a8d4735#code) |
| MockCreditPool — yield source | [`0xe9BA649e96A2B50be4d3F056726209F72Cf2c018`](https://scan.bohr.life/address/0xe9BA649e96A2B50be4d3F056726209F72Cf2c018#code) |
| MockLiquidityPool — yield source | [`0x81d1235574f05De7582e055c5A36C6FD14fC7928`](https://scan.bohr.life/address/0x81d1235574f05De7582e055c5A36C6FD14fC7928#code) |

Configured at 40% T-bill / 35% credit / 20% liquidity, leaving a **5% idle reserve buffer**,
with a 10% performance fee charged on yield only. The vault, router and adapters are real;
the three yield sources are mocks that pay simulated coupons, so **every screen in the app
labels this deployment `demo`, never `live`** — real contracts, real transactions, real
share accounting, simulated coupons.

Deployment manifest: [`contracts/deployments/botTestnet.json`](contracts/deployments/botTestnet.json).

---

## Quick start

### Contracts

```bash
cd contracts
npm install
npm run build          # compile (solc 0.8.24, evmVersion paris)
npm test               # 79 tests
npm run coverage       # 91.6% statements / 93.9% lines overall
```

### Local end-to-end

```bash
cd contracts
npx hardhat node                                   # terminal 1
npm run deploy:local                               # terminal 2
npx hardhat run scripts/seed.ts --network localhost   # realistic history for the UI
npm run export-abi                                 # push ABIs + addresses to web/

cd ../web
npm install
echo "NEXT_PUBLIC_DEFAULT_CHAIN_ID=31337" > .env.local
npm run dev
```

### Testnet

BOT Chain testnet is **chain 968**, RPC `https://rpc.bohr.life`, explorer
`https://scan.bohr.life`.

```bash
cd contracts
cp .env.example .env
npm run new-deployer       # fresh throwaway key -> .env, prints the address
                           # then claim 10 tBOT: https://faucet.botchain.ai/basic
npm run preflight:testnet  # read-only: chainId agreement, signer, gas. Sends nothing.
npm run deploy:testnet
npm run verify:testnet
npm run export-abi
npm run e2e:testnet        # on-chain smoke test of the full loop
npm run harvest-bot        # keeper, leave running
```

`preflight` exists because every one of its checks otherwise costs a failed deploy to
discover: an RPC that does not resolve, a chainId that disagrees with the config, an unset
key, an unfunded deployer. It is safe against mainnet — it sends no transactions.

### Mainnet (final step)

Mainnet is deliberately last. Set the real protocol addresses first — the deploy script
refuses to run with mocks unless `MAINNET_USE_MOCKS=true` is set explicitly:

```bash
export ASSET_ADDRESS=0x...
export TBILL_YIELD_SOURCE=0x...
export CREDIT_POOL=0x...
export LIQUIDITY_POOL=0x...
npm run deploy:mainnet && npm run verify:mainnet
```

Then flip the frontend with one variable: `NEXT_PUBLIC_DEFAULT_CHAIN_ID=677`.

Gas support for mainnet: https://forms.gle/QGWNnmthCDgL92uR9

### Hosting the frontend

The Next.js app lives in `web/`, not the repository root, so the one setting that matters
is the root directory:

| Vercel setting | Value |
|---|---|
| Root Directory | `web` |
| Framework | Next.js (auto-detected) |
| Build command | `next build` (default) |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | `968` for the testnet deployment, `677` after mainnet |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional — only adds the WalletConnect QR flow |

Contract addresses are compiled into the bundle via `contracts.generated.ts`, which is
committed, so the frontend builds on a clean clone with no contract build step. After any
redeploy of the contracts, run `npm run export-abi` and commit the result — that file is the
only path by which addresses reach the app.

---

## Deployment order

Vault → router → adapters, which inverts the naive reading. The router's `onlyVault` guard
and each adapter's `onlyRouter` guard bind at construction, so every layer needs the
address of the layer above it. The vault is pointed at the router in a second transaction,
which validates that the two agree about each other's asset and identity before accepting
the link.

---

## Testing

79 tests across four suites:

| Suite | Covers |
|---|---|
| `BotVault.test.ts` | ERC-4626 conformance, routing, reserve buffer, liquidity-aware maxima, harvest and fees, pause, curator controls, multi-user share accounting |
| `StrategyRouter.test.ts` | whitelisting, weight ceilings, caps, proportional withdrawal, retirement, rebalancing, view packing |
| `Strategies.test.ts` | per-adapter behaviour, APY derivation, drawdown handling, emergency exit |
| `Integration.test.ts` | the full loop, NAV conservation, strategy rotation mid-flight, curator cannot drain, harvest-neutral pricing |

Coverage: **91.6% statements, 93.9% lines** overall; **95.9% / 98.9%** on `BotVault` and
`StrategyRouter`.

Tests worth reading, because they encode the design claims:

- *"does not let a late depositor capture yield earned before they arrived"* — the
  backrunning check that matters for a yield vault.
- *"reports zero yield during a drawdown instead of paying out principal"* — the invariant
  that keeps compounding honest.
- *"cannot be drained by a curator with full admin rights"* — every admin path, in sequence.
- *"prices shares consistently whether yield is harvested or left to accrue"* — proves
  auto-compounding is not a rebasing trick.

---

## Frontend

Next.js 16 App Router, React 19, wagmi + viem, RainbowKit, Recharts, one hand-written CSS
file implementing the **Kyvrane horizon-light system**: a near-black violet page lit by a
single source below the fold, alpha-white surfaces instead of solid greys,
gradient-clipped headlines, a perspective grid converging on the bloom, and
hairline-bordered data grids.

The system reserves saturated colour for one thing only. Here that is **risk and data
provenance**:

- **Risk rating** — every strategy carries low / medium / high in green / amber / red. Not
  by APY: T-bills are sovereign credit with instant redemption, private credit is
  counterparty risk with a notice period, and an LP position can be marked down in a single
  block. That is why the highest yield carries the middle rating.
- **Data mode** — every screen states whether its numbers come from live protocol
  addresses or from mock yield sources. Demo never borrows the live colour. The testnet
  deployment runs real contracts, real transactions and real share accounting against
  simulated coupons, and says so.

Yields and APYs stay white. A good number is not a verdict.

Everything on screen is a live contract read or an on-chain event. There is no seeded
demo data in the frontend: an empty vault renders an empty state that says so.

Environment variables: see `web/.env.example`. The app works with injected wallets and no
configuration; a WalletConnect project id only adds the QR flow.

---

## Security posture

| Risk | Mitigation |
|---|---|
| Reentrancy | `ReentrancyGuard` on every external entrypoint across vault, router and adapters |
| Overflow | Solidity 0.8 checked arithmetic |
| Strategy failure | Per-strategy caps, per-adapter emergency exit, vault-wide pause and recall |
| First-depositor inflation | OpenZeppelin ERC-4626 virtual assets and shares |
| Centralisation | No admin path to an arbitrary transfer; vault asset excluded from rescue; fee capped at 20% and charged on yield only |
| Oracle manipulation | No external price oracles; yield is measured against principal held |
| Yield source failure | Diversified allocation plus per-strategy caps |
| Illiquid exits | `maxWithdraw` reports real recallable liquidity rather than nominal share value |

**Unaudited hackathon build.** The `evmVersion` is pinned to `paris` so no PUSH0 or
post-Shanghai opcodes reach BOT Chain bytecode.

---

## Research basis

| Reference | What it contributed |
|---|---|
| [stakekit/yield.xyz](https://github.com/stakekit/yield.xyz) | Unified yield aggregation across 70+ networks proves aggregation needs one standardised interface per source. `IStrategyAdapter` is that interface, scoped to RWA yield. |
| [dittonetwork/curator-vault](https://github.com/dittonetwork/curator-vault) | The curator pattern, reduced to its safe core — whitelist, weight, retire, and nothing else. Also the asynchronous-liquidity thinking behind partial withdrawals. |
| [OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | Battle-tested ERC-4626, Ownable, Pausable, ReentrancyGuard, inherited directly. |
| [aboudjem/ERC-3643](https://github.com/aboudjem/ERC-3643) | T-REX informed keeping the adapter interface narrow enough that a future `ERC3643Adapter` could enforce compliance before deposit without touching the vault. |
| [VaultWatch](https://github.com/VaultWatch) | Keeper orchestration: batch all strategies into one transaction, emit events for auditability, gate execution on yield clearing a multiple of gas cost. |

Frontend design system derived from [mystiquemide/kyvrane](https://github.com/mystiquemide/kyvrane) (MIT).

---

## Links

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 677 | 968 |
| RPC | https://rpc.botchain.ai | https://rpc.bohr.life |
| Explorer | https://scan.botchain.ai | https://scan.bohr.life |
| Faucet | — | https://faucet.botchain.ai/basic (10 tBOT / 24h) |

BOT Chain: https://www.botchain.ai/en · Dev docs:
https://dev-docs.botchain.ai/docs/Developers/json-rpc-endpoint/

The testnet is chain **968** and is served from `bohr.life`, not a `botchain.ai` subdomain.

---

MIT licensed.
