// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockRWAToken
/// @notice Stand-in for a tokenized real-world asset — TBILL, PCREDIT, or COMMODITY.
/// @dev    Testnet and local only. The faucet is open on purpose so judges and testers can
///         run the full deposit → harvest → withdraw loop without being airdropped first.
///         Nothing in the vault depends on this contract; mainnet points at real RWA tokens.
contract MockRWAToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    /// @notice Per-call faucet limit.
    uint256 public faucetAmount;

    /// @notice Cooldown between faucet claims per address.
    uint256 public faucetCooldown = 12 hours;

    mapping(address => uint256) public lastFaucetClaim;

    /// @notice Addresses allowed to mint. The mock yield sources need this: they pay
    ///         interest by minting, which is what a real issuer replaces with a coupon.
    mapping(address => bool) public isMinter;

    event FaucetClaimed(address indexed to, uint256 amount);
    event MinterUpdated(address indexed minter, bool allowed);

    error FaucetCooldownActive(uint256 availableAt);
    error NotMinter(address caller);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        _decimals = decimals_;
        faucetAmount = 10_000 * 10 ** decimals_;
        isMinter[initialOwner] = true;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter(msg.sender);
        _mint(to, amount);
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterUpdated(minter, allowed);
    }

    /// @notice Claim test tokens. Rate-limited per address.
    function faucet() external {
        uint256 last = lastFaucetClaim[msg.sender];
        if (last != 0 && block.timestamp < last + faucetCooldown) {
            revert FaucetCooldownActive(last + faucetCooldown);
        }

        lastFaucetClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);

        emit FaucetClaimed(msg.sender, faucetAmount);
    }

    function setFaucet(uint256 amount, uint256 cooldown) external onlyOwner {
        faucetAmount = amount;
        faucetCooldown = cooldown;
    }
}
