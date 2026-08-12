# Phony — BotRestake: RWA Yield Restaking & Strategy Vault
## BOT Chain Builder Challenge #2 — Build Document

---

## 1. Executive Summary

**Phony** is an ERC-4626 yield restaking vault on BOT Chain that accepts tokenized Real World Assets (RWAs) and automatically routes them into optimized, auto-compounding yield strategies. It transforms "dead productive capital" into productive, composable DeFi positions — the first RWA restaking primitive on BOT Chain.

| Field | Value |
|-------|-------|
| **Track** | RWA Applications |
| **Sub-tracks** | RWA Restaking, Product Aggregation, Infrastructure |
| **Prize Pool Target** | Up to 5,000 USDT |
| **Build Period** | Aug 10 – Aug 24 (12 days) |
| **Submission Deadline** | Aug 22, 23:59 UTC+8 |
| **Team Size** | 2 developers |
| **Chain** | BOT Chain Mainnet (Chain ID: 677) |

---

## 2. Problem Statement

### 2.1 The Core Problem

**RWA tokens are dead productive capital.** When an investor holds a tokenized T-bill, private credit note, or commodity receipt, it sits in their wallet earning exactly one flat yield. There is no infrastructure to restake, rehypothecate, or strategically route these assets into higher-yield positions — unlike ETH, which has EigenLayer, Lido, Aave, and dozens of yield strategies.

### 2.2 Three Specific Pain Points

| Pain Point | Impact |
|------------|--------|
| **Capital Inefficiency** | A $10,000 tokenized treasury earns 4% APY and does nothing else. It cannot be used as collateral, looped into leverage, or composed into DeFi strategies. |
| **Fragmentation** | Each RWA issuer (Ondo, Centrifuge, Maple, etc.) operates a siloed interface. Investors must manually compare yields, manage multiple wallets, and handle different redemption mechanics. |
| **No Auto-Compounding** | Most RWA yields are distributed manually or periodically. Investors lose ~15–20% of effective APY to idle cash and reinvestment friction. |

### 2.3 Target User

**Maria, the RWA Investor:** Holds $50,000 across three tokenized assets — T-bills (4.2% APY), private credit (8% APY), and commodity receipts (6% APY). Currently, these sit in three separate dashboards, pay yields quarterly, and cannot be used for anything else. She wants one place to deposit, auto-compound, and withdraw.

---

## 3. GitHub Research Basis

This section documents the open-source research that validates the architecture, design patterns, and market need for BotRestake. These references should be cited in the project README and demo presentation.

### 3.1 Yield Aggregation Infrastructure (StakeKit / Yield.xyz)

**Repository:** `stakekit/yield.xyz`  
**URL:** https://github.com/stakekit/yield.xyz  
**Relevance:** Yield.xyz provides the most complete API for integrating staking, restaking, lending, and RWA yields across 70+ blockchain networks. Their architecture proves that unified yield aggregation is a massive infrastructure need in DeFi.

**Key Insights for Phony:**
- Yield aggregation requires a standardized interface across diverse yield sources
- Vault share tokens (like ERC-4626) are the optimal abstraction for user deposits
- Auto-compounding must be gas-efficient and batched
- Cross-protocol yield comparison and routing is a core value proposition

**How We Apply It:** Phony adopts the ERC-4626 vault pattern as the unified deposit interface and implements a StrategyRouter that mimics Yield.xyz's multi-source aggregation logic, but scoped specifically to RWA tokens on BOT Chain.

### 3.2 Asynchronous Curator Vaults (Ditto Network)

**Repository:** `dittonetwork/curator-vault`  
**URL:** https://github.com/dittonetwork/curator-vault  
**Relevance:** Ditto Network's vault architecture demonstrates how to build asynchronous curator vaults with strategy routing, NAV attestation, and multi-asset support. Their design is directly applicable to RWA restaking.

**Key Insights for Phony:**
- Asynchronous vaults allow for non-instant strategy rebalancing, which is critical for RWA assets with settlement delays
- Curator/governance roles are needed to whitelist strategies and set allocation limits
- NAV (Net Asset Value) tracking must be transparent and on-chain verifiable
- Emergency pause and withdrawal queue mechanisms are essential for security

**How We Apply It:** Phony's StrategyRouter implements a simplified curator pattern where the vault owner can whitelist RWA yield strategies and set allocation caps. The vault tracks share price (NAV) transparently using ERC-4626's `convertToAssets()` function.

### 3.3 ERC-4626 Tokenized Vault Standard (OpenZeppelin)

**Repository:** `OpenZeppelin/openzeppelin-contracts`  
**URL:** https://github.com/OpenZeppelin/openzeppelin-contracts  
**Relevance:** The ERC-4626 standard is the gold standard for yield-bearing vaults. OpenZeppelin's implementation is battle-tested, audited, and widely adopted across DeFi.

**Key Insights for Phony:**
- ERC-4626 provides a standardized interface for deposits, withdrawals, and share tracking
- `previewDeposit()`, `previewWithdraw()`, and `convertToShares()` enable accurate NAV calculation
- The standard is natively compatible with DeFi aggregators, wallets, and explorers
- Inheritance from OpenZeppelin reduces audit surface and increases judge confidence

**How We Apply It:** Phony's `BotVault.sol` inherits from OpenZeppelin's ERC-4626 implementation, ensuring compatibility with all standard DeFi tooling and providing a familiar interface for users and integrators.

### 3.4 RWA Token Standards (ERC-3643 / T-REX)

**Repository:** `aboudjem/ERC-3643`  
**URL:** https://github.com/aboudjem/ERC-3643  
**Relevance:** While Phony does not implement ERC-3643 directly, understanding the T-REX standard (used by Tokeny and BlackRock BUIDL) ensures our vault can accept compliant security tokens in future iterations.

**Key Insights for Phony:**
- Permissioned tokens require on-chain identity and compliance hooks
- Future RWA tokens on BOT Chain may adopt ERC-3643
- Designing the vault with extensible strategy adapters allows for compliance-token integration later

**How We Apply It:** Phony's `StrategyAdapter` interface is designed to be extensible. A future `ERC3643Adapter` could wrap permissioned tokens and enforce compliance checks before deposit/withdrawal.

### 3.5 Multi-Agent Verification (VaultWatch / Prop99)

**Repository:** `VaultWatch/vaultwatch-contracts` (reference architecture)  
**URL:** https://github.com/VaultWatch  
**Relevance:** VaultWatch's hackathon-winning architecture uses 7 AI agents with Brier-score reputation and on-chain consensus. While Phony is not a verification system, their agent-orchestration pattern inspires our yield-harvester bot.

**Key Insights for Phony:**
- Automated off-chain processes (like yield harvesting) can be triggered by keeper bots
- On-chain event emission enables transparent, auditable automation
- Gas-efficient batching is critical for sustainable automation

**How We Apply It:** Phony includes a `HarvestBot` (keeper script) that monitors vault yields, triggers auto-compounding when gas costs are favorable, and emits on-chain events for transparency.

---

## 4. Architecture

### 4.1 System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER LAYER                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Investor   │  │   Curator    │  │    Harvest Bot       │  │
│  │  (Deposit/   │  │ (Whitelist   │  │  (Auto-compound)     │  │
│  │  Withdraw)   │  │  Strategies) │  │                      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼─────────────────┼─────────────────────┼──────────────┘
          │                 │                     │
          ▼                 ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SMART CONTRACT LAYER                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    BotVault.sol                          │    │
│  │              (ERC-4626 Vault Core)                       │    │
│  │  • deposit() / withdraw() / redeem() / mint()           │    │
│  │  • totalAssets() / convertToShares() / previewDeposit() │    │
│  │  • Emergency pause / Withdrawal queue                   │    │
│  └────────────────────┬────────────────────────────────────┘    │
│                       │                                          │
│                       ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                 StrategyRouter.sol                       │    │
│  │         (Allocation & Rebalancing Engine)                │    │
│  │  • Whitelist strategies                                  │    │
│  │  • Set allocation weights (per-strategy caps)           │    │
│  │  • Rebalance deposits across strategies                 │    │
│  │  • Harvest yields and route to vault                    │    │
│  └──────────┬──────────────────────────────┬───────────────┘    │
│             │                              │                    │
│             ▼                              ▼                    │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │  StrategyAdapter │          │  StrategyAdapter │            │
│  │    Interface     │          │    Interface     │            │
│  │                  │          │                  │            │
│  │  • deposit()     │          │  • deposit()     │            │
│  │  • withdraw()    │          │  • withdraw()    │            │
│  │  • harvest()     │          │  • harvest()     │            │
│  │  • totalAssets() │          │  • totalAssets() │            │
│  └────────┬─────────┘          └────────┬─────────┘            │
│           │                             │                       │
│           ▼                             ▼                       │
│  ┌──────────────────┐          ┌──────────────────┐            │
│  │  TBillStrategy   │          │  CreditStrategy  │            │
│  │  (T-Bill Yield)  │          │  (Credit Yield)  │            │
│  └──────────────────┘          └──────────────────┘            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Supported RWA Tokens (Real)                 │    │
│  │  • TBILL Token (tokenized treasury bills)               │    │
│  │  • PCREDIT Token (private credit notes)                 │    │
│  │  • COMMODITY Token (tokenized commodity receipts)       │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Contract Specifications

#### 4.2.1 BotVault.sol (ERC-4626 Vault)

**Inherits:** `ERC4626`, `Ownable`, `Pausable`, `ReentrancyGuard`

**Core Functions:**

```solidity
function deposit(uint256 assets, address receiver) 
    public override nonReentrant whenNotPaused returns (uint256 shares);

function withdraw(uint256 assets, address receiver, address owner) 
    public override nonReentrant whenNotPaused returns (uint256 shares);

function redeem(uint256 shares, address receiver, address owner) 
    public override nonReentrant whenNotPaused returns (uint256 assets);

function totalAssets() public view override returns (uint256);
// Returns sum of assets held in vault + all strategy adapters

function convertToShares(uint256 assets) public view override returns (uint256);
function convertToAssets(uint256 shares) public view override returns (uint256);
function previewDeposit(uint256 assets) public view override returns (uint256);
function previewWithdraw(uint256 assets) public view override returns (uint256);
```

**Admin Functions:**

```solidity
function setStrategyRouter(address _router) external onlyOwner;
function pause() external onlyOwner;
function unpause() external onlyOwner;
function emergencyWithdraw(address token, uint256 amount) external onlyOwner;
```

**Events:**

```solidity
event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
event StrategyRouterUpdated(address indexed oldRouter, address indexed newRouter);
event Harvested(uint256 amount, uint256 timestamp);
event EmergencyWithdraw(address indexed token, uint256 amount);
```

**Key Design Decisions:**
- **ERC-4626 Standard:** Ensures compatibility with wallets, explorers, and DeFi aggregators
- **Pausable:** Emergency stop for security incidents
- **ReentrancyGuard:** Protects against reentrancy in deposit/withdraw flows
- **totalAssets() Override:** Dynamically queries all strategy adapters to report true NAV

#### 4.2.2 StrategyRouter.sol (Allocation Engine)

**Inherits:** `Ownable`

**Core Functions:**

```solidity
struct Strategy {
    address adapter;
    uint256 allocationBps; // Allocation in basis points (max 10000 = 100%)
    uint256 maxDeposit;    // Max assets per strategy
    bool active;
}

mapping(uint256 => Strategy) public strategies;
uint256 public strategyCount;
uint256 public totalAllocationBps;

function addStrategy(address adapter, uint256 allocationBps, uint256 maxDeposit) 
    external onlyOwner;

function updateStrategy(uint256 strategyId, uint256 allocationBps, uint256 maxDeposit, bool active) 
    external onlyOwner;

function removeStrategy(uint256 strategyId) external onlyOwner;

function routeDeposit(uint256 amount) external onlyVault;
// Splits deposit across strategies according to allocation weights

function routeWithdraw(uint256 amount) external onlyVault;
// Withdraws proportionally from strategies to fulfill user withdrawal

function harvestAll() external;
// Iterates all strategies, calls harvest(), and routes yield back to vault

function getTotalStrategyAssets() external view returns (uint256);
```

**Key Design Decisions:**
- **Basis Point Allocation:** Simple, gas-efficient weighting system
- **Max Deposit Caps:** Prevents over-concentration in any single strategy
- **Proportional Withdrawal:** Withdraws from all strategies proportionally to maintain allocation ratios
- **OnlyVault Modifier:** Ensures only the vault contract can trigger routing

#### 4.2.3 IStrategyAdapter.sol (Interface)

```solidity
interface IStrategyAdapter {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external returns (uint256);
    function harvest() external returns (uint256 harvestedAmount);
    function totalAssets() external view returns (uint256);
    function underlyingToken() external view returns (address);
    function name() external view returns (string memory);
    function estimatedAPY() external view returns (uint256); // In basis points
}
```

#### 4.2.4 TBillStrategy.sol (Treasury Bill Yield Strategy)

**Purpose:** Integrates with tokenized treasury bill protocols to earn base yield.

```solidity
contract TBillStrategy is IStrategyAdapter, Ownable {
    IERC20 public underlyingToken; // e.g., USDC or TBILL token
    address public yieldSource;    // e.g., Ondo or similar protocol on BOT Chain
    uint256 public totalDeposited;
    uint256 public lastHarvestTime;

    function deposit(uint256 amount) external override {
        underlyingToken.transferFrom(msg.sender, address(this), amount);
        // Deposit into yield source
        // e.g., IERC4626(yieldSource).deposit(amount, address(this));
        totalDeposited += amount;
    }

    function withdraw(uint256 amount) external override returns (uint256) {
        // Withdraw from yield source
        // e.g., IERC4626(yieldSource).withdraw(amount, address(this), address(this));
        totalDeposited -= amount;
        underlyingToken.transfer(msg.sender, amount);
        return amount;
    }

    function harvest() external override returns (uint256) {
        // Claim yield from yield source
        // e.g., uint256 yield = yieldSource.claimYield();
        // Transfer yield to vault
        lastHarvestTime = block.timestamp;
        return yield;
    }

    function totalAssets() external view override returns (uint256) {
        // Return total value including accrued yield
        // e.g., return IERC4626(yieldSource).convertToAssets(
        //            IERC4626(yieldSource).balanceOf(address(this))
        //        );
    }

    function estimatedAPY() external view override returns (uint256) {
        // Query yield source for current APY
        // e.g., return yieldSource.getAPY();
    }
}
```

#### 4.2.5 CreditStrategy.sol (Private Credit Yield Strategy)

**Purpose:** Integrates with private credit or lending protocols for higher yield.

```solidity
contract CreditStrategy is IStrategyAdapter, Ownable {
    IERC20 public underlyingToken;
    address public creditPool;     // e.g., Maple or Centrifuge pool on BOT Chain
    uint256 public totalDeposited;
    uint256 public lastHarvestTime;

    function deposit(uint256 amount) external override {
        underlyingToken.transferFrom(msg.sender, address(this), amount);
        // Deposit into credit pool
        totalDeposited += amount;
    }

    function withdraw(uint256 amount) external override returns (uint256) {
        // Withdraw from credit pool (may have lockup/notice period)
        totalDeposited -= amount;
        underlyingToken.transfer(msg.sender, amount);
        return amount;
    }

    function harvest() external override returns (uint256) {
        // Claim distributed interest from credit pool
        lastHarvestTime = block.timestamp;
        return yield;
    }

    function totalAssets() external view override returns (uint256);
    function estimatedAPY() external view override returns (uint256);
}
```

#### 4.2.6 LiquidityStrategy.sol (RWA Liquidity Provision)

**Purpose:** Provides liquidity to RWA trading pairs on DEXs to earn trading fees.

```solidity
contract LiquidityStrategy is IStrategyAdapter, Ownable {
    IERC20 public underlyingToken;
    address public dexRouter;      // e.g., Uniswap V2/V3 or BOT Chain DEX
    address public pair;           // e.g., TBILL/USDC pair
    uint256 public totalDeposited;

    function deposit(uint256 amount) external override {
        underlyingToken.transferFrom(msg.sender, address(this), amount);
        // Add liquidity to DEX pair
        // e.g., IUniswapV2Router(dexRouter).addLiquidity(...)
        totalDeposited += amount;
    }

    function withdraw(uint256 amount) external override returns (uint256) {
        // Remove liquidity from DEX pair
        totalDeposited -= amount;
        underlyingToken.transfer(msg.sender, amount);
        return amount;
    }

    function harvest() external override returns (uint256) {
        // Claim trading fees / LP rewards
        return fees;
    }

    function totalAssets() external view override returns (uint256);
    function estimatedAPY() external view override returns (uint256);
}
```

---

## 5. Frontend Specifications

### 5.1 Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14 (App Router) |
| Styling | Tailwind CSS + shadcn/ui |
| Web3 | wagmi + viem |
| Wallet | RainbowKit |
| Charts | Recharts |
| State | Zustand |
| Deployment | Vercel |

### 5.2 Page Structure

```
/
├── /                    → Landing page (hero + value prop + CTA)
├── /vault               → Main vault interface (deposit/withdraw)
├── /strategies          → Strategy explorer (APYs, allocations, details)
├── /portfolio           → User dashboard (positions, yield history, P&L)
└── /docs                → Project documentation + GitHub links
```

### 5.3 Key UI Components

#### 5.3.1 Vault Interface (`/vault`)

```
┌─────────────────────────────────────────────────────────────┐
│  BotRestake Vault                    [Connect Wallet]       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Total Value Locked          Your Position          │   │
│  │  $1,245,000.00               $5,000.00 (50 shares)  │   │
│  │  ↑ 12.5% (24h)               ↑ $45.23 (24h yield)   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  [Deposit]  [Withdraw]                              │   │
│  │                                                     │   │
│  │  Token: [TBILL ▼]             Amount: [_____] [Max] │   │
│  │  Balance: 10,000 TBILL                              │   │
│  │                                                     │   │
│  │  You will receive: ~49.5 brRWA shares               │   │
│  │  1 brRWA = $1.0101 TBILL                            │   │
│  │                                                     │   │
│  │  [         Deposit & Restake          ]             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Current Allocation                                 │   │
│  │  [Pie Chart]                                        │   │
│  │  • T-Bill Strategy: 40% ($498,000) @ 4.2% APY      │   │
│  │  • Credit Strategy: 35% ($435,750) @ 8.0% APY      │   │
│  │  • Liquidity Pool:  20% ($249,000) @ 6.5% APY      │   │
│  │  • Reserve Buffer:   5% ($62,250)  @ 0.0% APY      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 5.3.2 Portfolio Dashboard (`/portfolio`)

- **Position Card:** Current brRWA balance, USD value, share price, entry price
- **Yield History Chart:** Daily/weekly yield accrual (Recharts area chart)
- **Transaction History:** Deposit/withdraw/harvest events with timestamps
- **APY Breakdown:** Weighted average APY vs. holding underlying tokens

#### 5.3.3 Strategy Explorer (`/strategies`)

- **Strategy Cards:** Name, adapter address, APY, total deposits, allocation %, risk level
- **Risk Indicators:** Low/Medium/High based on strategy type
- **Performance Metrics:** 7-day, 30-day, all-time yield

### 5.4 Wallet Integration

```typescript
// wagmi config for BOT Chain
import { createConfig, http } from 'wagmi'
import { botChain } from './chains'

export const config = createConfig({
  chains: [botChain],
  transports: {
    [botChain.id]: http('https://rpc.botchain.ai'),
  },
})

// BOT Chain definition
export const botChain = {
  id: 677,
  name: 'BOT Chain',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.botchain.ai'] },
    public: { http: ['https://rpc.botchain.ai'] },
  },
  blockExplorers: {
    default: { name: 'BOT Explorer', url: 'https://explorer.botchain.ai' },
  },
}
```

---

## 6. BOT Chain Integration

### 6.1 Network Configuration

| Parameter | Value |
|-----------|-------|
| **Chain ID** | 677 |
| **RPC URL** | https://rpc.botchain.ai |
| **Currency Symbol** | BOT |
| **Block Explorer** | https://explorer.botchain.ai |
| **Contract Verification** | Via explorer or hardhat-verify |

### 6.2 Deployment Strategy: Testnet First, Mainnet Last

**IMPORTANT:** Mainnet deployment is the final integration step. The project will be deployed and thoroughly tested on BOT Chain Testnet before any Mainnet deployment occurs.

**Phase 1 — Testnet Development & Testing:**
1. Deploy `BotVault` contract to BOT Chain Testnet
2. Deploy `StrategyRouter` to Testnet
3. Deploy `TBillStrategy`, `CreditStrategy`, `LiquidityStrategy` to Testnet
4. Configure StrategyRouter with allocation weights
5. Run full integration tests: deposit → allocate → harvest → withdraw
6. Frontend integration against Testnet contracts
7. Security review and bug fixes

**Phase 2 — Mainnet Deployment (Final Step):**
1. Apply for Mainnet gas support: https://forms.gle/QGWNnmthCDgL92uR9
2. Deploy all contracts to BOT Chain Mainnet
3. Verify all contracts on BOT Chain explorer
4. Configure production allocation weights
5. Final end-to-end testing on Mainnet
6. Frontend switch to Mainnet RPC
7. Submit project via official form

**Deployment Order:**
1. Deploy `StrategyRouter`
2. Deploy `BotVault` (with StrategyRouter address)
3. Deploy `TBillStrategy` (with yield source address)
4. Deploy `CreditStrategy` (with credit pool address)
5. Deploy `LiquidityStrategy` (with DEX router address)
6. Configure StrategyRouter (add strategies with allocation weights)
7. Verify all contracts on BOT Chain explorer
8. Deploy frontend to Vercel

### 6.3 Gas Support

Apply for Mainnet gas support:  
**Form:** https://forms.gle/QGWNnmthCDgL92uR9  
**Amount:** 1 BOT per eligible project

---

## 7. Testing Strategy

### 7.1 Unit Tests (Hardhat + Chai)

```javascript
// Example test: BotVault deposit/withdraw
describe("BotVault", function () {
  it("Should mint correct shares on deposit", async function () {
    const depositAmount = ethers.parseUnits("1000", 18);
    await tBillToken.approve(vault.address, depositAmount);
    await vault.deposit(depositAmount, owner.address);

    const shares = await vault.balanceOf(owner.address);
    expect(shares).to.be.gt(0);
  });

  it("Should route deposits according to allocation weights", async function () {
    // Deposit 1000 TBILL
    // Expect 40% (400) to TBillStrategy, 35% (350) to CreditStrategy, etc.
  });

  it("Should auto-compound on harvest", async function () {
    // Advance time, trigger harvest, verify share price increase
  });
});
```

### 7.2 Integration Tests

- Full deposit → allocate → harvest → withdraw flow
- Emergency pause and unpause
- Strategy removal and rebalancing
- Multi-user deposit/withdraw with share price changes
- Strategy adapter integration with real yield sources

### 7.3 Frontend Tests

- Wallet connection on BOT Chain
- Deposit transaction flow (Testnet)
- Share price calculation accuracy
- Chart data rendering

---

## 8. Security Considerations

| Risk | Mitigation |
|------|------------|
| Reentrancy | Use OpenZeppelin ReentrancyGuard on all external-facing functions |
| Integer Overflow | Use Solidity 0.8+ built-in overflow checks |
| Strategy Failure | Max deposit caps per strategy, emergency pause, withdrawal queue |
| Centralization | Curator role for strategy management (can be transferred to DAO later) |
| Front-running | No time-sensitive operations; share price calculated at block time |
| Oracle Manipulation | No external price oracles in MVP; yield is internally calculated |
| Yield Source Failure | Diversified strategy allocation prevents single-point-of-failure |

---

## 9. Judging Criteria Alignment

| Criterion (Weight) | How Phony Maximizes Score |
|--------------------|---------------------------|
| **Product Completion (30%)** | Full DeFi loop: deposit → allocate → compound → withdraw. Dual dashboard (vault + portfolio). Complete business operation loop. |
| **Mainnet Integration (25%)** | Native BOT Chain deployment. BOT token for gas. Deep wallet integration (RainbowKit + wagmi). Contract verification on explorer. |
| **Innovation (20%)** | First RWA restaking primitive on BOT Chain. ERC-4626 vault + strategy router pattern applied to RWAs. Auto-compounding for traditionally manual assets. |
| **User Experience (15%)** | Clean APY tracking, real-time allocation pie chart, withdrawal preview, transaction history, one-click deposit/withdraw. |
| **Technical Quality (10%)** | Well-tested ERC-4626 with strategy adapter pattern. OpenZeppelin inheritance. Modular, extensible architecture. 90%+ test coverage. |

**Additional Ecosystem Alignment:**
- Directly addresses **"RWA restaking"** and **"product aggregation"** — the hackathon's highest-priority directions
- Infrastructure play: other RWA projects on BOT Chain can integrate with BotRestake
- Long-term potential: can evolve into a full RWA yield aggregator with real protocol integrations

---

## 10. Submission Checklist

### 10.1 Required Deliverables

- [ ] **BOT Chain Mainnet Deployment** — All contracts deployed and verified (final step after Testnet validation)
- [ ] **Public Website / Online Demo** — Vercel deployment with custom domain
- [ ] **Wallet Integration** — RainbowKit + wagmi on BOT Chain
- [ ] **GitHub Repository** — Private repo with judge access granted
- [ ] **Complete User/Business Loop** — Deposit → Allocate → Harvest → Withdraw
- [ ] **Project Originality** — Original code, no copied projects

### 10.2 Recommended Deliverables

- [ ] **Demo Video** — 3-minute walkthrough of the full product loop
- [ ] **Project Documentation** — README with architecture, deployment instructions, research basis
- [ ] **Gas Support Application** — Submit form for 1 BOT gas support

### 10.3 Submission Form

**URL:** https://forms.gle/ZKvnfcGrkZmdgigA8  
**Deadline:** Aug 22, 23:59 UTC+8

---

## 11. Important Links

| Resource | URL |
|----------|-----|
| **Hackathon Registration** | https://luma.com/238et7cw?tk=AyitA5 |
| **Full Challenge Handbook** | https://app.notion.com/p/BOT-Chain-Builder-Challenge-2-3b246f6c38d5803495bac38b8c078690 |
| **Project Submission Form** | https://forms.gle/ZKvnfcGrkZmdgigA8 |
| **Gas Support Apply** | https://forms.gle/QGWNnmthCDgL92uR9 |
| **Builder Hub (Telegram)** | https://t.me/BotChain_official/61 |
| **BOT Chain Official Website** | https://www.botchain.ai/en |
| **BOT Chain Explorer** | https://explorer.botchain.ai |
| **BOT Chain RPC** | https://rpc.botchain.ai |

---

## 12. GitHub Research References (Cite in README)

1. **StakeKit / Yield.xyz** — `stakekit/yield.xyz` — Unified RWA yield aggregation API across 70+ networks
2. **Ditto Network** — `dittonetwork/curator-vault` — Asynchronous curator vaults with strategy routing and NAV attestation
3. **OpenZeppelin** — `OpenZeppelin/openzeppelin-contracts` — Battle-tested ERC-4626 implementation
4. **Aboudjem / ERC-3643** — `aboudjem/ERC-3643` — T-REX security token standard for future compliance integration
5. **VaultWatch** — `VaultWatch/vaultwatch-contracts` — Multi-agent verification with Brier-score reputation (inspiration for keeper automation)

---

*Built for BOT Chain Builder Challenge #2 — RWA Applications Track*  
*Project Name: Phony*  
*Build Period: Aug 10–24, 2026*
