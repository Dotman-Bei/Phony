# Phony

**RWA yield restaking and strategy vault on BOT Chain.**

An ERC-4626 vault that accepts a tokenized real-world asset, routes it across whitelisted yield
venues, and compounds the proceeds into the share price. One deposit, one position, nothing to
claim.

Built for the **BOT Chain Builder Challenge**, RWA Applications track (RWA Restaking · Product
Aggregation · Infrastructure).

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

### Two things a real DEX taught this code

Both were found by running against live liquidity, and both are pinned by tests.

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

## Live deployment — BOT Chain Testnet (chain 968)

All three contracts are deployed and **verified with source** on
[BOTScan](https://scan.bohr.life). The full deposit → allocate → harvest → withdraw loop has run
on chain against real BDEX liquidity.

| | Address |
|---|---|
| **BotVault** (brRWA) | [`0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab`](https://scan.bohr.life/address/0x901e837d0B750b2faC72c6D5a67dfFAcAC14FFab#code) |
| **StrategyRouter** | [`0x624F37AD9b7Df06B980dA17a01d22CD0924D26F3`](https://scan.bohr.life/address/0x624F37AD9b7Df06B980dA17a01d22CD0924D26F3#code) |
| **BdexV2LpStrategy** | [`0xfc06f27f2b63FE97916d16783E094aE77823534B`](https://scan.bohr.life/address/0xfc06f27f2b63FE97916d16783E094aE77823534B#code) |

Contracts it uses but does not own:

| | Address |
|---|---|
| USDT — the vault asset, 6 dp | [`0x75edC9335175Fc0552D51D48439F229c10420fe3`](https://scan.bohr.life/address/0x75edC9335175Fc0552D51D48439F229c10420fe3) |
| BDEX V2 USDT/WBOT pair | [`0xD3EC267707BA234583645E75CE283Cf679dd94Fa`](https://scan.bohr.life/address/0xD3EC267707BA234583645E75CE283Cf679dd94Fa) |
| BDEX V2 Router02 | `0xD6425a02f0845B8D99e349C34D2E7A576E177345` |
| BDEX V2 Factory | `0x65b8e98ceA190d8c28B3e4716402027f634d15a3` |

**60%** of deposits go to the LP leg, leaving a **40% idle reserve**; 10% performance fee on yield
only. Caps are sized against pool depth: the pair holds ~6,500 USDT, so the strategy is capped at
500 USDT and the vault at 1,000. A position that is a large fraction of the pool pays its own
price impact twice and makes NAV a function of its own size rather than of the market.

The router and adapter have both been replaced since the first deploy, and the **vault address has
never changed** — which is the point of doing it this way. Two scripts cover the two cases:
`rotateStrategy.ts` when only an adapter changed, and `migrateRouter.ts` when the router did, which
additionally recalls capital and re-points the vault. Neither mints or burns a share, so published
links, verified explorer pages and depositors' positions all survive a fix.

Each migration costs one round trip through the pool — 0.0102 USDT for the adapter rotation and
0.0073 for the router migration, on a ~4 USDT vault. That is the 0.3% swap fee on the paired half,
paid twice, and it is why the scripts print NAV and share supply either side rather than reporting
success.

Manifest: [`contracts/deployments/botTestnet.json`](contracts/deployments/botTestnet.json).

---

## Repository layout

```
contracts/          Hardhat workspace — Solidity, tests, deploy + keeper scripts
  contracts/        BotVault, StrategyRouter, BaseStrategy, BdexV2LpStrategy, interfaces
  test/             fork-based suite; no mocks, no local stand-ins
  scripts/          preflight · deploy · verify · e2e · exit · harvestBot · exportAbi
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
npm run preflight:testnet  # read-only. Sends nothing.
npm run deploy:testnet
npm run verify:testnet
npm run export-abi
npm run e2e:testnet        # full loop against real BDEX
npm run harvest-bot        # keeper, leave running
```

`preflight` earns its place: every check it makes otherwise costs a failed deploy to discover — an
RPC that does not resolve, a chainId disagreeing with the config, an unfunded deployer, a DEX pair
that does not exist, or a pool too thin to enter. It caught a stale `ASSET_DECIMALS=18` that would
have made every amount in the deployment wrong by a factor of 10¹².

There is **no faucet for the asset**, because the asset is real USDT. `e2e` acquires it by swapping
native BOT through BDEX. `npm run exit` withdraws a whole position from a deployment.

### Mainnet

Mainnet is deliberately last. Chain 677, USDT `0xaBabc7Dd…7a3C`, BDEX Router02 `0x1414eD29…9e76` —
all defaulted in `scripts/config.ts`, so the deploy needs no addresses passed in. Check pool depth
first and size `LEG_CAP` / `DEPOSIT_CAP` against it:

```bash
npm run preflight:mainnet
npm run deploy:mainnet && npm run verify:mainnet
```

Then flip the frontend with one variable: `NEXT_PUBLIC_DEFAULT_CHAIN_ID=677`.

Gas support: https://forms.gle/QGWNnmthCDgL92uR9

### Hosting the frontend

The app lives in `web/`, not the repository root, so the one setting that matters is the root
directory:

| Vercel setting | Value |
|---|---|
| Root Directory | `web` |
| Framework | Next.js (auto-detected) |
| `NEXT_PUBLIC_DEFAULT_CHAIN_ID` | `968` for testnet, `677` after mainnet |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional — only adds the WalletConnect QR flow |

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

**68 tests**, all against live BDEX liquidity:

| Suite | Covers |
|---|---|
| `BotVault` | ERC-4626 conformance, weighted routing, the reserve buffer, liquidity-aware maxima, harvest and fees, pause, curator controls, multi-user share accounting |
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

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 677 | 968 |
| RPC | https://rpc.botchain.ai | https://rpc.bohr.life |
| Explorer | https://scan.botchain.ai | https://scan.bohr.life |
| Faucet | — | https://faucet.botchain.ai/basic (10 tBOT / 24h) |

BOT Chain: https://www.botchain.ai/en · Dev docs: https://dev-docs.botchain.ai ·
BDEX addresses: https://dev-docs.botchain.ai/docs/DEX/contract-addresses/

The testnet is chain **968** and is served from `bohr.life`, not a `botchain.ai` subdomain.

---

MIT licensed.
