// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";
import {IStrategyRouter} from "./interfaces/IStrategyRouter.sol";
import {IBotVault} from "./interfaces/IBotVault.sol";

/// @title StrategyRouter — Phony's allocation and rebalancing engine
/// @notice Holds the curator's whitelist of RWA yield strategies and the weights between
///         them. Deposits are split by weight, withdrawals are pulled back proportionally
///         so weights survive an exit, and harvests are swept in one pass and forwarded to
///         the vault where they compound into the share price.
///
/// @dev    The curator pattern here is the simplified form of Ditto's asynchronous curator
///         vault: the owner may whitelist adapters, set per-strategy weights and caps, and
///         retire strategies — but may never move funds anywhere except into a whitelisted
///         adapter or back to the vault. There is no path from `onlyOwner` to an arbitrary
///         transfer, which is what keeps the centralisation risk bounded to "curator picks
///         bad strategies" rather than "curator takes the money".
///
///         `totalAllocationBps` is allowed to sit below 10 000. The gap is the vault's
///         reserve buffer: leave 500 bps unallocated and 5% of TVL stays liquid in the
///         vault for cheap withdrawals.
contract StrategyRouter is IStrategyRouter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_BPS = 10_000;

    struct Strategy {
        address adapter;
        uint256 allocationBps; // Allocation in basis points (max 10000 = 100%)
        uint256 maxDeposit; // Max assets per strategy; 0 = uncapped
        bool active;
    }

    /// @notice The asset every strategy under this router accepts.
    address public immutable asset;

    /// @notice The vault this router exclusively serves.
    address public immutable vault;

    mapping(uint256 => Strategy) public strategies;
    uint256 public strategyCount;
    uint256 public totalAllocationBps;

    /// @notice Guards against an adapter registered twice under two ids, which would
    ///         double-count its assets in `getTotalStrategyAssets()` and inflate NAV.
    mapping(address => bool) public isRegisteredAdapter;

    event StrategyAdded(uint256 indexed strategyId, address indexed adapter, uint256 allocationBps, uint256 maxDeposit);
    event StrategyUpdated(uint256 indexed strategyId, uint256 allocationBps, uint256 maxDeposit, bool active);
    event StrategyRemoved(uint256 indexed strategyId, address indexed adapter, uint256 recovered);
    event DepositRouted(uint256 totalAmount, uint256 deployed);
    event WithdrawRouted(uint256 requested, uint256 withdrawn);
    event StrategyHarvested(uint256 indexed strategyId, address indexed adapter, uint256 amount);
    event HarvestCompleted(uint256 totalHarvested, uint256 timestamp);
    /// @notice A strategy declined a deposit and was passed over; the capital stayed idle.
    event StrategySkipped(uint256 indexed strategyId, address indexed adapter, uint256 amount);

    event Rebalanced(uint256 totalAssets, uint256 timestamp);

    error ZeroAddress();
    error NotVault();
    error InvalidStrategy(uint256 strategyId);
    error AdapterAlreadyRegistered(address adapter);
    error AdapterAssetMismatch(address adapterAsset, address routerAsset);
    error AllocationExceedsMax(uint256 requested, uint256 max);
    error StrategyNotEmpty(uint256 strategyId, uint256 remaining);

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier validStrategy(uint256 strategyId) {
        if (strategyId >= strategyCount || strategies[strategyId].adapter == address(0)) {
            revert InvalidStrategy(strategyId);
        }
        _;
    }

    constructor(address asset_, address vault_, address initialOwner) Ownable(initialOwner) {
        if (asset_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        asset = asset_;
        vault = vault_;
    }

    /*//////////////////////////////////////////////////////////////
                          CURATOR: WHITELISTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Whitelist a strategy adapter and give it a share of new deposits.
    function addStrategy(address adapter, uint256 allocationBps, uint256 maxDeposit)
        external
        onlyOwner
        returns (uint256 strategyId)
    {
        if (adapter == address(0)) revert ZeroAddress();
        if (isRegisteredAdapter[adapter]) revert AdapterAlreadyRegistered(adapter);

        address adapterAsset = IStrategyAdapter(adapter).underlyingToken();
        if (adapterAsset != asset) revert AdapterAssetMismatch(adapterAsset, asset);

        uint256 newTotal = totalAllocationBps + allocationBps;
        if (newTotal > MAX_BPS) revert AllocationExceedsMax(newTotal, MAX_BPS);

        strategyId = strategyCount;
        strategies[strategyId] =
            Strategy({adapter: adapter, allocationBps: allocationBps, maxDeposit: maxDeposit, active: true});
        strategyCount = strategyId + 1;
        totalAllocationBps = newTotal;
        isRegisteredAdapter[adapter] = true;

        emit StrategyAdded(strategyId, adapter, allocationBps, maxDeposit);
    }

    /// @notice Re-weight, re-cap, or deactivate a strategy.
    /// @dev    Deactivating stops new deposits but leaves existing capital in place and
    ///         still harvestable — withdrawals continue to drain it proportionally. Use
    ///         `removeStrategy` to fully retire it.
    function updateStrategy(uint256 strategyId, uint256 allocationBps, uint256 maxDeposit, bool active)
        external
        onlyOwner
        validStrategy(strategyId)
    {
        Strategy storage s = strategies[strategyId];

        uint256 newTotal = totalAllocationBps - s.allocationBps + allocationBps;
        if (newTotal > MAX_BPS) revert AllocationExceedsMax(newTotal, MAX_BPS);

        totalAllocationBps = newTotal;
        s.allocationBps = allocationBps;
        s.maxDeposit = maxDeposit;
        s.active = active;

        emit StrategyUpdated(strategyId, allocationBps, maxDeposit, active);
    }

    /// @notice Retire a strategy, returning whatever it still holds to the vault.
    /// @dev    Reverts if the adapter cannot return everything (a credit pool mid-notice-
    ///         period, for instance). Removing a strategy while it still holds assets would
    ///         drop them out of `getTotalStrategyAssets()` and crater the share price, so
    ///         the check is a correctness guard, not a convenience.
    function removeStrategy(uint256 strategyId) external onlyOwner validStrategy(strategyId) {
        Strategy storage s = strategies[strategyId];
        IStrategyAdapter adapter = IStrategyAdapter(s.adapter);

        uint256 recovered;
        uint256 held = adapter.totalAssets();
        if (held > 0) {
            recovered = adapter.withdraw(held);
            if (recovered > 0) IERC20(asset).safeTransfer(vault, recovered);

            uint256 remaining = adapter.totalAssets();
            if (remaining > 0) revert StrategyNotEmpty(strategyId, remaining);
        }

        totalAllocationBps -= s.allocationBps;
        isRegisteredAdapter[s.adapter] = false;

        emit StrategyRemoved(strategyId, s.adapter, recovered);
        delete strategies[strategyId];
    }

    /*//////////////////////////////////////////////////////////////
                              VAULT ROUTING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyRouter
    /// @dev Weights are applied to `amount`, not to TVL, so the split is stateless and
    ///      cheap. Drift between target and actual weights is corrected by `rebalance()`.
    function routeDeposit(uint256 amount) external onlyVault nonReentrant returns (uint256 deployed) {
        if (amount == 0) return 0;

        IERC20(asset).safeTransferFrom(vault, address(this), amount);

        uint256 count = strategyCount;
        for (uint256 i = 0; i < count; ++i) {
            Strategy memory s = strategies[i];
            if (s.adapter == address(0) || !s.active || s.allocationBps == 0) continue;

            uint256 target = (amount * s.allocationBps) / MAX_BPS;
            if (target == 0) continue;

            IStrategyAdapter adapter = IStrategyAdapter(s.adapter);

            // Respect the per-strategy cap: never push a strategy past `maxDeposit`.
            if (s.maxDeposit != 0) {
                uint256 held = adapter.totalAssets();
                if (held >= s.maxDeposit) continue;
                uint256 room = s.maxDeposit - held;
                if (target > room) target = room;
            }

            IERC20(asset).forceApprove(s.adapter, target);

            // A strategy that will not take the money must not take the deposit down with it.
            // The case that found this: an adapter in emergency exit reverts every `deposit`,
            // which made a single switched-off strategy revert *every user's* deposit into the
            // vault. Skipping leaves the capital idle — earning nothing, fully withdrawable, and
            // redeployable by the curator once the strategy is healthy or retired.
            try adapter.deposit(target) {
                deployed += target;
            } catch {
                emit StrategySkipped(i, s.adapter, target);
            }

            IERC20(asset).forceApprove(s.adapter, 0);
        }

        // Rounding dust and capped-out allocations go straight back — the router is a
        // conduit and must never be a resting place for capital.
        uint256 leftover = IERC20(asset).balanceOf(address(this));
        if (leftover > 0) IERC20(asset).safeTransfer(vault, leftover);

        emit DepositRouted(amount, deployed);
    }

    /// @inheritdoc IStrategyRouter
    /// @dev Two passes. The first takes from each strategy in proportion to what it holds,
    ///      which preserves the weight distribution across an exit. The second sweeps any
    ///      shortfall from whoever still has liquidity, because a partial fill on one
    ///      illiquid adapter must not fail a withdrawal the vault can otherwise cover.
    function routeWithdraw(uint256 amount) external onlyVault nonReentrant returns (uint256 withdrawn) {
        if (amount == 0) return 0;

        uint256 total = getTotalStrategyAssets();
        if (total == 0) return 0;

        uint256 target = amount > total ? total : amount;
        uint256 count = strategyCount;

        for (uint256 i = 0; i < count && withdrawn < target; ++i) {
            address adapterAddr = strategies[i].adapter;
            if (adapterAddr == address(0)) continue;

            IStrategyAdapter adapter = IStrategyAdapter(adapterAddr);
            uint256 held = adapter.totalAssets();
            if (held == 0) continue;

            uint256 share = (target * held) / total;
            if (share == 0) continue;

            uint256 remaining = target - withdrawn;
            if (share > remaining) share = remaining;

            withdrawn += adapter.withdraw(share);
        }

        for (uint256 i = 0; i < count && withdrawn < target; ++i) {
            address adapterAddr = strategies[i].adapter;
            if (adapterAddr == address(0)) continue;

            IStrategyAdapter adapter = IStrategyAdapter(adapterAddr);
            uint256 liquid = adapter.availableLiquidity();
            if (liquid == 0) continue;

            uint256 need = target - withdrawn;
            withdrawn += adapter.withdraw(liquid < need ? liquid : need);
        }

        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance > 0) IERC20(asset).safeTransfer(vault, balance);

        emit WithdrawRouted(amount, withdrawn);
    }

    /*//////////////////////////////////////////////////////////////
                                HARVEST
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyRouter
    /// @dev Permissionless — the HarvestBot is a convenience, not a trust assumption.
    ///      Batched into one pass so the keeper pays one base gas cost for N strategies.
    function harvestAll() external nonReentrant returns (uint256 totalHarvested) {
        uint256 count = strategyCount;

        for (uint256 i = 0; i < count; ++i) {
            address adapterAddr = strategies[i].adapter;
            if (adapterAddr == address(0)) continue;

            uint256 harvested = IStrategyAdapter(adapterAddr).harvest();
            if (harvested > 0) {
                totalHarvested += harvested;
                emit StrategyHarvested(i, adapterAddr, harvested);
            }
        }

        // Sweep the whole balance, not just `totalHarvested` — an adapter that rounds in
        // the vault's favour should not leave dust stranded here.
        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance > 0) {
            IERC20(asset).safeTransfer(vault, balance);
            IBotVault(vault).notifyHarvest(balance);
        }

        emit HarvestCompleted(totalHarvested, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                               REBALANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice Realign live allocations with the curator's target weights.
    /// @dev    Weights drift as strategies earn at different rates or as the curator
    ///         re-weights. This pulls the over-weight strategies down to target and pushes
    ///         the freed capital into the under-weight ones. Capital never leaves the
    ///         whitelist, so this is safe to expose to the curator.
    function rebalance() external onlyOwner nonReentrant {
        uint256 count = strategyCount;
        uint256 total = getTotalStrategyAssets();
        if (total == 0) return;

        // Deliberately *not* an early return when nothing is allocated. A curator who
        // deactivates every strategy and rebalances is asking for the capital back, and bailing
        // out here left it sitting in the strategy that was just switched off.
        uint256 allocated = totalAllocationBps;

        // Pass 1 — withdraw the excess from anything above its target weight.
        for (uint256 i = 0; i < count; ++i) {
            Strategy memory s = strategies[i];
            if (s.adapter == address(0)) continue;

            IStrategyAdapter adapter = IStrategyAdapter(s.adapter);
            uint256 held = adapter.totalAssets();
            if (held == 0) continue;

            // Targets are expressed against deployed capital, so weights are normalised by
            // `totalAllocationBps` rather than by 10 000 — the unallocated remainder is the
            // vault's buffer and was never the router's to hold. With nothing allocated every
            // target is zero, which also keeps the division below out of reach of a zero
            // denominator.
            uint256 target =
                (s.active && allocated > 0) ? (total * s.allocationBps) / allocated : 0;
            if (held > target) adapter.withdraw(held - target);
        }

        uint256 freed = IERC20(asset).balanceOf(address(this));
        if (freed == 0) {
            emit Rebalanced(total, block.timestamp);
            return;
        }

        // Pass 2 — top up anything below target with what was freed. Unreachable while nothing
        // is allocated, since a strategy needs a non-zero weight to be a candidate, so the
        // freed capital falls through to the vault below.
        for (uint256 i = 0; i < count && freed > 0 && allocated > 0; ++i) {
            Strategy memory s = strategies[i];
            if (s.adapter == address(0) || !s.active || s.allocationBps == 0) continue;

            IStrategyAdapter adapter = IStrategyAdapter(s.adapter);
            uint256 held = adapter.totalAssets();
            uint256 target = (total * s.allocationBps) / allocated;
            if (held >= target) continue;

            uint256 topUp = target - held;
            if (s.maxDeposit != 0 && held + topUp > s.maxDeposit) topUp = s.maxDeposit - held;
            if (topUp > freed) topUp = freed;
            if (topUp == 0) continue;

            IERC20(asset).forceApprove(s.adapter, topUp);
            adapter.deposit(topUp);
            IERC20(asset).forceApprove(s.adapter, 0);

            freed -= topUp;
        }

        uint256 leftover = IERC20(asset).balanceOf(address(this));
        if (leftover > 0) IERC20(asset).safeTransfer(vault, leftover);

        emit Rebalanced(total, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyRouter
    function getTotalStrategyAssets() public view returns (uint256 total) {
        uint256 count = strategyCount;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = strategies[i].adapter;
            if (adapter != address(0)) total += IStrategyAdapter(adapter).totalAssets();
        }
    }

    /// @inheritdoc IStrategyRouter
    function getAvailableLiquidity() external view returns (uint256 total) {
        uint256 count = strategyCount;
        for (uint256 i = 0; i < count; ++i) {
            address adapter = strategies[i].adapter;
            if (adapter != address(0)) total += IStrategyAdapter(adapter).availableLiquidity();
        }
    }

    /// @notice TVL-weighted APY across live strategies, in basis points.
    /// @dev    Weighted by assets actually deployed, not by target weights, so the number
    ///         reflects what the vault is really earning today. The vault's idle buffer
    ///         earns nothing and is excluded here; the frontend blends it back in.
    function weightedAPY() external view returns (uint256) {
        uint256 count = strategyCount;
        uint256 weightedSum;
        uint256 total;

        for (uint256 i = 0; i < count; ++i) {
            address adapterAddr = strategies[i].adapter;
            if (adapterAddr == address(0)) continue;

            IStrategyAdapter adapter = IStrategyAdapter(adapterAddr);
            uint256 held = adapter.totalAssets();
            if (held == 0) continue;

            weightedSum += held * adapter.estimatedAPY();
            total += held;
        }

        return total == 0 ? 0 : weightedSum / total;
    }

    /// @notice Everything the strategy explorer needs, in one call.
    /// @dev    One RPC round-trip instead of 7×N. Empty slots left by `removeStrategy` are
    ///         returned with a zero adapter so ids stay stable; the client filters them.
    function getStrategiesInfo()
        external
        view
        returns (
            address[] memory adapters,
            string[] memory names,
            uint256[] memory allocationsBps,
            uint256[] memory maxDeposits,
            uint256[] memory assets,
            uint256[] memory apys,
            bool[] memory actives
        )
    {
        uint256 count = strategyCount;
        adapters = new address[](count);
        names = new string[](count);
        allocationsBps = new uint256[](count);
        maxDeposits = new uint256[](count);
        assets = new uint256[](count);
        apys = new uint256[](count);
        actives = new bool[](count);

        for (uint256 i = 0; i < count; ++i) {
            Strategy memory s = strategies[i];
            adapters[i] = s.adapter;
            allocationsBps[i] = s.allocationBps;
            maxDeposits[i] = s.maxDeposit;
            actives[i] = s.active;

            if (s.adapter != address(0)) {
                IStrategyAdapter adapter = IStrategyAdapter(s.adapter);
                names[i] = adapter.name();
                assets[i] = adapter.totalAssets();
                apys[i] = adapter.estimatedAPY();
            }
        }
    }
}
