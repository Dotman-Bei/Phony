// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @title TBillStrategy — tokenized treasury bill yield
/// @notice The base-rate leg of the vault. Deposits into an ERC-4626 tokenized T-bill
///         product (Ondo-shaped) and lets the share price accrue.
///
/// @dev    Because the yield source is itself ERC-4626, this adapter is thin: value is
///         `convertToAssets(balanceOf(this))` and yield is that value minus principal.
///         No claim step, no reward token, no lockup — which is why this leg is the vault's
///         liquidity anchor and carries the largest allocation.
///
///         APY is derived rather than asked for: ERC-4626 has no APY method, so the
///         adapter samples share price over time. `estimatedAPY()` is therefore trailing
///         and honest — it reports what the source actually paid since the last checkpoint,
///         not a rate the source advertises.
contract TBillStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    /// @dev Below this the sample is noise: one block of accrual would annualise absurdly.
    uint256 private constant MIN_APY_WINDOW = 1 hours;

    /// @notice The tokenized T-bill vault this strategy holds.
    IERC4626 public immutable yieldSource;

    /// @notice APY sampling checkpoint: share price and the time it was taken.
    uint256 public lastSampleSharePrice;
    uint256 public lastSampleTime;
    uint256 public lastSampledAPY;

    /// @notice Fallback APY used before the first sampling window closes, in bps.
    uint256 public fallbackAPY;

    event APYSampled(uint256 apyBps, uint256 sharePrice, uint256 timestamp);
    event FallbackAPYUpdated(uint256 oldApy, uint256 newApy);

    error YieldSourceAssetMismatch(address sourceAsset, address expected);

    constructor(address asset_, address router_, address yieldSource_, uint256 fallbackAPY_, address initialOwner)
        BaseStrategy(asset_, router_, initialOwner)
    {
        if (yieldSource_ == address(0)) revert ZeroAddress();

        IERC4626 source = IERC4626(yieldSource_);
        if (source.asset() != asset_) revert YieldSourceAssetMismatch(source.asset(), asset_);

        yieldSource = source;
        fallbackAPY = fallbackAPY_;
        lastSampleSharePrice = source.convertToAssets(10 ** source.decimals());
        lastSampleTime = block.timestamp;
        lastSampledAPY = fallbackAPY_;
    }

    /// @inheritdoc IStrategyAdapter
    function name() external pure override returns (string memory) {
        return "T-Bill Strategy";
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    function _deployFunds(uint256 amount) internal override {
        _asset.forceApprove(address(yieldSource), amount);
        yieldSource.deposit(amount, address(this));
        _asset.forceApprove(address(yieldSource), 0);

        _sampleAPY();
    }

    /// @dev Withdrawing more than the source holds would revert, so the request is clamped
    ///      to our position first. Partial fills are a normal outcome, not an error.
    function _freeFunds(uint256 amount) internal override returns (uint256) {
        uint256 held = yieldSource.maxWithdraw(address(this));
        if (held == 0) return 0;

        uint256 target = amount > held ? held : amount;
        if (target == 0) return 0;

        uint256 before = _asset.balanceOf(address(this));
        yieldSource.withdraw(target, address(this), address(this));
        uint256 freed = _asset.balanceOf(address(this)) - before;

        _sampleAPY();
        return freed;
    }

    function _sourceAssets() internal view override returns (uint256) {
        return yieldSource.convertToAssets(yieldSource.balanceOf(address(this)));
    }

    function _sourceLiquidity() internal view override returns (uint256) {
        return yieldSource.maxWithdraw(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                                  APY
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyAdapter
    /// @dev Trailing, sampled from the source's own share price. Falls back to the
    ///      configured rate until the first full sampling window has elapsed.
    function estimatedAPY() external view override returns (uint256) {
        uint256 elapsed = block.timestamp - lastSampleTime;
        if (elapsed < MIN_APY_WINDOW) return lastSampledAPY;

        uint256 current = _currentSourceSharePrice();
        if (current <= lastSampleSharePrice || lastSampleSharePrice == 0) return lastSampledAPY;

        uint256 growth = current - lastSampleSharePrice;
        return (growth * BPS * YEAR) / (lastSampleSharePrice * elapsed);
    }

    /// @notice Force an APY checkpoint. Deposits and withdrawals do this automatically;
    ///         this exists so a keeper can keep the number fresh on a quiet vault.
    function sampleAPY() external {
        _sampleAPY();
    }

    function setFallbackAPY(uint256 apyBps) external onlyOwner {
        emit FallbackAPYUpdated(fallbackAPY, apyBps);
        fallbackAPY = apyBps;
    }

    function _sampleAPY() internal {
        uint256 elapsed = block.timestamp - lastSampleTime;
        if (elapsed < MIN_APY_WINDOW) return;

        uint256 current = _currentSourceSharePrice();
        if (current > lastSampleSharePrice && lastSampleSharePrice > 0) {
            uint256 growth = current - lastSampleSharePrice;
            lastSampledAPY = (growth * BPS * YEAR) / (lastSampleSharePrice * elapsed);
        }

        lastSampleSharePrice = current;
        lastSampleTime = block.timestamp;

        emit APYSampled(lastSampledAPY, current, block.timestamp);
    }

    function _currentSourceSharePrice() internal view returns (uint256) {
        return yieldSource.convertToAssets(10 ** yieldSource.decimals());
    }
}
