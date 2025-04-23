import {
  BaseStakingProvider,
  StakingParams,
  StakingQuote,
  NetworkProvider,
} from '@binkai/staking-plugin';
import { ethers, Contract, Provider } from 'ethers';
import { StakerGatewayABI } from './abis/StakerGateway';
import { EVM_NATIVE_TOKEN_ADDRESS, NetworkName, Token } from '@binkai/core';
import { isSolanaNetwork } from '@binkai/staking-plugin';
import { isWithinTolerance, parseTokenAmount } from '@binkai/staking-plugin';

// Core system constants
const CONSTANTS = {
  StakerGateway: '0xb32dF5B33dBCCA60437EC17b27842c12bFE83394',
  WRAPED_BNB_ADDRESS: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  BNB_ADDRESS: EVM_NATIVE_TOKEN_ADDRESS,
  DEFAULT_GAS_LIMIT: '350000',
  APPROVE_GAS_LIMIT: '50000',
  QUOTE_EXPIRY: 5 * 60 * 1000, // 5 minutes in milliseconds
} as const;

enum ChainId {
  BSC = 56,
  ETH = 1,
}

export class KernelDaoProvider extends BaseStakingProvider {
  private chainId: ChainId;
  private factory: any;
  protected GAS_BUFFER: bigint = ethers.parseEther('0.0003');

  constructor(provider: Provider, chainId: ChainId = ChainId.BSC) {
    // Create a Map with BNB network and the provider
    const providerMap = new Map<NetworkName, NetworkProvider>();
    providerMap.set(NetworkName.BNB, provider);
    super(providerMap);

    this.chainId = chainId;
    this.factory = new Contract(CONSTANTS.StakerGateway, StakerGatewayABI, provider);
  }

  getName(): string {
    return 'kernelDao';
  }

  getSupportedNetworks(): NetworkName[] {
    return [NetworkName.BNB];
  }

  protected isNativeToken(tokenAddress: string): boolean {
    return (
      tokenAddress.toLowerCase() === EVM_NATIVE_TOKEN_ADDRESS.toLowerCase() ||
      tokenAddress.toLowerCase() === CONSTANTS.WRAPED_BNB_ADDRESS.toLowerCase()
    );
  }

  protected async getToken(tokenAddress: string, network: NetworkName): Promise<Token> {
    if (this.isNativeToken(tokenAddress)) {
      return {
        address: tokenAddress as `0x${string}`,
        decimals: 18,
        symbol: 'BNB',
      };
    }
    const token = await super.getToken(tokenAddress, network);

    const tokenInfo = {
      chainId: this.chainId,
      address: token.address.toLowerCase() as `0x${string}`,
      decimals: token.decimals,
      symbol: token.symbol,
    };

    return tokenInfo;
  }

  async getQuote(params: StakingParams, userAddress: string): Promise<StakingQuote> {
    try {
      // Check if tokenA is BNB
      if (
        (params.type === 'supply' || params.type === 'stake' || params.type === 'deposit') &&
        params.tokenA.toLowerCase() !== CONSTANTS.BNB_ADDRESS.toLowerCase() &&
        params.tokenA.toLowerCase() !== CONSTANTS.WRAPED_BNB_ADDRESS.toLowerCase()
      ) {
        throw new Error(`KernelDao does not support supplying without native token`);
      }

      // Fetch input and output token information
      const [tokenA, tokenB] = await Promise.all([
        this.getToken(params.tokenA, params.network),
        params.tokenB
          ? this.getToken(params.tokenB, params.network)
          : this.getToken(params.tokenA, params.network),
      ]);

      // If input token is native token and it's an exact input swap
      let adjustedAmount = params.amountA;
      if (params.type === 'supply' || params.type === 'stake' || params.type === 'deposit') {
        // Use the adjustAmount method for all tokens (both native and ERC20)
        adjustedAmount = await this.adjustAmount(
          params.tokenA,
          params.amountA,
          userAddress,
          params.network,
        );

        if (adjustedAmount !== params.amountA) {
          console.log(
            `🤖 KernelDao adjusted input amount from ${params.amountA} to ${adjustedAmount}`,
          );
        }
      }

      // Calculate input amount based on decimals
      const swapAmountA = BigInt(Math.floor(Number(adjustedAmount) * 10 ** tokenA.decimals));
      const swapAmountB = params.amountB
        ? BigInt(Math.floor(Number(params.amountB) * 10 ** tokenB.decimals))
        : swapAmountA;

      // Build swap transaction
      const buildTransactionData = await this.buildStakingRouteTransaction(
        CONSTANTS.StakerGateway,
        swapAmountA,
        swapAmountB,
        params.type,
      );

      // Create and store quote
      const quote = this.createQuote(
        params,
        tokenA,
        tokenB,
        CONSTANTS.StakerGateway,
        buildTransactionData,
      );

      this.storeQuoteWithExpiry(quote);

      return quote;
    } catch (error: unknown) {
      console.error('Error getting quote:', error);
      throw new Error(
        `Failed to get quote: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private async buildStakingRouteTransaction(
    to: string,
    amountA: bigint,
    amountB: bigint,
    type: 'stake' | 'unstake' | 'supply' | 'withdraw' | 'deposit' = 'stake',
  ) {
    console.log(
      '🤖 Building staking route transaction for kernel dao provider',
      to,
      amountA,
      amountB,
      type,
    );
    try {
      let txData: string;
      const referralId = ''; // hard this param. because not found in the docs.
      // Handle staking/supply
      if (type === 'stake' || type === 'supply' || type === 'deposit') {
        txData = this.factory.interface.encodeFunctionData('stakeNative(string)', [referralId]);

        return {
          to: to,
          data: txData,
          value: amountA.toString(), // For BNB, the value field is used
          gasLimit: CONSTANTS.DEFAULT_GAS_LIMIT,
        };
      }
      // Handle unstaking/withdraw
      else {
        txData = this.factory.interface.encodeFunctionData('unstakeNative(uint256,string)', [
          amountA,
          referralId,
        ]);

        return {
          to: to,
          data: txData,
          value: '0', // No value needed for redeem
          gasLimit: CONSTANTS.DEFAULT_GAS_LIMIT,
        };
      }
    } catch (error) {
      console.error('Error building staking transaction:', error);
      throw new Error(
        `Failed to build staking transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private createQuote(
    params: StakingParams,
    tokenA: Token,
    tokenB: Token,
    swapTransactionData: any,
    buildTransactionData: any,
  ): StakingQuote {
    const quoteId = ethers.hexlify(ethers.randomBytes(32));

    return {
      network: params.network,

      quoteId,
      tokenA: tokenA,
      tokenB: tokenB || null,
      amountA: params.amountA,
      amountB: params.amountB || '0',
      type: params.type,
      currentAPY: Number(swapTransactionData?.supplyApy) || 0,
      averageAPY: Number(swapTransactionData?.supplyApy) || 0,
      maxSupply: Number(swapTransactionData?.supplyCapsMantissa) || 0,
      currentSupply: Number(swapTransactionData?.totalSupplyMantissa) || 0,
      liquidity: Number(swapTransactionData?.liquidityCents) || 0,
      estimatedGas: CONSTANTS.DEFAULT_GAS_LIMIT,
      tx: {
        to: buildTransactionData?.to || '',
        data: buildTransactionData?.data || '',
        value: buildTransactionData?.value || '0',
        gasLimit: buildTransactionData?.gasLimit || CONSTANTS.DEFAULT_GAS_LIMIT,
        network: params.network,
        spender: buildTransactionData?.to || '',
      },
    };
  }

  private storeQuoteWithExpiry(quote: StakingQuote) {
    this.quotes.set(quote.quoteId, { quote, expiresAt: Date.now() + CONSTANTS.QUOTE_EXPIRY });

    // Delete quote after expiry
    setTimeout(() => {
      this.quotes.delete(quote.quoteId);
    }, CONSTANTS.QUOTE_EXPIRY);
  }

  async checkBalance(
    quote: StakingQuote,
    walletAddress: string,
  ): Promise<{ isValid: boolean; message?: string }> {
    try {
      // Handle edge cases
      if (!quote || !walletAddress) {
        return { isValid: false, message: 'Invalid quote or wallet address' };
      }
      if (!quote.amountA || quote.amountA === '0') {
        return { isValid: true }; // Zero amount is always valid
      }

      this.validateNetwork(quote.network);
      if (isSolanaNetwork(quote.network)) {
        // TODO: Implement Solana
      }

      const tokenToCheck = quote.tokenA;
      const requiredAmount = parseTokenAmount(quote.amountA, quote.tokenA.decimals);
      const gasBuffer = this.getGasBuffer(quote.network);

      // Check if the token is native token
      const isNativeToken = this.isNativeToken(tokenToCheck.address);

      if (isNativeToken) {
        // Get native token balance using the cache
        const { balance } = await this.getTokenBalance(
          EVM_NATIVE_TOKEN_ADDRESS,
          walletAddress,
          quote.network,
        );
        const totalRequired = requiredAmount + gasBuffer;

        // Check if balance is sufficient with tolerance
        if (!isWithinTolerance(totalRequired, balance, this.TOLERANCE_PERCENTAGE)) {
          const formattedBalance = ethers.formatEther(balance);
          const formattedRequired = ethers.formatEther(requiredAmount);
          const formattedTotal = ethers.formatEther(totalRequired);
          return {
            isValid: false,
            message: `Insufficient native token balance. Required: ${formattedRequired} (+ ~${ethers.formatEther(gasBuffer)} for gas = ${formattedTotal}), Available: ${formattedBalance}`,
          };
        }
      } else {
        // For other tokens, check ERC20 balance using the cache
        const { balance, formattedBalance } = await this.getTokenBalance(
          tokenToCheck.address,
          walletAddress,
          quote.network,
        );

        // Check if balance is sufficient with tolerance
        if (!isWithinTolerance(requiredAmount, balance, this.TOLERANCE_PERCENTAGE)) {
          const formattedRequired = ethers.formatUnits(requiredAmount, quote.tokenA.decimals);
          return {
            isValid: false,
            message: `Insufficient ${quote.tokenA.symbol} balance. Required: ${formattedRequired} ${quote.tokenA.symbol}, Available: ${formattedBalance} ${quote.tokenA.symbol}`,
          };
        }

        // Check if user has enough native token for gas using the cache
        const { balance: nativeBalance } = await this.getTokenBalance(
          EVM_NATIVE_TOKEN_ADDRESS,
          walletAddress,
          quote.network,
        );
        if (nativeBalance < gasBuffer) {
          const formattedBalance = ethers.formatEther(nativeBalance);
          return {
            isValid: false,
            message: `Insufficient native token for gas fees. Required: ~${ethers.formatEther(gasBuffer)}, Available: ${formattedBalance}`,
          };
        }
      }

      return { isValid: true };
    } catch (error) {
      console.error('Error checking balance:', error);
      return {
        isValid: false,
        message: `Failed to check balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async getAllStakingBalances(walletAddress: string) {
    try {
      const bnbBalance = await this.factory.balanceOf(CONSTANTS.WRAPED_BNB_ADDRESS, walletAddress);

      //formattedBnbBalance
      const formattedBnbBalance = ethers.formatEther(bnbBalance);

      const bnbInfo = {
        tokenAddress: CONSTANTS.WRAPED_BNB_ADDRESS,
        symbol: 'WBNB',
        name: 'Wrapped BNB',
        decimals: 18,
        balance: formattedBnbBalance,
        provider: this.getName(),
      };

      return {
        address: walletAddress,
        tokens: [bnbInfo],
      };
    } catch (error) {
      console.error('Error getting BNB staking balance:', error);
      throw new Error(
        `Failed to get BNB staking balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
