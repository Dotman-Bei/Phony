// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRwaLiquidityPool} from "../interfaces/IYieldSources.sol";

/// @title MockLiquidityPool
/// @notice Stand-in for the single-sided RWA liquidity zap.
/// @dev    Models the one property that matters to the adapter and is absent from the other
///         two sources: **LP value can fall**. `setLpValueBps` moves the position's mark, so
///         the test suite can prove `LiquidityStrategy` reports a drawdown as zero yield
///         instead of paying principal out as profit.
///
///         Trading fees accrue to a separate ledger, mirroring how LP fees are claimed
///         rather than compounded into the position. Testnet only.
contract MockLiquidityPool is IRwaLiquidityPool, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    address public immutable override asset;

    /// @notice The RWA/stable pair this pool stands in for.
    address public override pair;

    /// @notice Trailing fee APY, in basis points.
    uint256 public feeApyBps;

    /// @notice Mark on the LP position: 10000 = par, 9500 = a 5% drawdown.
    uint256 public lpValueBps = BPS;

    mapping(address => uint256) public override lpBalanceOf;
    mapping(address => uint256) public settledFees;
    mapping(address => uint256) public lastAccrualOf;

    uint256 public totalLpSupply;

    event LiquidityAdded(address indexed account, uint256 amount, uint256 lpMinted);
    event LiquidityRemoved(address indexed account, uint256 lpBurned, uint256 amountOut);
    event FeesClaimed(address indexed account, uint256 amount);
    event LpValueUpdated(uint256 oldBps, uint256 newBps);
    event FeeAPYUpdated(uint256 oldBps, uint256 newBps);

    error InsufficientLp(uint256 requested, uint256 held);

    constructor(address asset_, address pair_, uint256 feeApyBps_, address initialOwner) Ownable(initialOwner) {
        asset = asset_;
        pair = pair_;
        feeApyBps = feeApyBps_;
    }

    /// @dev LP is minted 1:1 against value at the current mark, so `valueOf` is a clean
    ///      multiply and a drawdown shows up on every holder at once.
    function addLiquidity(uint256 amount) external override returns (uint256 lpMinted) {
        _settle(msg.sender);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        lpMinted = lpValueBps == 0 ? 0 : (amount * BPS) / lpValueBps;
        lpBalanceOf[msg.sender] += lpMinted;
        totalLpSupply += lpMinted;

        emit LiquidityAdded(msg.sender, amount, lpMinted);
    }

    function removeLiquidity(uint256 lpAmount) external override returns (uint256 amountOut) {
        _settle(msg.sender);

        uint256 held = lpBalanceOf[msg.sender];
        if (lpAmount > held) revert InsufficientLp(lpAmount, held);

        amountOut = valueOf(lpAmount);
        lpBalanceOf[msg.sender] = held - lpAmount;
        totalLpSupply -= lpAmount;

        IERC20(asset).safeTransfer(msg.sender, amountOut);

        emit LiquidityRemoved(msg.sender, lpAmount, amountOut);
    }

    function claimFees() external override returns (uint256) {
        _settle(msg.sender);

        uint256 owed = settledFees[msg.sender];
        if (owed == 0) return 0;

        settledFees[msg.sender] = 0;

        // A real pool pays this from swap fees already sitting in reserves; the mock mints.
        MintableAsset(asset).mint(msg.sender, owed);

        emit FeesClaimed(msg.sender, owed);
        return owed;
    }

    function valueOf(uint256 lpAmount) public view override returns (uint256) {
        return (lpAmount * lpValueBps) / BPS;
    }

    function pendingFees(address account) public view override returns (uint256) {
        return settledFees[account] + _pendingSince(account);
    }

    function feeAPY() external view override returns (uint256) {
        return feeApyBps;
    }

    /// @notice Move the LP mark — the impermanent-loss / gain lever for tests.
    function setLpValueBps(uint256 bps) external onlyOwner {
        emit LpValueUpdated(lpValueBps, bps);
        lpValueBps = bps;
    }

    function setFeeAPY(uint256 bps) external onlyOwner {
        emit FeeAPYUpdated(feeApyBps, bps);
        feeApyBps = bps;
    }

    function setPair(address pair_) external onlyOwner {
        pair = pair_;
    }

    function _settle(address account) internal {
        settledFees[account] += _pendingSince(account);
        lastAccrualOf[account] = block.timestamp;
    }

    function _pendingSince(address account) internal view returns (uint256) {
        uint256 position = valueOf(lpBalanceOf[account]);
        uint256 last = lastAccrualOf[account];
        if (position == 0 || last == 0 || feeApyBps == 0) return 0;

        uint256 elapsed = block.timestamp - last;
        return (position * feeApyBps * elapsed) / (BPS * YEAR);
    }
}

interface MintableAsset {
    function mint(address to, uint256 amount) external;
}
