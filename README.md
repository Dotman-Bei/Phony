# Phony

**RWA yield restaking and strategy vault on BOT Chain.**

An ERC-4626 vault that accepts a tokenized real-world asset, routes it across whitelisted yield
venues, and compounds the proceeds into the share price. One deposit, one position, nothing to
claim.

Built for the **BOT Chain Builder Challenge**, RWA Applications track (RWA Restaking · Product
Aggregation · Infrastructure).

**Live app: [phony-rust.vercel.app](https://phony-rust.vercel.app/)** · deployed and verified on
**BOT Chain Mainnet** (chain 677) and **testnet** (968). Deposit, allocation, harvest and withdraw
are all real transactions against a live BDEX pair. The app defaults to mainnet; connect a wallet
to testnet and every read follows it, which is where [Trying it yourself](#trying-it-yourself)
points, because the mainnet pool is too thin to be worth entering.

---

## No simulated yield

This is the constraint that shaped the whole design, so it goes first.

**BOT Chain has no RWA yield infrastructure.** There is no tokenized-treasury issuer, no private
credit pool, no lending market, and no ERC-4626 vault deployed on it — checked against the
verified-contract indexes of both [BOTScan](https://scan.botchain.ai) and
[testnet BOTScan](https://scan.bohr.life), and against the official ecosystem list. The one venue
that pays a real yield on a stablecoin is **BDEX**, the chain's Uniswap-V2-architecture DEX.

So the vault does exactly one thing for real, rather than three things for show:

| | |
|---|---|
| **Asset** | The chain's own **USDT** — 287k holders on mainnet. Not a token this repo minted. |
| **Yield** | The **actual trading fees** of a live BDEX V2 pair. Not a rate an admin sets. |
| **Everything else** | The vault's idle reserve, which earns nothing and says so. |

There are **no mock contracts in this repository**. Not in `contracts/`, and not behind the
tests — the suite runs against a fork of BOT Chain testnet, so a swap in a test is a swap through
the same router the vault uses in production, priced by the same reserves, paying the same 0.3%.
The earlier iteration of this project shipped three strategy legs backed by mock yield sources
and disclosed them in the UI. Deleting them was the better answer than labelling them.

A T-bill leg and a credit leg remain designed for but unbuilt: `IStrategyAdapter` is unchanged, so
each is a config entry and one adapter the day such a venue exists on BOT Chain.

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
        +---------------------------+---------------------------+
                                    |
                                    v
        +-------------------------------------------------------+
        |                 BdexV2LpStrategy.sol                   |
        |  single-sided entry into a live BDEX V2 pair           |
        |  spot mark for NAV · exit quote for liquidity          |
        |  harvests fee surplus over principal, never principal  |
        +-------------------------------------------------------+
                    implements IStrategyAdapter
                                    |
                                    v
                     BDEX V2 USDT/WBOT — someone else's contract
```

### The decisions that define the design

**1. NAV is a measurement, not a stored number.** `totalAssets()` queries every adapter on every
call, and the adapter reads the pair's live reserves. A drop in WBOT moves the share price in the
same block. There is no cached TVL to go stale, and impermanent loss is not deferred.

**2. Withdrawal maximums tell the truth.** The two value hooks are deliberately different.
`_sourceAssets` marks the LP position at the pool's spot ratio — the honest mark-to-market.
`_sourceLiquidity` prices the exit *the way the exit will actually execute*: constant-product
output for the paired half against the reserves left after the burn, 0.3% fee included. The
vault's `maxWithdraw` is built on the second, so it never quotes an exit the chain would refuse.

**3. The curator cannot take the money.** Every `onlyOwner` path moves capital between the vault
and a whitelisted adapter, or back. There is no route from an admin function to an arbitrary
transfer, and the vault asset is excluded from the rescue function.

### Auto-compounding, precisely

Harvested yield is transferred into the vault while total share supply stays fixed. NAV rises,
supply does not, so `convertToAssets` returns more for the same share. Nothing is minted and no
balance rebases.

`BaseStrategy` enforces the invariant that makes this safe:

```
yield = totalAssets() - totalDeposited
```

`harvest()` frees exactly that difference and never more, so principal can never be paid out as
yield. A position underwater on impermanent loss reports **zero** yield, not a loss dressed as a
distribution.

### Three things a live deployment taught this code

All three were found by running against real liquidity rather than a mock, and all three are
pinned by tests.

**A reserve applied to the wrong denominator is not a reserve.** The router used to split each
*deposit* by weight — 60% deployed, 40% left idle — which is indistinguishable from the correct
behaviour on the first deposit into an empty vault and diverges on every call after it. Routing
runs again on every deposit *and* on every `harvest()`, so each pass deployed 60% of whatever was
still idle: the buffer decayed as 0.4ⁿ, and with the keeper harvesting every five minutes the live
testnet vault reached **100% deployed with an idle reserve of exactly zero** while this README,
the router's own doc comment and the whitepaper all said 40% was held back. The frontend was the
only part telling the truth, because it computes the reserve slice from `idleAssets()` rather than
from the configured weight.

The fix sizes the deployment against NAV instead: the router deploys only what brings strategy
holdings up to `totalAllocationBps` of NAV, so repeated calls converge on the buffer rather than
eroding it, and an already-balanced vault costs one view call and no transfer. Three consecutive
`harvest()` calls against the live testnet vault, which is the exact path that used to drain it:

```
before      nav 4.062496  idle 1.626375 (40.0%)  deployed 2.436121 (60.0%)
harvest 1   nav 4.062495  idle 1.624999 (40.0%)  deployed 2.437496 (60.0%)
harvest 2   nav 4.062495  idle 1.624998 (40.0%)  deployed 2.437497 (60.0%)
harvest 3   nav 4.062495  idle 1.624998 (40.0%)  deployed 2.437497 (60.0%)
```

The old code would have read 40% → 16% → 6.4% → 2.6%.

One consequence is worth stating because it changed a test rather than being caught by one:
`harvest()` now *lowers* the share price slightly, by the pool's exit fee plus the 10% performance
fee. It always should have. The old code appeared to raise it only because it immediately
redeployed the proceeds and booked its own entry price impact as a gain — a vault reporting its
own slippage as profit. The integration test asserted that rise; it now bounds the cost instead.

**Swapping half is wrong.** A single-asset vault entering a two-sided pool has to swap part of the
deposit. Swapping exactly half fails: the swap itself moves the price, so the paired tokens bought
no longer match the ratio needed to pair the remainder, and `addLiquidity` reverts with
`INSUFFICIENT_B_AMOUNT`. The adapter uses the closed form for a 0.3% pool instead —
`(sqrt(r·(r·3988009 + a·3988000)) − r·1997) / 1994` — which lands balanced at the *post-swap*
price and leaves only dust.

**Sizing an exit on the spot mark under-delivers.** Burning LP in proportion to spot value yields
slightly less asset than asked for, because the proceeds only arrive after the paired half is
sold and pays the fee. On testnet this was an 11-unit shortfall out of 4.4 million — enough for
the vault to correctly reject a withdrawal of its own quoted maximum. The burn is now sized
against realisable value, which covers the round trip.

---

## Live deployment — BOT Chain Mainnet (chain 677)

All three contracts are deployed and **verified with source** on
[BOTScan](https://scan.botchain.ai). This is the deployment the app targets by default.

| | Address |
|---|---|
| **BotVault** (brRWA) | [`0x6F1C75f7844c6Ffb1b1d676767a8749cfD5CDD21`](https://scan.botchain.ai/address/0x6F1C75f7844c6Ffb1b1d676767a8749cfD5CDD21#code) |
| **StrategyRouter** | [`0xDcB2D4A08E10850845507B4ddfF95bfFE2411cE5`](https://scan.botchain.ai/address/0xDcB2D4A08E10850845507B4ddfF95bfFE2411cE5#code) |
| **BdexV2LpStrategy** | [`0xe0040b6bCA2b68eFA75D0243B98AB71843C2c5B3`](https://scan.botchain.ai/address/0xe0040b6bCA2b68eFA75D0243B98AB71843C2c5B3#code) |

Contracts it uses but does not own: USDT
[`0xaBabc7Dd…7a3C`](https://scan.botchain.ai/address/0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C),
the BDEX V2 USDT/WBOT pair
[`0xdc7547f3…b98d`](https://scan.botchain.ai/address/0xdc7547f3cEa82C6Af7fd420656cE532C6da9b98d),
and BDEX V2 Router02 `0x1414eD29…9e76`.

**The caps here are two and five USDT, and that is not a typo.** Mainnet's USDT/WBOT pool holds
**25.97 USDT** against testnet's 6,568 — see [Mainnet](#mainnet) for the survey of all 27 BDEX
pairs and why the one deep pool on the chain cannot be used. The vault is sized to the venue that
exists rather than the one it would prefer, so it is capped at 5 USDT of TVL with 2 in the strategy
leg. Raising both is a config change and a redeploy the day the pool is deeper.

The mainnet vault is **live and empty**: deploying cost 0.161 BOT of the 0.25 funded, and seeding
it would mean buying USDT through a pool that thin. The full loop is exercised on testnet below,
against the same contracts compiled from the same source.

---

## Live deployment — BOT Chain Testnet (chain 968)

All three contracts are deployed and **verified with source** on
[BOTScan](https://scan.bohr.life). The full deposit → allocate → harvest → withdraw loop has run
on chain against real BDEX liquidity, and this is the deployment to connect a wallet to if you
want to use the thing.

| | Address |
|---|---|
| **BotVault** (brRWA) | [`0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab`](https://scan.bohr.life/address/0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab#code) |
| **StrategyRouter** | [`0xa36809be4dCB1D8C901F60ab5E5a7A4AcAfafc9C`](https://scan.bohr.life/address/0xa36809be4dCB1D8C901F60ab5E5a7A4AcAfafc9C#code) |
| **BdexV2LpStrategy** | [`0x24AA76AA2DecdcC38Bd97bBAFdaf44c557B57eee`](https://scan.bohr.life/address/0x24AA76AA2DecdcC38Bd97bBAFdaf44c557B57eee#code) |

Contracts it uses but does not own:

| | Address |
|---|---|
| USDT — the vault asset, 6 dp | [`0x75edC9335175Fc0552D51D48439F229c10420fe3`](https://scan.bohr.life/address/0x75edC9335175Fc0552D51D48439F229c10420fe3) |
| BDEX V2 USDT/WBOT pair | [`0xD3EC267707BA234583645E75CE283Cf679dd94Fa`](https://scan.bohr.life/address/0xD3EC267707BA234583645E75CE283Cf679dd94Fa) |
| BDEX V2 Router02 | `0xD6425a02f0845B8D99e349C34D2E7A576E177345` |
| BDEX V2 Factory | `0x65b8e98ceA190d8c28B3e4716402027f634d15a3` |

**60%** of NAV is deployed to the LP leg, leaving a **40% idle reserve**; 10% performance fee on
yield only. Caps are sized against pool depth: the pair holds ~6,500 USDT, so the strategy is capped
at 500 USDT and the vault at 1,000. A position that is a large fraction of the pool pays its own
price impact twice and makes NAV a function of its own size rather than of the market.

The router and adapter have each been replaced twice since the first deploy, and the **vault
address has never changed** — which is the point of doing it this way. Two scripts cover the two
cases: `rotateStrategy.ts` when only an adapter changed, and `migrateRouter.ts` when the router did,
which additionally recalls capital and re-points the vault. Neither mints or burns a share, so
published links, verified explorer pages and depositors' positions all survive a fix.

Each migration costs one round trip through the pool — 0.0102 USDT for the adapter rotation and
0.0073 for the router migration, on a ~4 USDT vault. That is the 0.3% swap fee on the paired half,
paid twice, and it is why the scripts print NAV and share supply either side rather than reporting
success.

Manifest: [`contracts/deployments/botTestnet.json`](contracts/deployments/botTestnet.json).

### Trying it yourself

The app is live at **[phony-rust.vercel.app](https://phony-rust.vercel.app/)**. Point a wallet at
**chain 968**, RPC `https://rpc.bohr.life`, explorer `https://scan.bohr.life`. Then two things are
needed, and only one of them has a faucet:

| | |
|---|---|
| **Gas** | [faucet.botchain.ai/basic](https://faucet.botchain.ai/basic) — 10 tBOT per 24h. |
| **The asset** | No faucet, because it is the chain's real USDT. Acquire it by swapping BOT for `0x75edC933…20fe3` through BDEX Router02 at `0xD6425a02…177345`. |

That second row is friction, and it is the honest kind: a vault that could mint its own deposit
token would not be accepting a real asset. Anyone holding the deployer key can shortcut it —
`RECIPIENT=0x… npm run fund:testnet` sends a wallet both, buying the USDT on BDEX if the deployer
is short.

Once funded, the whole loop is on `/vault`: deposit, watch the allocation re-weight to 60/40,
harvest, withdraw. Two expectations worth setting before you look:

- **The APY will read 0.00% unless somebody has recently traded the pair.** Yield here is a real
  fee stream, and a quiet pool pays nothing. The vault reports zero rather than annualising a
  mark-to-market gain — pinned by a test that says exactly that.
- **`Exitable this block` sits below TVL.** That gap is what unwinding the LP would actually cost.
  It is the number `maxWithdraw` is built on, so the UI never offers an exit the chain refuses.

---

## Repository layout

```
contracts/          Hardhat workspace — Solidity, tests, deploy + keeper scripts
  contracts/        BotVault, StrategyRouter, BaseStrategy, BdexV2LpStrategy, interfaces
  test/             fork-based suite; no mocks, no local stand-ins
  scripts/          scanPools · inspectPair · preflight · deploy · verify · e2e · exit
                    fund · rotateStrategy · migrateRouter · harvestBot · exportAbi
web/                Next.js 16 frontend — the Kyvrane horizon-light design system
  src/app/          landing · /vault · /strategies · /portfolio · /docs
  src/lib/          chains, wagmi, contract bindings, formatting
  src/hooks/        useVault, useActivity, useVaultActions
```

---

## Quick start

### Contracts

```bash
cd contracts
npm install
npm run build          # compile (solc 0.8.24, evmVersion paris)
npm test               # fork of testnet — needs network access
```

The suite forks BOT Chain testnet, so it reaches the network by design. `FORK_BLOCK` pins a block
for reproducible reserves; `NO_FORK=true` skips forking for checks that need no external state.

### Testnet

Testnet is **chain 968**, RPC `https://rpc.bohr.life`, explorer `https://scan.bohr.life`.

```bash
cd contracts
cp .env.example .env
npm run new-deployer       # fresh throwaway key -> .env, prints the address
                           # then claim tBOT: https://faucet.botchain.ai/basic
npm run scan:testnet       # every BDEX pair holding USDT, ranked by depth
npm run preflight:testnet  # read-only. Sends nothing.
npm run deploy:testnet
npm run verify:testnet
npm run export-abi
npm run e2e:testnet        # full loop against real BDEX
npm run harvest-bot        # keeper, leave running

RECIPIENT=0x… npm run fund:testnet   # send a test wallet gas + USDT to try the UI
```

`preflight` earns its place: every check it makes otherwise costs a failed deploy to discover — an
RPC that does not resolve, a chainId disagreeing with the config, an unfunded deployer, a DEX pair
that does not exist, or a pool too thin to enter. It caught a stale `ASSET_DECIMALS=18` that would
have made every amount in the deployment wrong by a factor of 10¹², and it blocked the first
mainnet deploy over a testnet-sized `LEG_CAP` — twice earning its keep on the one thing it does.

`scan` and `inspect` answer the question preflight cannot, because preflight only checks the leg
already in the config: *is this the right pool at all?* `scan` ranks every BDEX pair by how much
asset it holds; `PAIR=0x… npm run inspect:mainnet` then prints one pair's reserves, its paired
token's metadata, whether the factory really registered it, and what a round trip costs at several
sizes. Between them they are how the mainnet caps were chosen and how the chain's deepest USDT pool
was rejected — see [Mainnet](#mainnet).

There is **no faucet for the asset**, because the asset is real USDT. `e2e` acquires it by swapping
native BOT through BDEX, and `fund` does the same on behalf of a wallet that is not the deployer —
`USDT_AMOUNT`, `GAS_AMOUNT` and `BOT_SPEND` tune it. `npm run exit` withdraws a whole position from
a deployment. `npm run rotate:testnet` replaces an adapter and `npm run migrate:testnet` replaces
the router, both keeping the vault address.

### Mainnet

Mainnet was deliberately last, and is now **deployed and verified** — addresses above. Chain 677,
USDT `0xaBabc7Dd…7a3C`, BDEX Router02 `0x1414eD29…9e76`, all defaulted in `scripts/config.ts`, so
the deploy needed no addresses passed in. It cost **0.161 BOT** at 20 gwei: 2.48M gas for the
vault, 2.54M for the router, 2.72M for the adapter, and ~0.3M to configure.

Position caps are scoped per network — `MAINNET_LEG_CAP` and `TESTNET_LEG_CAP`, with no shared
fallback. That is not tidiness. A leftover `LEG_CAP=500` in `.env`, correct for testnet, silently
overrode the mainnet default of 2 on the first attempt; preflight refused the deploy, and the
variable was then scoped so the wrong value cannot be reached rather than merely caught.

```bash
npm run scan:mainnet       # every BDEX pair holding USDT, ranked by depth
npm run preflight:mainnet  # read-only. Sends nothing.
npm run deploy:mainnet && npm run verify:mainnet
```

Then flip the frontend with one variable: `NEXT_PUBLIC_DEFAULT_CHAIN_ID=677`.

Gas support: https://forms.gle/QGWNnmthCDgL92uR9

**Mainnet is a much smaller pond than testnet, and the config says so.** `scan:mainnet` walks all
27 BDEX V2 pairs and reports how much USDT each one holds. The result decides the caps:

| Pair | USDT depth | Usable |
|---|---|---|
| USDT/Money | 470,741 | **no** — see below |
| USDT/WBOT | 25.68 | yes |
| USDT/COW | 16.07 | yes, too thin to bother |
| USDT/LGNS | 8.19 | " |
| everything else | < 7 | " |

The one deep pool on the chain is unusable. `Money` (`0xdaaABBD1…a5e2`, verified as `MToken`) is
fee-on-transfer — 2% on buys, 10% on sells — with an owner-settable `isBlacklisted` mapping that
exempts only the pair, a `tradingEnabled` kill switch, and a 10-second sell cooldown. The adapter
would enter 2% short of what the router quoted, and far worse, `_sourceLiquidity` prices exits with
the pool's 0.3% fee and would therefore over-quote every exit by the missing 10%. `maxWithdraw`
would quote an exit the chain refuses — the exact failure the whole design exists to prevent. The
adapter reverting rather than transacting there is the correct outcome; it is not built for such
tokens and does not pretend to be. (The testnet USDT/Money pair was rejected for the same reason
while picking a second test venue — see `test/fixtures.ts`.)

That leaves USDT/WBOT, which holds **25.68 USDT** against testnet's 6,570. WBOT itself is clean: a
WETH9-style wrapper with no owner, no tax and no hooks. So mainnet ships at `LEG_CAP=2`,
`DEPOSIT_CAP=5` — the same ~7.5%-of-depth discipline as testnet, applied to the pool that actually
exists. `preflight:mainnet` refuses the deploy if the caps drift past what the pool can absorb, so
this is enforced rather than remembered.

It is a small vault because it is a small pool. Sizing the cap to the pool we wish existed would
only mean paying our own price impact twice and calling the result yield.

### Hosting the frontend

The app lives in `web/`, not the repository root, so the one setting that matters is the root
directory:

| Vercel setting | Value |
|---|---|
| Root Directory | `web` |
| Framework | Next.js (auto-detected) |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | optional — defaults to `677` in code; set `968` to target testnet |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional — only adds the WalletConnect QR flow |

The default chain is a code fallback rather than a required env var on purpose: a hosted build
with no environment set would otherwise have pointed at testnet while this README advertised
mainnet addresses.

Addresses reach the app only through `contracts.generated.ts`, which is committed, so the frontend
builds on a clean clone with no contract build step. After redeploying contracts, run
`npm run export-abi` and commit the result.

---

## Testing

The suite runs against a **fork of BOT Chain testnet**. There are no mock contracts to test
against, which is the point — but it also means the tests exercise things a mock cannot produce:

| | |
|---|---|
| Real fees | `generateTradingFees` round-trips volume through the pool. Each swap pays 0.3% into the reserves, which is how a V2 LP actually earns. |
| Real drawdown | `crashPairedToken` dumps WBOT into the pool so its price genuinely falls. The old mock had a `setLpValueBps` setter for this. |
| Real funding | Test USDT comes from impersonating a large holder. There is no mint function available. |

**69 tests**, all against live BDEX liquidity:

| Suite | Covers |
|---|---|
| `BotVault` | ERC-4626 conformance, weighted routing, the reserve buffer holding across repeated deployment, liquidity-aware maxima, harvest and fees, pause, curator controls, multi-user share accounting |
| `StrategyRouter` | whitelisting, weight ceilings, wrong-asset rejection, caps, proportional withdrawal across two venues, retirement, rebalancing, packed views |
| `Integration` | the full loop, NAV conservation at every step, a real drawdown, the curator-cannot-drain sequence, emergency exit |
| `Smoke` | the fork itself, the exit-quote regression, fee accrual, the realised-APY rule |

The router tests need two strategies to mean anything, and there is no mock adapter to supply one,
so the second leg is **another live pair** (USDT/USDT4). One consequence is worth stating: a
rebalance moves capital through two real pools and pays their fees, so NAV falls slightly every
time. A mock would have shown that as free.

### Frontend — build.md §7.3

```bash
cd web
npm test          # vitest, 50 tests
```

Vitest + Testing Library in jsdom, covering the four areas the spec names:

| Suite | Covers |
|---|---|
| `wallet-connection` | chain definitions (677/968 and their real hosts), connect, disconnect, rejecting an unsupported chain, per-chain deployment lookup |
| `deposit-flow` | approve-then-deposit vs deposit-only, quotes before signing, refusal above the wallet balance, paused vault, wallet rejection, signing vs pending, and the withdraw side bounded by exitable liquidity |
| `share-price` | truncation of balances, rounding of derived figures, 6-decimal correctness, quote round-trips |
| `chart-rendering` | allocation rows including the idle reserve, and empty states that distinguish "no harvest yet" from "the RPC refused the log range" |

The write path is stubbed there on purpose: whether the chain *accepts* a call is settled in
`contracts/test` against a fork of the real BDEX, which is the only place that answer means
anything. What the frontend suite pins is the decision made before a signature is requested.

---

## Security posture

| Risk | Mitigation |
|---|---|
| Reentrancy | `ReentrancyGuard` on every external entrypoint across vault, router and adapter |
| Overflow | Solidity 0.8 checked arithmetic |
| Pair spoofing | The adapter checks the pair is the one the DEX **factory** registered for the two tokens; a look-alike pair would be reserves an attacker controls, and every value the adapter reports derives from those reserves |
| Swap sandwiching | Entry and exit both carry a slippage bound (100 bps default, 1000 bps ceiling) and revert rather than accept worse |
| Impermanent loss | Marked live into NAV rather than deferred; `harvest` reports zero yield while underwater |
| Price impact | Per-strategy caps sized against pool depth, plus a vault-level deposit cap |
| Strategy failure | Per-adapter emergency exit unwinds LP to plain asset without changing NAV or blocking withdrawals — exercised on chain |
| Centralisation | No admin path to an arbitrary transfer; fee capped at 20% and charged on yield only |
| Oracle manipulation | No external price oracles; the asset side of the pair *is* the unit of account |
| Illiquid exits | `maxWithdraw` reports the real exit quote, fee included, not nominal share value |

**Unaudited hackathon build.** `evmVersion` is pinned to `paris` so no PUSH0 or post-Shanghai
opcodes reach BOT Chain bytecode.

---

## Research basis

| Reference | What it contributed |
|---|---|
| [stakekit/yield.xyz](https://github.com/stakekit/yield.xyz) | Unified yield aggregation across 70+ networks proves aggregation needs one standardised interface per source. `IStrategyAdapter` is that interface. |
| [dittonetwork/curator-vault](https://github.com/dittonetwork/curator-vault) | The curator pattern reduced to its safe core — whitelist, weight, retire, nothing else. |
| [OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | Battle-tested ERC-4626, Ownable, Pausable, ReentrancyGuard, inherited directly. |
| [Uniswap V2](https://github.com/Uniswap/v2-core) | BDEX is a V2 deployment. Its constant-product and optimal one-sided-supply arithmetic is reproduced in the adapter, verified wei-exact against BDEX's own router. |
| [aboudjem/ERC-3643](https://github.com/aboudjem/ERC-3643) | T-REX informed keeping the adapter interface narrow enough that a future `ERC3643Adapter` could enforce compliance before deposit without touching the vault. |
| [VaultWatch](https://github.com/VaultWatch) | Keeper orchestration: batch strategies into one transaction, emit events for auditability, gate execution on yield clearing a multiple of gas cost. |

Frontend design system derived from [mystiquemide/kyvrane](https://github.com/mystiquemide/kyvrane) (MIT).

---

## Links

**App:** https://phony-rust.vercel.app/ · **Repository:** https://github.com/Dotman-Bei/Phony

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 677 | 968 |
| RPC | https://rpc.botchain.ai | https://rpc.bohr.life |
| Explorer | https://scan.botchain.ai | https://scan.bohr.life |
| Faucet | — | https://faucet.botchain.ai/basic (10 tBOT / 24h) |
| Vault | [`0x6F1C75f7…fD5CDD21`](https://scan.botchain.ai/address/0x6F1C75f7844c6Ffb1b1d676767a8749cfD5CDD21#code) | [`0x901e837d…AC14FFab`](https://scan.bohr.life/address/0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab#code) |
| Deposit cap | 5 USDT (pool holds 26) | 1,000 USDT (pool holds 6,568) |

BOT Chain: https://www.botchain.ai/en · Dev docs: https://dev-docs.botchain.ai ·
BDEX addresses: https://dev-docs.botchain.ai/docs/DEX/contract-addresses/

The testnet is chain **968** and is served from `bohr.life`, not a `botchain.ai` subdomain.

---

MIT licensed.
