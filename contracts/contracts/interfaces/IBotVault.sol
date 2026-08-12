// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBotVault
/// @notice Router-facing callback surface of the vault.
interface IBotVault {
    /// @notice Called by the router immediately after it transfers harvested yield in.
    /// @dev    Takes the performance fee and emits `Harvested`. The share price rises as a
    ///         side effect of the transfer, not of any minting — auto-compounding is
    ///         simply `totalAssets()` growing while `totalSupply()` stays fixed.
    function notifyHarvest(uint256 amount) external;
}
