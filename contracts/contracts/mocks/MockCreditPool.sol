// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ICreditPool} from "../interfaces/IYieldSources.sol";

/// @title MockCreditPool
/// @notice Stand-in for a private credit pool (Maple / Centrifuge shaped).
/// @dev    Reproduces the two behaviours that make private credit structurally different
///         from a T-bill vault, because `CreditStrategy` is written against exactly those:
///
///         1. Interest accrues to a separate ledger and must be claimed.
///         2. Only `utilisationBps`-complement of principal is recallable — the rest is out
///            on loan. Set utilisation to 8000 and 20% of the strategy's principal can be
///            withdrawn this block, which is what drives `BotVault.maxWithdraw`.
///
///         Testnet only.
contract MockCreditPool is ICreditPool, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    address public immutable override asset;

    /// @notice Contractual coupon, in basis points.
    uint256 public apyBps;

    /// @notice Share of principal currently lent out and therefore illiquid, in bps.
    uint256 public utilisationBps;

    mapping(address => uint256) public override principalOf;
    mapping(address => uint256) public claimedInterest;
    mapping(address => uint256) public lastAccrualOf;
    mapping(address => uint256) public settledInterest;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event InterestClaimed(address indexed account, uint256 amount);
    event APYUpdated(uint256 oldApy, uint256 newApy);
    event UtilisationUpdated(uint256 oldBps, uint256 newBps);

    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InvalidUtilisation(uint256 bps);

    constructor(address asset_, uint256 apyBps_, uint256 utilisationBps_, address initialOwner) Ownable(initialOwner) {
        if (utilisationBps_ > BPS) revert InvalidUtilisation(utilisationBps_);
        asset = asset_;
        apyBps = apyBps_;
        utilisationBps = utilisationBps_;
    }

    function deposit(uint256 amount) external override {
        _settle(msg.sender);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        principalOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external override returns (uint256) {
        _settle(msg.sender);

        uint256 available = liquidityOf(msg.sender);
        if (amount > available) revert InsufficientLiquidity(amount, available);

        principalOf[msg.sender] -= amount;
        IERC20(asset).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
        return amount;
    }

    function claimInterest() external override returns (uint256) {
        _settle(msg.sender);

        uint256 owed = settledInterest[msg.sender];
        if (owed == 0) return 0;

        settledInterest[msg.sender] = 0;
        claimedInterest[msg.sender] += owed;

        // A real pool pays this out of borrower repayments; the mock mints it.
        MintableAsset(asset).mint(msg.sender, owed);

        emit InterestClaimed(msg.sender, owed);
        return owed;
    }

    function accruedInterest(address account) public view override returns (uint256) {
        return settledInterest[account] + _pendingSince(account);
    }

    function liquidityOf(address account) public view override returns (uint256) {
        uint256 principal = principalOf[account];
        return (principal * (BPS - utilisationBps)) / BPS;
    }

    function currentAPY() external view override returns (uint256) {
        return apyBps;
    }

    function setAPY(uint256 newApyBps) external onlyOwner {
        emit APYUpdated(apyBps, newApyBps);
        apyBps = newApyBps;
    }

    /// @notice Simulate borrowers drawing down or repaying, changing exit liquidity.
    function setUtilisation(uint256 bps) external onlyOwner {
        if (bps > BPS) revert InvalidUtilisation(bps);
        emit UtilisationUpdated(utilisationBps, bps);
        utilisationBps = bps;
    }

    /// @dev Move time-based accrual into the settled ledger and reset the clock. Called
    ///      before every balance change so a deposit never retroactively earns interest.
    function _settle(address account) internal {
        settledInterest[account] += _pendingSince(account);
        lastAccrualOf[account] = block.timestamp;
    }

    function _pendingSince(address account) internal view returns (uint256) {
        uint256 principal = principalOf[account];
        uint256 last = lastAccrualOf[account];
        if (principal == 0 || last == 0 || apyBps == 0) return 0;

        uint256 elapsed = block.timestamp - last;
        return (principal * apyBps * elapsed) / (BPS * YEAR);
    }
}

interface MintableAsset {
    function mint(address to, uint256 amount) external;
}
