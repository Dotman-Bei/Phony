// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IRwaLiquidityPool} from "../interfaces/IYieldSources.sol";

/// @title LiquidityStrategy — RWA/stable market making
/// @notice The fee-earning leg. Provides single-sided liquidity to an RWA trading pair and
///         collects the trading fees.
///
/// @dev    `liquidityPool` is a zap boundary, not a raw Uniswap pair: a real deployment
///         points it at a contract that swaps half the input, mints LP, and reverses that
///         on exit. Keeping the swap path behind this interface means the DEX can change —
///         V2 pair today, concentrated-liquidity position tomorrow — without touching the
///         router's or the vault's accounting.
///
///         This is also the leg where `totalAssets()` can legitimately fall: LP value moves
///         with the pool, so the adapter reports `valueOf(lp)` live rather than echoing
///         `totalDeposited`. `BaseStrategy.harvest` only ever transfers the surplus over
///         principal, so a drawdown reports zero yield instead of paying out principal.
contract LiquidityStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice The zap/pool contract this strategy provides liquidity through.
    IRwaLiquidityPool public immutable liquidityPool;

    /// @notice Max acceptable slippage on entering or exiting the position, in bps.
    uint256 public maxSlippageBps;

    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);

    error LiquidityPoolAssetMismatch(address poolAsset, address expected);
    error SlippageTooHigh(uint256 requested, uint256 max);
    error SlippageExceeded(uint256 received, uint256 minExpected);

    constructor(address asset_, address router_, address liquidityPool_, uint256 maxSlippageBps_, address initialOwner)
        BaseStrategy(asset_, router_, initialOwner)
    {
        if (liquidityPool_ == address(0)) revert ZeroAddress();
        if (maxSlippageBps_ > 1_000) revert SlippageTooHigh(maxSlippageBps_, 1_000);

        IRwaLiquidityPool pool = IRwaLiquidityPool(liquidityPool_);
        if (pool.asset() != asset_) revert LiquidityPoolAssetMismatch(pool.asset(), asset_);

        liquidityPool = pool;
        maxSlippageBps = maxSlippageBps_;
    }

    /// @inheritdoc IStrategyAdapter
    function name() external pure override returns (string memory) {
        return "RWA Liquidity Strategy";
    }

    /// @inheritdoc IStrategyAdapter
    function estimatedAPY() external view override returns (uint256) {
        return liquidityPool.feeAPY();
    }

    /// @notice The RWA/stable pair being market-made.
    function pair() external view returns (address) {
        return liquidityPool.pair();
    }

    /// @notice LP tokens held by this strategy.
    function lpBalance() external view returns (uint256) {
        return liquidityPool.lpBalanceOf(address(this));
    }

    /// @notice Trading fees earned and not yet claimed.
    function pendingFees() external view returns (uint256) {
        return liquidityPool.pendingFees(address(this));
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        if (bps > 1_000) revert SlippageTooHigh(bps, 1_000);
        emit MaxSlippageUpdated(maxSlippageBps, bps);
        maxSlippageBps = bps;
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    /// @dev The slippage check is on the *value* of the LP received, which is the number
    ///      that lands in `totalAssets()`. Checking the LP quantity instead would let a
    ///      manipulated pool mint plenty of worthless LP and pass.
    function _deployFunds(uint256 amount) internal override {
        _asset.forceApprove(address(liquidityPool), amount);
        uint256 lpMinted = liquidityPool.addLiquidity(amount);
        _asset.forceApprove(address(liquidityPool), 0);

        uint256 valueIn = liquidityPool.valueOf(lpMinted);
        uint256 minExpected = (amount * (10_000 - maxSlippageBps)) / 10_000;
        if (valueIn < minExpected) revert SlippageExceeded(valueIn, minExpected);
    }

    /// @dev Burns the proportion of LP matching the requested value. Rounds the LP amount
    ///      up so a rounding-down burn cannot leave the caller a wei short of its target.
    function _freeFunds(uint256 amount) internal override returns (uint256) {
        uint256 lpHeld = liquidityPool.lpBalanceOf(address(this));
        if (lpHeld == 0) return 0;

        uint256 valueHeld = liquidityPool.valueOf(lpHeld);
        if (valueHeld == 0) return 0;

        uint256 lpToBurn;
        if (amount >= valueHeld) {
            lpToBurn = lpHeld;
        } else {
            lpToBurn = (amount * lpHeld + valueHeld - 1) / valueHeld;
            if (lpToBurn > lpHeld) lpToBurn = lpHeld;
        }
        if (lpToBurn == 0) return 0;

        uint256 expected = liquidityPool.valueOf(lpToBurn);

        uint256 before = _asset.balanceOf(address(this));
        liquidityPool.removeLiquidity(lpToBurn);
        uint256 freed = _asset.balanceOf(address(this)) - before;

        uint256 minExpected = (expected * (10_000 - maxSlippageBps)) / 10_000;
        if (freed < minExpected) revert SlippageExceeded(freed, minExpected);

        // Unwinding the whole position still fell short — settle the fee ledger, which
        // `availableLiquidity()` already counts as exitable.
        if (freed < amount && liquidityPool.pendingFees(address(this)) > 0) {
            liquidityPool.claimFees();
            freed = _asset.balanceOf(address(this)) - before;
        }

        return freed;
    }

    /// @dev Fees are a separate accrual from the LP position, so claim them rather than
    ///      burning LP — burning would shrink the principal that is earning the fees.
    function _realiseYield(uint256) internal override returns (uint256) {
        return liquidityPool.claimFees();
    }

    function _sourceAssets() internal view override returns (uint256) {
        return liquidityPool.valueOf(liquidityPool.lpBalanceOf(address(this)))
            + liquidityPool.pendingFees(address(this));
    }

    /// @dev AMM liquidity is fully exitable in-block, unlike the credit leg.
    function _sourceLiquidity() internal view override returns (uint256) {
        return _sourceAssets();
    }
}
