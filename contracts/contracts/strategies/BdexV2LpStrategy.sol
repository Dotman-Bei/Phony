// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IBdexV2Factory, IBdexV2Pair, IBdexV2Router02} from "../interfaces/IBdexV2.sol";

/// @title BdexV2LpStrategy — real market making on BDEX V2
/// @notice Deploys the vault's asset into a live BDEX V2 pair and earns the pair's actual
///         trading fees. No simulated coupon, no owner-set rate: the yield is whatever the
///         pool's swappers paid, arriving as growth in the reserves behind our LP tokens.
///
/// @dev    Single-sided entry. The vault holds one asset, a V2 pair needs two, so the adapter
///         swaps half the incoming amount for the paired token and adds both sides. Exit
///         reverses it. That round trip costs the 0.3% swap fee on half the position plus
///         price impact, which is precisely why the two value hooks are deliberately
///         different:
///
///           `_sourceAssets`    marks the position at the pool's spot ratio — the honest
///                              mark-to-market NAV, and the number that legitimately falls
///                              when the paired token drops (impermanent loss is real here).
///           `_sourceLiquidity` prices the exit the way the exit will actually execute:
///                              constant-product output for the paired half against the
///                              reserves left after the burn, fee included.
///
///         So `totalAssets()` reports what the position is worth and `availableLiquidity()`
///         reports what it can be turned into this block. The vault's `maxWithdraw` is built
///         on the second, which is how it quotes exits the chain will honour.
///
///         Swap arithmetic is done here rather than through the router's `getAmountsOut`
///         because these are views the vault calls on every read: an external call that can
///         revert on an empty pool would take `totalAssets()` down with it. BDEX V2's fee was
///         verified wei-exact against the canonical 997/1000 formula before this was written.
contract BdexV2LpStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    /// @notice BDEX V2 Router02.
    IBdexV2Router02 public immutable dexRouter;

    /// @notice The live pair this strategy provides liquidity to.
    IBdexV2Pair public immutable pair;

    /// @notice The other side of the pair — what half the asset is swapped into.
    IERC20 public immutable pairedToken;

    /// @notice True when the vault asset is `token0` of the pair.
    bool public immutable assetIsToken0;

    /// @notice Max acceptable slippage on entering or exiting, in bps.
    uint256 public maxSlippageBps;

    /// @notice When the first deposit landed, so realised APY has a denominator.
    uint256 public firstDepositTime;

    string private _name;

    /// @dev Router02 refunds unused input, so a 1% ceiling is about price impact, not dust.
    uint256 private constant MAX_SLIPPAGE_CEILING = 1_000;

    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);

    error PairDoesNotHoldAsset(address token0, address token1, address asset);
    error PairNotRegistered(address pair, address expected);
    error SlippageTooHigh(uint256 requested, uint256 max);
    error SlippageExceeded(uint256 received, uint256 minExpected);
    error PoolEmpty();

    constructor(
        address asset_,
        address router_,
        address dexRouter_,
        address pair_,
        uint256 maxSlippageBps_,
        string memory name_,
        address initialOwner
    ) BaseStrategy(asset_, router_, initialOwner) {
        if (dexRouter_ == address(0) || pair_ == address(0)) revert ZeroAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING) {
            revert SlippageTooHigh(maxSlippageBps_, MAX_SLIPPAGE_CEILING);
        }

        IBdexV2Pair p = IBdexV2Pair(pair_);
        address t0 = p.token0();
        address t1 = p.token1();

        if (t0 != asset_ && t1 != asset_) revert PairDoesNotHoldAsset(t0, t1, asset_);

        bool isToken0 = t0 == asset_;
        address paired = isToken0 ? t1 : t0;

        // The pair must be the one this factory actually registered for these two tokens.
        // Without this check the adapter would happily provide liquidity to a look-alike
        // pair deployed by anyone, whose reserves an attacker controls — and every value
        // this contract reports is derived from those reserves.
        address registered = IBdexV2Factory(IBdexV2Router02(dexRouter_).factory()).getPair(asset_, paired);
        if (registered != pair_) revert PairNotRegistered(pair_, registered);

        dexRouter = IBdexV2Router02(dexRouter_);
        pair = p;
        pairedToken = IERC20(paired);
        assetIsToken0 = isToken0;
        maxSlippageBps = maxSlippageBps_;
        _name = name_;
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IStrategyAdapter
    function name() external view override returns (string memory) {
        return _name;
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Realised, not advertised. Annualises the fees this position has actually earned
    ///      over the time it has been open, so a fresh strategy reports 0 rather than a
    ///      marketing number. Uses current principal as the denominator, which slightly
    ///      understates APY for a position that grew over the window.
    function estimatedAPY() external view override returns (uint256) {
        if (firstDepositTime == 0 || totalDeposited == 0) return 0;

        uint256 elapsed = block.timestamp - firstDepositTime;
        // Annualising a few minutes of fees produces a meaningless number; say nothing until
        // there is a day of history behind it.
        if (elapsed < 1 days) return 0;

        uint256 assets = totalAssets();
        uint256 unrealised = assets > totalDeposited ? assets - totalDeposited : 0;
        uint256 gains = totalHarvested + unrealised;
        if (gains == 0) return 0;

        return (gains * 365 days * 10_000) / (totalDeposited * elapsed);
    }

    /// @notice LP tokens held by this strategy.
    function lpBalance() external view returns (uint256) {
        return pair.balanceOf(address(this));
    }

    /// @notice Live reserves, ordered as (asset, paired).
    function reserves() external view returns (uint256 reserveAsset, uint256 reservePaired) {
        return _reserves();
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING) revert SlippageTooHigh(bps, MAX_SLIPPAGE_CEILING);
        emit MaxSlippageUpdated(maxSlippageBps, bps);
        maxSlippageBps = bps;
    }

    /*//////////////////////////////////////////////////////////////
                                 HOOKS
    //////////////////////////////////////////////////////////////*/

    /// @dev Swap half, add both sides, then verify by value rather than by LP quantity: a
    ///      manipulated pool can mint plenty of LP that is worth nothing.
    function _deployFunds(uint256 amount) internal override {
        (uint256 reserveAsset, uint256 reservePaired) = _reserves();
        if (reserveAsset == 0 || reservePaired == 0) revert PoolEmpty();

        if (firstDepositTime == 0) firstDepositTime = block.timestamp;

        // Balance held before this deposit arrived, so the slippage check below can tell our
        // own leftovers apart from asset that was already sitting here.
        uint256 preExistingAsset = _asset.balanceOf(address(this)) - amount;
        uint256 sourceBefore = _sourceAssets();

        uint256 swapIn = _optimalSwapIn(amount, reserveAsset);
        uint256 assetForLp = amount - swapIn;

        if (swapIn > 0) {
            uint256 quoted = _getAmountOut(swapIn, reserveAsset, reservePaired);
            _swapAssetForPaired(swapIn, _applySlippage(quoted));
        }

        uint256 pairedHeld = pairedToken.balanceOf(address(this));
        if (pairedHeld > 0) {
            _asset.forceApprove(address(dexRouter), assetForLp);
            pairedToken.forceApprove(address(dexRouter), pairedHeld);

            dexRouter.addLiquidity(
                address(_asset),
                address(pairedToken),
                assetForLp,
                pairedHeld,
                _applySlippage(assetForLp),
                _applySlippage(pairedHeld),
                address(this),
                block.timestamp
            );

            _asset.forceApprove(address(dexRouter), 0);
            pairedToken.forceApprove(address(dexRouter), 0);
        }

        uint256 gained = (_sourceAssets() - sourceBefore)
            + (_asset.balanceOf(address(this)) - preExistingAsset);
        uint256 minExpected = _applySlippage(amount);
        if (gained < minExpected) revert SlippageExceeded(gained, minExpected);
    }

    /// @dev Burn the share of LP matching the requested value, then convert the paired side
    ///      back to asset.
    ///
    ///      The burn is sized against *realisable* value, not the spot mark. Sizing it on the
    ///      spot mark is the intuitive choice and it under-delivers every time: the proceeds
    ///      arrive only after the paired half is sold, which pays the 0.3% fee and its own
    ///      price impact, so a spot-proportional burn always lands a little short of what the
    ///      router asked for — and the vault, correctly, rejects a withdrawal it cannot fill.
    ///      Dividing by the exit value instead burns marginally more LP and covers the round
    ///      trip. It errs generous: this quote assumes selling the whole paired side at once,
    ///      while a partial exit sells less and therefore suffers less impact, so any excess
    ///      lands as idle asset that the next withdrawal spends first.
    function _freeFunds(uint256 amount) internal override returns (uint256) {
        uint256 assetBefore = _asset.balanceOf(address(this));

        uint256 lpHeld = pair.balanceOf(address(this));
        uint256 valueHeld = _sourceLiquidity();

        if (lpHeld > 0 && valueHeld > 0) {
            uint256 lpToBurn;
            if (amount >= valueHeld) {
                lpToBurn = lpHeld;
            } else {
                lpToBurn = (amount * lpHeld + valueHeld - 1) / valueHeld;
                if (lpToBurn > lpHeld) lpToBurn = lpHeld;
            }

            if (lpToBurn > 0) {
                (uint256 expectedAsset, uint256 expectedPaired) = _sharesOf(lpToBurn);

                pair.approve(address(dexRouter), lpToBurn);
                dexRouter.removeLiquidity(
                    address(_asset),
                    address(pairedToken),
                    lpToBurn,
                    _applySlippage(expectedAsset),
                    _applySlippage(expectedPaired),
                    address(this),
                    block.timestamp
                );
                pair.approve(address(dexRouter), 0);
            }
        }

        // Everything paired now becomes asset — including dust left by an earlier partial
        // exit, which is why this is not gated on the burn above happening.
        uint256 pairedHeld = pairedToken.balanceOf(address(this));
        if (pairedHeld > 0) {
            (uint256 reserveAsset, uint256 reservePaired) = _reserves();
            if (reservePaired > 0 && reserveAsset > 0) {
                uint256 quoted = _getAmountOut(pairedHeld, reservePaired, reserveAsset);
                if (quoted > 0) _swapPairedForAsset(pairedHeld, _applySlippage(quoted));
            }
        }

        return _asset.balanceOf(address(this)) - assetBefore;
    }

    /// @dev Mark to the pool's spot ratio. Our share of the paired reserve is valued at the
    ///      same ratio the pool prices it at, which for a V2 pair reduces to twice our share
    ///      of the asset reserve; it is written out longhand because the paired dust below
    ///      needs the same conversion and the equivalence is worth being able to see.
    function _sourceAssets() internal view override returns (uint256) {
        (uint256 reserveAsset, uint256 reservePaired) = _reserves();
        if (reservePaired == 0) return 0;

        uint256 value;
        uint256 lpHeld = pair.balanceOf(address(this));
        if (lpHeld > 0) {
            (uint256 assetShare, uint256 pairedShare) = _sharesOf(lpHeld);
            value = assetShare + (pairedShare * reserveAsset) / reservePaired;
        }

        uint256 pairedDust = pairedToken.balanceOf(address(this));
        if (pairedDust > 0) value += (pairedDust * reserveAsset) / reservePaired;

        return value;
    }

    /// @dev What the position would actually yield if unwound right now: our asset share
    ///      comes out untouched, and the paired share is sold into the reserves that remain
    ///      after the burn, paying the 0.3% fee and its own price impact.
    function _sourceLiquidity() internal view override returns (uint256) {
        (uint256 reserveAsset, uint256 reservePaired) = _reserves();
        if (reserveAsset == 0 || reservePaired == 0) return 0;

        uint256 lpHeld = pair.balanceOf(address(this));
        uint256 assetOut;
        uint256 pairedToSell = pairedToken.balanceOf(address(this));

        if (lpHeld > 0) {
            (uint256 assetShare, uint256 pairedShare) = _sharesOf(lpHeld);
            assetOut = assetShare;
            pairedToSell += pairedShare;

            // Post-burn reserves: our own liquidity is no longer backing the price.
            reserveAsset -= assetShare;
            reservePaired -= pairedShare;
        }

        if (pairedToSell > 0 && reserveAsset > 0 && reservePaired > 0) {
            assetOut += _getAmountOut(pairedToSell, reservePaired, reserveAsset);
        }

        return assetOut;
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _reserves() internal view returns (uint256 reserveAsset, uint256 reservePaired) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return assetIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Our claim on both reserves for a given quantity of LP.
    function _sharesOf(uint256 lpAmount) internal view returns (uint256 assetShare, uint256 pairedShare) {
        uint256 supply = pair.totalSupply();
        if (supply == 0) return (0, 0);

        (uint256 reserveAsset, uint256 reservePaired) = _reserves();
        assetShare = (reserveAsset * lpAmount) / supply;
        pairedShare = (reservePaired * lpAmount) / supply;
    }

    /// @dev How much of a one-sided deposit to swap so the two halves end up matching the
    ///      pool's ratio *after* the swap rather than before it.
    ///
    ///      Swapping exactly half is the obvious answer and it is wrong: the swap moves the
    ///      price, so the paired tokens bought are worth more than the asset left behind, and
    ///      `addLiquidity` reverts with INSUFFICIENT_B_AMOUNT once the mismatch exceeds the
    ///      slippage tolerance. In a pool holding ~6.5k USDT, a 600 USDT entry shifts the
    ///      ratio by around 7% — nowhere near a 1% tolerance.
    ///
    ///      The closed form for a 0.3%-fee constant-product pool:
    ///
    ///          swapIn = (sqrt(r * (r * 3988009 + a * 3988000)) - r * 1997) / 1994
    ///
    ///      where `r` is the reserve of the token being supplied and `a` the amount supplied.
    ///      What is left over after `addLiquidity` is dust, and Router02 refunds it.
    function _optimalSwapIn(uint256 amount, uint256 reserveIn) internal pure returns (uint256) {
        if (amount == 0 || reserveIn == 0) return 0;

        uint256 inner = reserveIn * (reserveIn * 3_988_009 + amount * 3_988_000);
        uint256 swapIn = (Math.sqrt(inner) - reserveIn * 1_997) / 1_994;

        // Degenerate pools (amount large relative to reserves) can push the closed form past
        // the deposit itself; never swap more than was supplied.
        return swapIn > amount ? amount : swapIn;
    }

    /// @dev Canonical Uniswap V2 output, 0.3% fee. Verified wei-exact against BDEX V2's
    ///      Router02 on live reserves; see IBdexV2.sol.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;

        uint256 amountInWithFee = amountIn * 997;
        return (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    function _applySlippage(uint256 amount) internal view returns (uint256) {
        return (amount * (10_000 - maxSlippageBps)) / 10_000;
    }

    function _swapAssetForPaired(uint256 amountIn, uint256 minOut) private {
        address[] memory path = new address[](2);
        path[0] = address(_asset);
        path[1] = address(pairedToken);

        _asset.forceApprove(address(dexRouter), amountIn);
        dexRouter.swapExactTokensForTokens(amountIn, minOut, path, address(this), block.timestamp);
        _asset.forceApprove(address(dexRouter), 0);
    }

    function _swapPairedForAsset(uint256 amountIn, uint256 minOut) private {
        address[] memory path = new address[](2);
        path[0] = address(pairedToken);
        path[1] = address(_asset);

        pairedToken.forceApprove(address(dexRouter), amountIn);
        dexRouter.swapExactTokensForTokens(amountIn, minOut, path, address(this), block.timestamp);
        pairedToken.forceApprove(address(dexRouter), 0);
    }
}
