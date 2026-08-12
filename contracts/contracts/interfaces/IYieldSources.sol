// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal private-credit pool surface (Maple / Centrifuge shaped).
/// @dev    Credit pools are not ERC-4626: principal and distributed interest are tracked
///         separately, and redemption is gated by a notice period. The adapter is written
///         against this shape rather than against a specific issuer.
interface ICreditPool {
    function deposit(uint256 amount) external;

    function withdraw(uint256 amount) external returns (uint256);

    /// @notice Claim interest distributed since the last claim.
    function claimInterest() external returns (uint256);

    /// @notice Principal currently lent by `account`.
    function principalOf(address account) external view returns (uint256);

    /// @notice Interest distributed to `account` and not yet claimed.
    function accruedInterest(address account) external view returns (uint256);

    /// @notice Principal that can be recalled right now (rest is out on loan).
    function liquidityOf(address account) external view returns (uint256);

    /// @notice Current pool APY in basis points.
    function currentAPY() external view returns (uint256);

    function asset() external view returns (address);
}

/// @notice Minimal single-sided RWA liquidity pool surface.
/// @dev    A real deployment points this at a zap contract that wraps a Uniswap-V2-style
///         router: `addLiquidity` swaps half the input and mints LP, `removeLiquidity`
///         burns LP and swaps back. Keeping the adapter behind this interface means the
///         swap path can change without touching vault or router accounting.
interface IRwaLiquidityPool {
    function addLiquidity(uint256 amount) external returns (uint256 lpMinted);

    function removeLiquidity(uint256 lpAmount) external returns (uint256 amountOut);

    /// @notice Claim accumulated trading fees for the caller.
    function claimFees() external returns (uint256);

    /// @notice Underlying value of `lpAmount` LP tokens.
    function valueOf(uint256 lpAmount) external view returns (uint256);

    /// @notice LP balance held by `account`.
    function lpBalanceOf(address account) external view returns (uint256);

    /// @notice Trading fees earned by `account` and not yet claimed.
    function pendingFees(address account) external view returns (uint256);

    /// @notice Trailing fee APY in basis points.
    function feeAPY() external view returns (uint256);

    /// @notice The RWA/stable pair this pool provides liquidity to.
    function pair() external view returns (address);

    function asset() external view returns (address);
}
