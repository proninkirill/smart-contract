import { expect, use } from 'chai'
import { Contract, ContractTransaction, providers, Wallet, utils } from 'ethers'
import { loadFixture, solidity } from 'ethereum-waffle'
import { parseEther } from 'ethers/utils'
import { TrueUsd } from '../build/types/TrueUsd'
import { RegistryMock } from '../build/types/RegistryMock'
import { AssuredFinancialOpportunity } from '../build/types/AssuredFinancialOpportunity'
import { AaveFinancialOpportunity } from '../build/types/AaveFinancialOpportunity'
import { StakedToken } from '../build/types/StakedToken'
import { MockTrustToken } from '../build/types/MockTrustToken'
import { RegistryAttributes } from '../scripts/attributes'
import { LendingPoolCoreMock } from '../build/types/LendingPoolCoreMock'
import { timeTravel } from './utils/timeTravel'
import { deployAll } from './fixtures/deployAll'

use(solidity)
const BTC1000 = parseEther('1000').div(1e10)

describe('Staking', () => {
  let holder: Wallet, staker: Wallet, secondStaker: Wallet
  let provider: providers.JsonRpcProvider
  let trueUsd: TrueUsd
  let trustToken: MockTrustToken
  let stakedToken: StakedToken
  let registry: RegistryMock
  let assuredFinancialOpportunity: AssuredFinancialOpportunity

  describe('with Aave and AssuredFinancialOpportunity', () => {
    let aaveLendingPoolCore: LendingPoolCoreMock
    let aaveFinancialOpportunity: AaveFinancialOpportunity

    const stakeAll = async (staker: Wallet) => trustToken.connect(staker).transfer(stakedToken.address, await trustToken.balanceOf(staker.address))

    beforeEach(async () => {
      let liquidator: Contract
      let lendingPool: Contract
      let sharesToken: Contract
      let fractionalExponents: Contract

      ({
        wallets: [, holder, staker, secondStaker],
        token: trueUsd,
        stakedToken,
        sharesToken,
        registry,
        fractionalExponents,
        lendingPoolCore: aaveLendingPoolCore,
        lendingPool,
        liquidator,
        assuredFinancialOpportunity,
        aaveFinancialOpportunity,
        trustToken,
      } = await loadFixture(deployAll))

      await aaveFinancialOpportunity.configure(sharesToken.address, lendingPool.address, trueUsd.address, assuredFinancialOpportunity.address)
      await assuredFinancialOpportunity.configure(
        aaveFinancialOpportunity.address,
        stakedToken.address,
        liquidator.address,
        fractionalExponents.address,
        trueUsd.address,
        trueUsd.address,
      )

      await trueUsd.mint(sharesToken.address, parseEther('1000'))
      await registry.setAttributeValue(holder.address, RegistryAttributes.isTrueRewardsWhitelisted.hex, 1)

      await registry.subscribe(RegistryAttributes.isRegisteredContract.hex, trustToken.address)
      await registry.subscribe(RegistryAttributes.isRegisteredContract.hex, trueUsd.address)

      await registry.setAttributeValue(staker.address, RegistryAttributes.hasPassedKYCAML.hex, 1)
      await registry.setAttributeValue(secondStaker.address, RegistryAttributes.hasPassedKYCAML.hex, 1)
      await registry.setAttributeValue(stakedToken.address, RegistryAttributes.isRegisteredContract.hex, 1)

      provider = holder.provider as providers.JsonRpcProvider

      expect(await registry.subscriberCount(RegistryAttributes.isRegisteredContract.hex)).to.eq(2)
      expect(await registry.getAttributeValue(stakedToken.address, RegistryAttributes.isRegisteredContract.hex)).to.eq(1)
      expect(await registry.hasAttribute(stakedToken.address, RegistryAttributes.isRegisteredContract.hex)).to.be.true
    })

    context('one staker', () => {
      beforeEach(async () => {
        await assuredFinancialOpportunity.setRewardBasis(700)
        await trustToken.connect(staker).approve(stakedToken.address, BTC1000)
        await trustToken.faucet(staker.address, BTC1000)
        expect(await trustToken.balanceOf(stakedToken.address)).to.eq(0)
        expect(await stakedToken.totalSupply()).to.eq(0)

        await stakedToken.connect(staker).deposit(BTC1000)
        expect(await stakedToken.balanceOf(staker.address)).to.equal(BTC1000.mul(1000))
        expect(await assuredFinancialOpportunity.poolAwardBalance()).to.eq(0)
      })

      it('earns part of the reward', async () => {
        await trueUsd.mint(holder.address, parseEther('100'))

        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('1000000000'))
        await trueUsd.connect(holder).enableTrueReward()
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('2000000000'))

        expect(await assuredFinancialOpportunity.totalSupply()).to.eq(parseEther('100'))
        expect(await aaveFinancialOpportunity.totalSupply()).to.eq(parseEther('100'))
        expect(await aaveFinancialOpportunity.aTokenBalance()).to.eq(parseEther('200'))

        const expectedHolderBalance = parseEther('162.450479271247104500') // 100 * 2 ^ 0.7
        expect(await trueUsd.balanceOf(holder.address)).to.equal(expectedHolderBalance)
        expect(await assuredFinancialOpportunity.poolAwardBalance()).to.eq(parseEther('200').sub(expectedHolderBalance))
      })

      const getTimestamp = async (provider: providers.Provider, tx: ContractTransaction) => (await provider.getBlock((await tx.wait()).blockNumber)).timestamp
      const initUnstake = async (token: StakedToken, amount: utils.BigNumberish): Promise<[Promise<ContractTransaction>, number]> => {
        const unstakeInitialization = await token.initUnstake(amount)
        return [Promise.resolve(unstakeInitialization), await getTimestamp(token.provider, unstakeInitialization)]
      }

      it('cannot unstake more than own balance', async () => {
        await expect(stakeAll(staker)).to.emit(stakedToken, 'Mint')
        await trueUsd.connect(holder).enableTrueReward()
        const balance = await stakedToken.balanceOf(staker.address)
        const [tx, timestamp] = await initUnstake(stakedToken.connect(staker), balance.add(1))

        await expect(tx).to.emit(stakedToken, 'PendingWithdrawal').withArgs(staker.address, timestamp, balance)
      })

      it('cannot unstake twice', async () => {
        await stakeAll(staker)
        const balance = await stakedToken.balanceOf(staker.address)
        await initUnstake(stakedToken.connect(staker), balance)
        const [tx, timestamp] = await initUnstake(stakedToken.connect(staker), 1)
        await expect(tx).to.emit(stakedToken, 'PendingWithdrawal').withArgs(staker.address, timestamp, 0)
      })

      const TWO_WEEKS = 60 * 60 * 24 * 14

      it('cannot finalize unstake for 14 days', async () => {
        await stakeAll(staker)
        const balance = await stakedToken.balanceOf(staker.address)
        const [, timestamp] = await initUnstake(stakedToken.connect(staker), balance)
        await expect(stakedToken.connect(staker).finalizeUnstake(staker.address, [timestamp]))
          .to.be.revertedWith('must wait 2 weeks to unstake')
        await timeTravel(provider, TWO_WEEKS - 10)
        await expect(stakedToken.connect(staker).finalizeUnstake(staker.address, [timestamp]))
          .to.be.revertedWith('must wait 2 weeks to unstake')
      })

      it('can finalize unstake after 14 days', async () => {
        await stakeAll(staker)
        const balance = await stakedToken.balanceOf(staker.address)
        const [, timestamp] = await initUnstake(stakedToken.connect(staker), balance)
        const truBalanceBefore = await trustToken.balanceOf(staker.address)
        await timeTravel(provider, TWO_WEEKS)
        await stakedToken.connect(staker).finalizeUnstake(staker.address, [timestamp])
        const truBalanceAfter = await trustToken.balanceOf(staker.address)
        expect(truBalanceAfter).to.equal(truBalanceBefore.add(balance.div(1000)))
      })

      it('can stake multiple times', async () => {
        await stakeAll(staker)
        const balance = await stakedToken.balanceOf(staker.address)
        const [, t1] = await initUnstake(stakedToken.connect(staker), balance.div(2))
        const [, t2] = await initUnstake(stakedToken.connect(staker), balance.div(2))
        const truBalanceBefore = await trustToken.balanceOf(staker.address)
        await timeTravel(provider, TWO_WEEKS)
        await stakedToken.connect(staker).finalizeUnstake(staker.address, [t1, t2])
        const truBalanceAfter = await trustToken.balanceOf(staker.address)
        expect(truBalanceAfter).to.equal(truBalanceBefore.add(balance.div(1000)))
      })

      it('receives reward', async () => {
        await stakeAll(staker)

        await trueUsd.mint(holder.address, parseEther('100'))
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('1000000000'))
        await trueUsd.connect(holder).enableTrueReward()
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('2000000000'))

        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(0)
        await assuredFinancialOpportunity.awardPool()
        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(parseEther('37.5495')) // 100 * (2 - 2 ^ 0.7)
        await stakedToken.connect(staker).claimRewards(staker.address)
        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(0)
        expect(await trueUsd.balanceOf(staker.address)).to.equal(parseEther('37.5495'))
      })
    })

    context('two stakers', () => {
      beforeEach(async () => {
        await assuredFinancialOpportunity.setRewardBasis(700)
        await trustToken.connect(staker).approve(stakedToken.address, BTC1000)
        await trustToken.connect(secondStaker).approve(stakedToken.address, BTC1000.div(4))
        await trustToken.faucet(staker.address, BTC1000)
        await trustToken.faucet(secondStaker.address, BTC1000.div(4))
        expect(await trustToken.balanceOf(stakedToken.address)).to.eq(0)
        expect(await stakedToken.totalSupply()).to.eq(0)

        await stakedToken.connect(staker).deposit(BTC1000)
        await stakedToken.connect(secondStaker).deposit(BTC1000.div(4))
        expect(await stakedToken.balanceOf(staker.address)).to.equal(BTC1000.mul(1000))
        expect(await stakedToken.balanceOf(secondStaker.address)).to.equal(BTC1000.div(4).mul(1000))
        expect(await assuredFinancialOpportunity.poolAwardBalance()).to.eq(0)
      })

      it('receives reward', async () => {
        await stakeAll(staker)
        await stakeAll(secondStaker)

        await trueUsd.mint(holder.address, parseEther('100'))
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('1000000000'))
        await trueUsd.connect(holder).enableTrueReward()
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('2000000000'))

        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(0)
        expect(await stakedToken.unclaimedRewards(secondStaker.address)).to.equal(0)
        await assuredFinancialOpportunity.awardPool()

        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(parseEther('30.0396')) // 100 * (2 - 2 ^ 0.7) * 4/5
        await stakedToken.connect(staker).claimRewards(staker.address)
        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(0)
        expect(await trueUsd.balanceOf(staker.address)).to.equal(parseEther('30.0396'))

        expect(await stakedToken.unclaimedRewards(secondStaker.address)).to.equal(parseEther('7.5099')) // 100 * (2 - 2 ^ 0.7) * 1/5
        await stakedToken.connect(secondStaker).claimRewards(secondStaker.address)
        expect(await stakedToken.unclaimedRewards(secondStaker.address)).to.equal(0)
        expect(await trueUsd.balanceOf(secondStaker.address)).to.equal(parseEther('7.5099'))
      })

      it('transfer stake without rewards', async () => {
        await stakeAll(staker)

        await stakedToken.connect(staker).transfer(secondStaker.address, await stakedToken.balanceOf(staker.address))

        expect(await stakedToken.balanceOf(staker.address)).to.equal(0)
        expect(await stakedToken.balanceOf(secondStaker.address)).to.equal(BTC1000.mul(1000).mul(5).div(4)) // 1 + 1/4
      })

      it('transfer stake with rewards', async () => {
        await stakeAll(staker)

        await trueUsd.mint(holder.address, parseEther('100'))
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('1000000000'))
        await trueUsd.connect(holder).enableTrueReward()
        await aaveLendingPoolCore.setReserveNormalizedIncome(parseEther('2000000000'))
        await assuredFinancialOpportunity.awardPool()

        await stakedToken.connect(staker).transfer(secondStaker.address, await stakedToken.balanceOf(staker.address))

        expect(await stakedToken.balanceOf(staker.address)).to.equal(0)
        expect(await stakedToken.balanceOf(secondStaker.address)).to.equal(BTC1000.mul(1000).mul(5).div(4))

        expect(await stakedToken.unclaimedRewards(staker.address)).to.equal(parseEther('0'))
        expect(await stakedToken.unclaimedRewards(secondStaker.address)).to.equal(parseEther('37.5495'))

        await stakedToken.connect(secondStaker).claimRewards(secondStaker.address)
        expect(await trueUsd.balanceOf(secondStaker.address)).to.equal(parseEther('37.5495'))
      })
    })
  })
})