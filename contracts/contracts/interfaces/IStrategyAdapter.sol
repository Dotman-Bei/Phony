// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStrategyAdapter
/// @notice The single boundary between the vault's allocation engine and any RWA yield
///         source. Every adapter — treasury bills, private credit, DEX liquidity, or a
///         future permissioned ERC-3643 wrapper — implements exactly this surface, so the
///         router never learns anything about the protocol underneath.
/// @dev    Accounting contract with the router:
///         - `deposit`  pulls `amount` of `underlyingToken()` from `msg.sender`.
///         - `withdraw` pushes the returned amount of `underlyingToken()` to `msg.sender`.
///         - `harvest`  pushes the returned yield to `msg.sender` and must never dip into
///                      principal; if nothing accrued it returns 0 rather than reverting.
interface IStrategyAdapter {
    /// @notice Pull `amount` of the underlying from the caller and deploy it.
    function deposit(uint256 amount) external;

    /// @notice Unwind up to `amount` and push it to the caller.
    /// @return withdrawn Amount actually returned; may be less than requested if the
    ///         yield source is illiquid (lockups, notice periods, LP depth).
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Realise accrued yield and push it to the caller.
    /// @return harvestedAmount Yield transferred out, in underlying terms.
    function harvest() external returns (uint256 harvestedAmount);

    /// @notice Principal plus unrealised yield currently held by this adapter.
    function totalAssets() external view returns (uint256);

    /// @notice The ERC-20 this adapter accepts and returns.
    function underlyingToken() external view returns (address);

    /// @notice Human-readable adapter name, surfaced in the strategy explorer.
    function name() external view returns (string memory);

    /// @notice Current annualised yield estimate, in basis points (1000 = 10%).
    function estimatedAPY() external view returns (uint256);

    /// @notice Liquid portion of `totalAssets()` that could be withdrawn in this block.
    function availableLiquidity() external view returns (uint256);
}
