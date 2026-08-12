// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BDEX V2 interfaces
/// @notice The subset of BDEX V2 that the LP adapter needs.
///
/// @dev    BDEX V2 is a Uniswap V2 deployment, verified rather than assumed: its Router02
///         reports `factory()` equal to the published factory, `WETH()` equal to WBOT, and
///         its `getAmountsOut` matches the canonical 997/1000 constant-product formula to
///         the wei against live reserves. That is why `BdexV2LpStrategy` is allowed to price
///         swaps with the same arithmetic in-contract instead of calling out to the router:
///         a view that cannot revert is worth more here than one that saves a few lines,
///         because the vault's `maxWithdraw` depends on it.
///
///         Addresses (from https://dev-docs.botchain.ai/docs/DEX/contract-addresses/):
///           mainnet 677  factory 0x117115f3B72C8d1989178089A67D0C26f8EE0AA3
///                        router  0x1414eD29FdFD322c3c0a830330ed982E2D629e76
///           testnet 968  factory 0x65b8e98ceA190d8c28B3e4716402027f634d15a3
///                        router  0xD6425a02f0845B8D99e349C34D2E7A576E177345
interface IBdexV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IBdexV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IBdexV2Router02 {
    function factory() external view returns (address);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
