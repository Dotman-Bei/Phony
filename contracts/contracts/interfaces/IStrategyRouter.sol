// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStrategyRouter
/// @notice Vault-facing view of the allocation engine.
interface IStrategyRouter {
    /// @notice Offer the vault's idle balance to the strategies and let the router take
    ///         however much of it should be working.
    /// @dev    `amount` is a ceiling, not an instruction. The router deploys only what is
    ///         needed to bring strategy holdings up to `totalAllocationBps` of NAV, so the
    ///         unallocated remainder stays in the vault as the reserve buffer and does not
    ///         shrink each time this is called.
    /// @return deployed Amount actually placed into strategies. Anything pulled but not
    ///         deployed (rounding dust, per-strategy caps) is returned to the vault before
    ///         this call ends, so the vault's balance is always whole.
    function routeDeposit(uint256 amount) external returns (uint256 deployed);

    /// @notice Unwind up to `amount` from strategies and push it to the vault.
    /// @return withdrawn Amount actually returned to the vault.
    function routeWithdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Sum of `totalAssets()` across every registered strategy.
    function getTotalStrategyAssets() external view returns (uint256);

    /// @notice Portion of `getTotalStrategyAssets()` withdrawable in this block.
    function getAvailableLiquidity() external view returns (uint256);

    /// @notice Harvest every active strategy and forward the yield to the vault.
    function harvestAll() external returns (uint256 totalHarvested);

    /// @notice The asset every strategy in this router must accept.
    function asset() external view returns (address);

    /// @notice The vault this router serves.
    function vault() external view returns (address);
}
