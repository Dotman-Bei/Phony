// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {ICreditPool} from "../interfaces/IYieldSources.sol";

/// @title CreditStrategy — private credit yield
/// @notice The high-yield leg. Lends into a private credit pool (Maple / Centrifuge
///         shaped) where capital is out on loan and interest is distributed periodically.
///
/// @dev    Two things make this adapter structurally different from the T-bill leg, and
///         both are why `IStrategyAdapter` has the shape it does:
///
///         1. **Interest is claimed, not accrued into a share price.** Yield sits in the
///            pool's interest ledger until `claimInterest()` is called, so `_realiseYield`
///            is overridden to claim rather than to withdraw principal.
///
///         2. **Liquidity is partial by nature.** Deployed capital is locked in loans until
///            borrowers repay, so `_sourceLiquidity()` reports only the recallable slice.
///            This is precisely what `BotVault.maxWithdraw` reads, so the UI can tell a
///            depositor the truth about an exit instead of reverting at signing time.
contract CreditStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice The credit pool this strategy lends into.
    ICreditPool public immutable creditPool;

    error CreditPoolAssetMismatch(address poolAsset, address expected);

    constructor(address asset_, address router_, address creditPool_, address initialOwner)
        BaseStrategy(asset_, router_, initialOwner)
    {
        if (creditPool_ == address(0)) revert ZeroAddress();

        ICreditPool pool = ICreditPool(creditPool_);
        if (pool.asset() != asset_) revert CreditPoolAssetMismatch(pool.asset(), asset_);

        creditPool = pool;
    }

    /// @inheritdoc IStrategyAdapter
    function name() external pure override returns (string memory) {
        return "Private Credit Strategy";
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Read straight from the pool — private credit quotes a contractual coupon, so
    ///      unlike the T-bill leg there is nothing to derive.
    function estimatedAPY() external view override returns (uint256) {
        return creditPool.currentAPY();
    }

    /// @notice Interest distributed to this strategy and not yet claimed.
    function claimableInterest() external view returns (uint256) {
        return creditPool.accruedInterest(address(this));
    }

    /// @notice Principal locked in outstanding loans and not recallable this block.
    function lockedPrincipal() external view returns (uint256) {
        uint256 principal = creditPool.principalOf(address(this));
        uint256 liquid = creditPool.liquidityOf(address(this));
        return principal > liquid ? principal - liquid : 0;
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    function _deployFunds(uint256 amount) internal override {
        _asset.forceApprove(address(creditPool), amount);
        creditPool.deposit(amount);
        _asset.forceApprove(address(creditPool), 0);
    }

    /// @dev Clamped to what the pool can actually release. A request past the recallable
    ///      slice returns a partial fill; the router absorbs it and tries the next strategy.
    function _freeFunds(uint256 amount) internal override returns (uint256) {
        uint256 before = _asset.balanceOf(address(this));

        uint256 liquid = creditPool.liquidityOf(address(this));
        uint256 target = amount > liquid ? liquid : amount;
        if (target > 0) creditPool.withdraw(target);

        uint256 freed = _asset.balanceOf(address(this)) - before;

        // Recallable principal alone did not cover it. Settle the interest ledger too —
        // it is already earmarked for this strategy and `availableLiquidity()` counts it,
        // so leaving it behind would make that view a promise the adapter cannot keep.
        if (freed < amount && creditPool.accruedInterest(address(this)) > 0) {
            creditPool.claimInterest();
            freed = _asset.balanceOf(address(this)) - before;
        }

        return freed;
    }

    /// @dev Yield lives in the pool's interest ledger, so claim it rather than unwinding
    ///      principal. `pending` is ignored: `claimInterest()` settles the whole ledger,
    ///      and `BaseStrategy.harvest` caps the transfer at real accrued yield anyway.
    function _realiseYield(uint256) internal override returns (uint256) {
        return creditPool.claimInterest();
    }

    function _sourceAssets() internal view override returns (uint256) {
        return creditPool.principalOf(address(this)) + creditPool.accruedInterest(address(this));
    }

    /// @dev Claimable interest counts as liquid: it is already earmarked for this strategy
    ///      and can be pulled out in the same block as a withdrawal.
    function _sourceLiquidity() internal view override returns (uint256) {
        return creditPool.liquidityOf(address(this)) + creditPool.accruedInterest(address(this));
    }
}
