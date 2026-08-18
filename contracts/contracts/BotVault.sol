// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IStrategyRouter} from "./interfaces/IStrategyRouter.sol";
import {IBotVault} from "./interfaces/IBotVault.sol";

/// @title BotVault — Phony's ERC-4626 RWA restaking vault
/// @notice Accepts a tokenized real-world asset, mints `brRWA` shares against it, and
///         hands the capital to a StrategyRouter that spreads it across whitelisted RWA
///         yield strategies. Yield is auto-compounded: harvests land here as bare assets,
///         so `totalAssets()` rises while `totalSupply()` does not, and every existing
///         share silently gains value. Holders never claim anything.
///
/// @dev    Two deliberate deviations from a textbook ERC-4626:
///
///         1. **Idle buffer.** The router deploys only `totalAllocationBps` of each
///            deposit; the remainder stays here as a reserve so ordinary withdrawals cost
///            one transfer instead of unwinding three strategies. The buffer is implicit —
///            it is whatever the curator leaves unallocated (e.g. 500 bps → 5% reserve).
///
///         2. **Liquidity-aware maxima.** `maxWithdraw`/`maxRedeem` report what strategies
///            can actually return this block. RWA yield sources have notice periods, so
///            promising instant exit on the full balance would be a lie.
contract BotVault is ERC4626, Ownable, Pausable, ReentrancyGuard, IBotVault {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 public constant MAX_BPS = 10_000;
    /// @notice Hard ceiling on the performance fee. The curator cannot exceed 20%.
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 2_000;

    /// @notice Allocation engine this vault routes through. Zero address = idle-only mode,
    ///         which is the safe state the vault is born in and falls back to when paused.
    IStrategyRouter public strategyRouter;

    /// @notice Performance fee charged on harvested yield only — never on principal.
    uint256 public performanceFeeBps;

    /// @notice Recipient of the performance fee.
    address public feeRecipient;

    /// @notice Optional ceiling on `totalAssets()`. Zero means uncapped.
    uint256 public depositCap;

    /// @notice Running total of yield harvested over the vault's life, net of fees.
    uint256 public totalYieldHarvested;

    /// @notice Timestamp of the most recent harvest.
    uint256 public lastHarvestTime;

    event StrategyRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event Harvested(uint256 amount, uint256 fee, uint256 timestamp);
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event PerformanceFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);
    event FundsDeployed(uint256 amount);
    event FundsRecalled(uint256 amount);

    error ZeroAddress();
    error NotRouter();
    error FeeTooHigh(uint256 requested, uint256 max);
    error RouterAssetMismatch(address routerAsset, address vaultAsset);
    error RouterVaultMismatch(address routerVault, address self);
    error DepositCapExceeded(uint256 attempted, uint256 cap);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error CannotSweepAsset();

    modifier onlyRouter() {
        if (msg.sender != address(strategyRouter)) revert NotRouter();
        _;
    }

    /// @param asset_        The tokenized RWA this vault accepts (TBILL, PCREDIT, ...).
    /// @param name_         Share token name, e.g. "Phony RWA Vault".
    /// @param symbol_       Share token symbol, e.g. "brRWA".
    /// @param initialOwner  Curator address — whitelists strategies and sets fees.
    /// @param feeRecipient_ Treasury receiving the performance fee.
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address initialOwner,
        address feeRecipient_
    ) ERC4626(asset_) ERC20(name_, symbol_) Ownable(initialOwner) {
        if (address(asset_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        performanceFeeBps = 1_000; // 10% of yield, the market-standard vault fee
        lastHarvestTime = block.timestamp;
    }

    /*//////////////////////////////////////////////////////////////
                              ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    /// @notice True NAV: assets sitting here plus everything the strategies hold.
    /// @dev    This is the only place strategy value enters share pricing, which is why
    ///         `convertToAssets()` is a live NAV read rather than a stored number.
    function totalAssets() public view override returns (uint256) {
        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (address(strategyRouter) == address(0)) return idle;
        return idle + strategyRouter.getTotalStrategyAssets();
    }

    /// @notice Assets held here and not deployed — the reserve buffer.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Assets currently working inside strategies.
    function deployedAssets() public view returns (uint256) {
        if (address(strategyRouter) == address(0)) return 0;
        return strategyRouter.getTotalStrategyAssets();
    }

    /// @notice What a single share is worth, scaled to one whole asset unit.
    /// @dev    The number the UI prints as "1 brRWA = X TBILL".
    function sharePrice() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    /// @notice Assets that could leave the vault in this block.
    function availableLiquidity() public view returns (uint256) {
        uint256 available = idleAssets();
        if (address(strategyRouter) != address(0)) {
            available += strategyRouter.getAvailableLiquidity();
        }
        return available;
    }

    /*//////////////////////////////////////////////////////////////
                          ERC-4626 LIMIT HOOKS
    //////////////////////////////////////////////////////////////*/

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        if (depositCap == 0) return type(uint256).max;
        uint256 assets = totalAssets();
        return assets >= depositCap ? 0 : depositCap - assets;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assetsAllowed = maxDeposit(receiver);
        if (assetsAllowed == type(uint256).max) return type(uint256).max;
        return _convertToShares(assetsAllowed, Math.Rounding.Floor);
    }

    /// @dev Bounded by both the owner's shares and what the strategies can actually free.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        return Math.min(super.maxWithdraw(owner), availableLiquidity());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 liquidShares = _convertToShares(availableLiquidity(), Math.Rounding.Floor);
        return Math.min(balanceOf(owner), liquidShares);
    }

    /*//////////////////////////////////////////////////////////////
                            USER ENTRYPOINTS
    //////////////////////////////////////////////////////////////*/

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner);
    }

    /*//////////////////////////////////////////////////////////////
                        DEPOSIT / WITHDRAW INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev Assets land here first, then get pushed out to strategies. Doing it in this
    ///      order keeps share maths in `super._deposit` reading a consistent NAV.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
    {
        if (depositCap != 0) {
            uint256 projected = totalAssets() + assets;
            if (projected > depositCap) revert DepositCapExceeded(projected, depositCap);
        }

        super._deposit(caller, receiver, assets, shares);
        _deployToStrategies();
    }

    /// @dev Top the idle balance back up from strategies before ERC-4626 transfers out.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 idle = idleAssets();
        if (assets > idle) {
            uint256 shortfall = assets - idle;
            uint256 recalled;
            if (address(strategyRouter) != address(0)) {
                recalled = strategyRouter.routeWithdraw(shortfall);
                emit FundsRecalled(recalled);
            }
            // Re-read rather than trusting the return value: the router is the only place
            // an adapter's partial fill can be absorbed, and it may return less than asked.
            if (idleAssets() < assets) {
                revert InsufficientLiquidity(assets, idleAssets());
            }
        }

        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Offer the router the whole idle balance and let it take what should be working.
    ///      It sizes that against NAV, so the reserve buffer emerges from the curator's
    ///      allocation weights instead of being configured twice — and, importantly, holds
    ///      there. Calling this repeatedly is a no-op once the vault is balanced, which is
    ///      what makes it safe for the keeper to run on a schedule.
    function _deployToStrategies() internal {
        if (address(strategyRouter) == address(0) || paused()) return;

        uint256 idle = idleAssets();
        if (idle == 0) return;

        IERC20(asset()).forceApprove(address(strategyRouter), idle);
        uint256 deployed = strategyRouter.routeDeposit(idle);
        IERC20(asset()).forceApprove(address(strategyRouter), 0);

        if (deployed > 0) emit FundsDeployed(deployed);
    }

    /*//////////////////////////////////////////////////////////////
                                HARVEST
    //////////////////////////////////////////////////////////////*/

    /// @notice Harvest every strategy and compound the proceeds into the share price.
    /// @dev    Permissionless on purpose: the HarvestBot keeper calls it on a schedule, but
    ///         anyone may. There is no path by which calling this benefits the caller at
    ///         depositors' expense — the yield goes to the vault regardless of who pays gas.
    ///
    ///         This is the entrypoint keepers should use rather than `router.harvestAll()`
    ///         directly. The router holds its own reentrancy guard for the whole sweep, so
    ///         the redeploy has to happen out here, after `harvestAll()` returns. Calling
    ///         the router directly is still safe — the yield simply rests in the vault as
    ///         idle assets until the next deposit or `deployIdleFunds()` puts it to work,
    ///         and NAV (so the share price) is identical either way.
    function harvest() external nonReentrant whenNotPaused returns (uint256 harvested) {
        if (address(strategyRouter) == address(0)) return 0;

        harvested = strategyRouter.harvestAll();
        _deployToStrategies();
    }

    /// @inheritdoc IBotVault
    function notifyHarvest(uint256 amount) external onlyRouter {
        uint256 fee;
        if (amount > 0 && performanceFeeBps > 0) {
            fee = (amount * performanceFeeBps) / MAX_BPS;
            if (fee > 0) IERC20(asset()).safeTransfer(feeRecipient, fee);
        }

        totalYieldHarvested += amount - fee;
        lastHarvestTime = block.timestamp;

        emit Harvested(amount, fee, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Point the vault at an allocation engine.
    /// @dev    Recalls everything from the outgoing router first, so a router swap can
    ///         never strand capital in orphaned strategies.
    function setStrategyRouter(address _router) external onlyOwner {
        address old = address(strategyRouter);

        if (old != address(0)) {
            uint256 deployed = strategyRouter.getTotalStrategyAssets();
            if (deployed > 0) {
                uint256 recalled = strategyRouter.routeWithdraw(deployed);
                emit FundsRecalled(recalled);
            }
        }

        if (_router != address(0)) {
            IStrategyRouter router = IStrategyRouter(_router);
            if (router.asset() != asset()) revert RouterAssetMismatch(router.asset(), asset());
            if (router.vault() != address(this)) revert RouterVaultMismatch(router.vault(), address(this));
        }

        strategyRouter = IStrategyRouter(_router);
        emit StrategyRouterUpdated(old, _router);

        _deployToStrategies();
    }

    function setPerformanceFee(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh(_feeBps, MAX_PERFORMANCE_FEE_BPS);
        emit PerformanceFeeUpdated(performanceFeeBps, _feeBps);
        performanceFeeBps = _feeBps;
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        if (_recipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, _recipient);
        feeRecipient = _recipient;
    }

    function setDepositCap(uint256 _cap) external onlyOwner {
        emit DepositCapUpdated(depositCap, _cap);
        depositCap = _cap;
    }

    /// @notice Pull everything back from strategies into the vault.
    /// @dev    The first move in any incident: capital sits idle here, withdrawals stay
    ///         open, and the share price is unaffected because NAV is unchanged.
    function recallAllFunds() external onlyOwner returns (uint256) {
        if (address(strategyRouter) == address(0)) return 0;
        uint256 deployed = strategyRouter.getTotalStrategyAssets();
        if (deployed == 0) return 0;

        uint256 recalled = strategyRouter.routeWithdraw(deployed);
        emit FundsRecalled(recalled);
        return recalled;
    }

    /// @notice Manually push idle assets into strategies (after an unpause, say).
    function deployIdleFunds() external onlyOwner {
        _deployToStrategies();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue tokens accidentally sent to the vault.
    /// @dev    The vault asset is explicitly excluded — sweeping it would let the curator
    ///         drain depositor principal, and it is the one token that is never "stuck".
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == asset()) revert CannotSweepAsset();
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyWithdraw(token, amount);
    }

    // Shares inherit the asset's decimals from ERC4626. `_decimalsOffset()` stays at 0
    // because OZ v5's ERC4626 already applies virtual assets and shares, which is the
    // relevant first-depositor inflation-attack defence; an offset on top would only make
    // the share price cosmetically small.
}
