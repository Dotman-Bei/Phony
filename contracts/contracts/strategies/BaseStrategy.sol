// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @title BaseStrategy
/// @notice Shared skeleton for every RWA yield adapter: access control, principal
///         accounting, the harvest-accounting invariant, and emergency exit.
///
/// @dev    Concrete adapters implement four hooks (`_deployFunds`, `_freeFunds`,
///         `_sourceAssets`, `_sourceLiquidity`) and the two descriptive views. Everything
///         about *who may call*, *how much is principal*, and *what counts as yield* lives
///         here, so a new yield source cannot get the accounting wrong by omission.
///
///         The invariant that makes auto-compounding safe:
///
///             yield = totalAssets() - totalDeposited
///
///         `harvest()` frees exactly that difference and never more, so principal can
///         never be paid out as yield and booked as profit by the vault.
abstract contract BaseStrategy is IStrategyAdapter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The ERC-20 this adapter accepts and returns.
    IERC20 internal immutable _asset;

    /// @notice The router allowed to move funds in and out.
    address public router;

    /// @notice Principal placed by the router, excluding accrued yield.
    uint256 public totalDeposited;

    /// @notice Timestamp of the last successful harvest.
    uint256 public lastHarvestTime;

    /// @notice Lifetime yield realised by this adapter.
    uint256 public totalHarvested;

    /// @notice When true, the adapter refuses new deposits but still allows exit.
    bool public emergencyExit;

    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event Deposited(uint256 amount, uint256 totalDeposited);
    event Withdrawn(uint256 requested, uint256 withdrawn, uint256 totalDeposited);
    event Harvested(uint256 amount, uint256 timestamp);
    event EmergencyExitSet(bool active);
    event EmergencyUnwound(uint256 amount);

    error ZeroAddress();
    error NotRouter();
    error ZeroAmount();
    error EmergencyExitActive();
    error CannotSweepAsset();

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    constructor(address asset_, address router_, address initialOwner) Ownable(initialOwner) {
        if (asset_ == address(0)) revert ZeroAddress();
        _asset = IERC20(asset_);
        router = router_;
        lastHarvestTime = block.timestamp;
    }

    /*//////////////////////////////////////////////////////////////
                          IStrategyAdapter — CORE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyAdapter
    function deposit(uint256 amount) external override onlyRouter nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (emergencyExit) revert EmergencyExitActive();

        _asset.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        _deployFunds(amount);

        emit Deposited(amount, totalDeposited);
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Spends any idle balance sitting here first (left by an emergency unwind or an
    ///      over-delivering source) before touching the yield source. Principal is reduced
    ///      by what actually left, capped at `totalDeposited` — the excess over principal
    ///      is unrealised yield exiting early, which leaves NAV unchanged but must not
    ///      underflow the principal counter.
    function withdraw(uint256 amount) external override onlyRouter nonReentrant returns (uint256) {
        if (amount == 0) return 0;

        uint256 idle = _asset.balanceOf(address(this));
        if (amount > idle) _freeFunds(amount - idle);

        uint256 available = _asset.balanceOf(address(this));
        uint256 freed = available < amount ? available : amount;
        if (freed == 0) return 0;

        uint256 principalReduction = freed > totalDeposited ? totalDeposited : freed;
        totalDeposited -= principalReduction;

        _asset.safeTransfer(msg.sender, freed);

        emit Withdrawn(amount, freed, totalDeposited);
        return freed;
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Yield only, measured against `totalDeposited`. Returns 0 rather than reverting
    ///      when nothing accrued, so a keeper sweeping N strategies is never blocked by the
    ///      one that has not ticked yet.
    function harvest() external override onlyRouter nonReentrant returns (uint256) {
        uint256 assets = _harvestBasis();
        if (assets <= totalDeposited) {
            lastHarvestTime = block.timestamp;
            return 0;
        }

        uint256 pending = assets - totalDeposited;

        uint256 idle = _asset.balanceOf(address(this));
        if (pending > idle) _realiseYield(pending - idle);

        uint256 realised = _asset.balanceOf(address(this));
        if (realised > pending) realised = pending;
        if (realised == 0) {
            lastHarvestTime = block.timestamp;
            return 0;
        }

        totalHarvested += realised;
        lastHarvestTime = block.timestamp;

        _asset.safeTransfer(msg.sender, realised);

        emit Harvested(realised, block.timestamp);
        return realised;
    }

    /*//////////////////////////////////////////////////////////////
                          IStrategyAdapter — VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyAdapter
    function totalAssets() public view override returns (uint256) {
        return _sourceAssets() + _asset.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function underlyingToken() external view override returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IStrategyAdapter
    function availableLiquidity() external view override returns (uint256) {
        return _sourceLiquidity() + _asset.balanceOf(address(this));
    }

    /// @notice Unrealised yield sitting in the source, harvestable right now.
    function pendingYield() external view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > totalDeposited ? assets - totalDeposited : 0;
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        emit RouterUpdated(router, newRouter);
        router = newRouter;
    }

    /// @notice Stop new deposits and pull everything back out of the yield source.
    /// @dev    Funds land on this contract in plain asset form, still fully visible to
    ///         `totalAssets()` and still withdrawable by the router — so an emergency exit
    ///         does not change NAV or block user withdrawals, it only stops earning.
    function setEmergencyExit(bool active) external onlyOwner {
        emergencyExit = active;
        emit EmergencyExitSet(active);

        if (active) {
            uint256 held = _sourceAssets();
            if (held > 0) {
                uint256 freed = _freeFunds(held);
                emit EmergencyUnwound(freed);
            }
        }
    }

    /// @notice Rescue a non-asset token sent here by mistake.
    function sweep(address token) external onlyOwner {
        if (token == address(_asset)) revert CannotSweepAsset();
        IERC20(token).safeTransfer(owner(), IERC20(token).balanceOf(address(this)));
    }

    /*//////////////////////////////////////////////////////////////
                          HOOKS FOR CONCRETE ADAPTERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Move `amount` of freshly received asset into the yield source.
    function _deployFunds(uint256 amount) internal virtual;

    /// @dev Bring up to `amount` back to this contract in asset form; return the actual.
    function _freeFunds(uint256 amount) internal virtual returns (uint256);

    /// @dev Value held inside the yield source, principal plus unrealised yield.
    function _sourceAssets() internal view virtual returns (uint256);

    /// @dev Portion of `_sourceAssets()` that could be freed in this block.
    function _sourceLiquidity() internal view virtual returns (uint256);

    /// @dev Convert up to `pending` of unrealised yield into asset balance on this
    ///      contract. Defaults to a plain withdrawal; sources with a distinct claim
    ///      mechanism (a credit pool's interest ledger, an LP fee accrual) override it.
    function _realiseYield(uint256 pending) internal virtual returns (uint256) {
        return _freeFunds(pending);
    }

    /// @dev The figure `harvest()` measures yield against. Defaults to the full mark, which is
    ///      right for a source whose mark is what it would pay out.
    ///
    ///      A source whose mark can legitimately exceed what it could realise must override this
    ///      and report the realisable figure instead, because the difference is not income. An
    ///      AMM position is the case in point: entering moves the pool's price, and marking the
    ///      position at that post-entry price shows an instant paper gain. Measured against the
    ///      full mark, a harvest one block after a deposit booked 2.63 USDT of "yield" on a 500
    ///      USDT deposit and paid a performance fee on it — a fee on price impact, taken from
    ///      capital, dressed as a return.
    function _harvestBasis() internal view virtual returns (uint256) {
        return totalAssets();
    }
}
