// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockTBillVault
/// @notice Stand-in for a tokenized treasury bill product (Ondo-shaped ERC-4626).
/// @dev    Accrues linear interest against elapsed time and mints the difference on demand,
///         so share price rises exactly as a real T-bill vault's would. This is what makes
///         `TBillStrategy`'s trailing APY sampler testable: advance the chain, and the
///         source's share price genuinely moves.
///
///         Testnet only. The `_mint` of interest is what a real issuer replaces with an
///         actual coupon payment.
contract MockTBillVault is ERC4626, Ownable {
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;

    /// @notice Advertised annual rate, in basis points.
    uint256 public apyBps;

    /// @notice Last time interest was folded into the vault's asset balance.
    uint256 public lastAccrual;

    event InterestAccrued(uint256 amount, uint256 timestamp);
    event APYUpdated(uint256 oldApy, uint256 newApy);

    constructor(IERC20 asset_, uint256 apyBps_, address initialOwner)
        ERC4626(asset_)
        ERC20("Mock T-Bill Vault", "mTBILLv")
        Ownable(initialOwner)
    {
        apyBps = apyBps_;
        lastAccrual = block.timestamp;
    }

    /// @notice Principal plus interest accrued but not yet minted.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + pendingInterest();
    }

    /// @notice Interest owed since `lastAccrual`, computed linearly.
    function pendingInterest() public view returns (uint256) {
        uint256 principal = IERC20(asset()).balanceOf(address(this));
        if (principal == 0 || apyBps == 0) return 0;

        uint256 elapsed = block.timestamp - lastAccrual;
        return (principal * apyBps * elapsed) / (BPS * YEAR);
    }

    /// @notice Fold pending interest into the real balance by minting it.
    /// @dev    Called before every state-changing entrypoint so the accounting the strategy
    ///         reads is always settled, never a projection.
    function accrue() public {
        uint256 interest = pendingInterest();
        lastAccrual = block.timestamp;

        if (interest > 0) {
            MintableAsset(asset()).mint(address(this), interest);
            emit InterestAccrued(interest, block.timestamp);
        }
    }

    function setAPY(uint256 newApyBps) external onlyOwner {
        accrue();
        emit APYUpdated(apyBps, newApyBps);
        apyBps = newApyBps;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        accrue();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        accrue();
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}

interface MintableAsset {
    function mint(address to, uint256 amount) external;
}
