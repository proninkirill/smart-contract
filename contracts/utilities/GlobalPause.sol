pragma solidity ^0.4.24;

import "openzeppelin-solidity/contracts/ownership/Claimable.sol";

/*
All future trusttoken tokens can reference this contract. 
Allow for Admin to pause a set of tokens with one transaction
Used to signal which fork is the supported fork for asset back tokens
*/
contract GlobalPause is Claimable {
    bool public AllTokenPaused = false;
    string public pauseNotice;

    function pauseAllTokens(bool _status, string _notice) public onlyOwner {
        AllTokenPaused = _status;
        pauseNotice = _notice;
    }

    function requireNotPaused() public {
        require(!AllTokenPaused, pauseNotice);
    }
}
