import {
  BaseStakingProvider,
  StakingParams,
  StakingQuote,
  NetworkProvider,
  StakingBalance,
  Transaction,
} from '@binkai/staking-plugin';
import { ethers, Contract, Provider } from 'ethers';
import { ListaPoolABI } from './abis/Lista';
import { EVM_NATIVE_TOKEN_ADDRESS, NetworkName, Token } from '@binkai/core';
import { isWithinTolerance, parseTokenAmount } from '@binkai/staking-plugin';

export enum StakingOperationType {
  STAKE = 'stake',
  UNSTAKE = 'unstake',
  SUPPLY = 'supply',
  WITHDRAW = 'withdraw',
}

// Core system constants
const CONSTANTS = {
  DEFAULT_GAS_LIMIT: '350000',
  APPROVE_GAS_LIMIT: '50000',
  QUOTE_EXPIRY: 5 * 60 * 1000, // 5 minutes in milliseconds
  BNB_ADDRESS: EVM_NATIVE_TOKEN_ADDRESS,
  SLISBNB_ADDRESS: '0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B',
  LISTA_CONTRACT_ADDRESS: '0x1adB950d8bB3dA4bE104211D5AB038628e477fE6',
  LISTA_API_BASE_URL: 'https://api.lista.org',
} as const;

enum ChainId {
  BSC = 56,
  ETH = 1,
}

export class ListaProvider extends BaseStakingProvider {
  private chainId: ChainId;
  private factory: any;
  protected GAS_BUFFER: bigint = ethers.parseEther('0.0003');

  constructor(provider: Provider, chainId: ChainId = ChainId.BSC) {
    // Create a Map with BNB network and the provider
    const providerMap = new Map<NetworkName, NetworkProvider>();
    providerMap.set(NetworkName.BNB, provider);
    super(providerMap);

    this.chainId = chainId;
    this.factory = new Contract(CONSTANTS.LISTA_CONTRACT_ADDRESS, ListaPoolABI, provider);
  }

  getName(): string {
    return 'lista';
  }

  getSupportedNetworks(): NetworkName[] {
    return [NetworkName.BNB];
  }

  getPrompt(): string {
    return `
      Lista Protocol Information:
      - For unstaking from Lista, use the token with "slis" prefix (e.g., slisBNB for BNB, slisBUSD for BUSD).
      - When a user asks to "unstake all BNB on Lista", you should use slisBNB as tokenA.
      - The "slis" prefix indicates a Lista-supplied token that represents the staked position.
    `;
  }

  protected isNativeToken(tokenAddress: string): boolean {
    return tokenAddress.toLowerCase() === EVM_NATIVE_TOKEN_ADDRESS.toLowerCase();
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
    console.log('🤖 Lista token info:', tokenInfo);
    return tokenInfo;
  }

  private async fetchListaAPY(): Promise<{ currentAPY: string; averageAPY: string }> {
    try {
      const response = await fetch(`${CONSTANTS.LISTA_API_BASE_URL}/v1/stakes/latest-apr`, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://lista.org',
          referer: 'https://lista.org/',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch APY data: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.code !== '000000000') {
        throw new Error(`API returned error: ${data.msg}`);
      }

      return {
        currentAPY: data.data.apr,
        averageAPY: data.data.apr,
      };
    } catch (error) {
      console.error('Error fetching Lista APY:', error);
      // Return default values in case of error
      return {
        currentAPY: '0.01095',
        averageAPY: '0.01095',
      };
    }
  }

  async getQuote(params: StakingParams, userAddress: string): Promise<StakingQuote> {
    try {
      // Check if tokenA is BNB
      if (
        (params.type === StakingOperationType.SUPPLY ||
          params.type === StakingOperationType.STAKE) &&
        params.tokenA.toLowerCase() !== CONSTANTS.BNB_ADDRESS.toLowerCase()
      ) {
        throw new Error(`Lista does not support supplying BNB tokens`);
      }

      if (params.tokenB) {
        throw new Error(`Lista does not support supplying other tokens without BNB`);
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
      if (
        params.type === StakingOperationType.SUPPLY ||
        params.type === StakingOperationType.STAKE
      ) {
        // Use the adjustAmount method for all tokens (both native and ERC20)
        adjustedAmount = await this.adjustAmount(
          params.tokenA,
          params.amountA,
          userAddress,
          params.network,
        );

        if (adjustedAmount !== params.amountA) {
          console.log(`🤖 Lista adjusted input amount from ${params.amountA} to ${adjustedAmount}`);
        }
      } else if (
        params.type === StakingOperationType.WITHDRAW ||
        params.type === StakingOperationType.UNSTAKE
      ) {
        adjustedAmount = Number(adjustedAmount).toFixed(7);
      }
      // Calculate input amount based on decimals
      const swapAmountA = BigInt(Math.floor(Number(adjustedAmount) * 10 ** tokenA.decimals));
      console.log('🚀 ~ ListaProvider ~ getQuote ~ swapAmountA:', swapAmountA);

      const swapAmountB = params.amountB
        ? BigInt(Math.floor(Number(params.amountB) * 10 ** tokenB.decimals))
        : swapAmountA;

      // Build  transaction
      const buildTransactionData = await this.buildStakingRouteTransaction(
        swapAmountA,
        swapAmountB,
        params.type as StakingOperationType,
      );

      // Fetch current APY data from Lista API
      const apyData = await this.fetchListaAPY();

      const swapTransactionData = {
        currentAPY: apyData.currentAPY,
        averageAPY: apyData.averageAPY,
        maxSupply: '0',
        totalSupplyMantissa: '0',
        liquidity: '0',
      };

      // Create and store quote
      const quote = this.createQuote(
        params,
        tokenA,
        tokenB,
        swapTransactionData,
        buildTransactionData,
      );
      console.log('🚀 ~ ListaProvider ~ getQuote ~ quote:', quote);

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
    amountA: bigint,
    amountB: bigint,
    type: StakingOperationType = StakingOperationType.STAKE,
  ) {
    try {
      let txData: string;

      // Handle staking/supply
      if (type === StakingOperationType.STAKE || type === StakingOperationType.SUPPLY) {
        txData = this.factory.interface.encodeFunctionData('deposit', []);
        return {
          to: CONSTANTS.LISTA_CONTRACT_ADDRESS,
          data: txData,
          value: amountA.toString(), // For BNB, the value field is used
        };
      }
      // Handle request unstaking/withdraw
      else {
        txData = this.factory.interface.encodeFunctionData('requestWithdraw', [amountA]);

        return {
          to: CONSTANTS.LISTA_CONTRACT_ADDRESS,
          data: txData,
          value: '0', // No value needed for redeem
        };
      }
    } catch (error) {
      console.error('Error building staking transaction:', error);
      throw new Error(
        `Failed to build staking transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async buildClaimTransaction(uuid: string): Promise<Transaction> {
    try {
      const uuidBigInt = BigInt(uuid);
      const txData = this.factory.interface.encodeFunctionData('claimWithdraw', [uuidBigInt]);

      return {
        to: CONSTANTS.LISTA_CONTRACT_ADDRESS,
        data: txData,
        value: '0',
        network: NetworkName.BNB,
        spender: CONSTANTS.LISTA_CONTRACT_ADDRESS,
      };
    } catch (error) {
      console.error('Error building claim transaction:', error);
      throw new Error(
        `Failed to build claim transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
      currentAPY: Number(swapTransactionData.currentAPY),
      averageAPY: Number(swapTransactionData.averageAPY),
      maxSupply: Number(swapTransactionData.maxSupply),
      currentSupply: Number(swapTransactionData.totalSupplyMantissa),
      liquidity: Number(swapTransactionData.liquidity),
      estimatedGas: CONSTANTS.DEFAULT_GAS_LIMIT,
      tx: {
        to: buildTransactionData.to,
        data: buildTransactionData.data,
        value: buildTransactionData.value,
        gasLimit: buildTransactionData.gasLimit,
        network: params.network,
        spender: buildTransactionData.to,
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
      // Get slisBNB balance
      const slisBNBBalance = await this.getTokenBalance(
        CONSTANTS.SLISBNB_ADDRESS,
        walletAddress,
        NetworkName.BNB,
      );

      const slisBNBInfo = {
        tokenAddress: CONSTANTS.SLISBNB_ADDRESS,
        symbol: 'slisBNB',
        name: 'Staked Lista BNB',
        decimals: 18,
        balance: slisBNBBalance.formattedBalance,
      };

      return {
        address: walletAddress,
        tokens: [slisBNBInfo],
      };
    } catch (error) {
      console.error('Error getting slisBNB staking balance:', error);
      throw new Error(
        `Failed to get slisBNB staking balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async getAllClaimableBalances(
    walletAddress: string,
  ): Promise<{ address: string; tokens: StakingBalance[] }> {
    try {
      const claimableBalances = await this.factory.getUserWithdrawalRequests(walletAddress);

      // Convert the result to an array of objects with natural numbers
      const formattedBalances = claimableBalances.map((item: any) => {
        //uuid
        const uuid = item[0]?.toString();

        const amount = ethers.formatEther(item[1]);

        // Convert timestamp to days (seconds since epoch to days since request)
        const currentTimeSeconds = Math.floor(Date.now() / 1000);

        // Convert currentTimeSeconds to normal date
        const currentDate = new Date(currentTimeSeconds * 1000);

        // Set estimated time to current date + 8 days
        const estimatedDate = new Date(currentDate);
        estimatedDate.setDate(currentDate.getDate() + 8);

        return {
          uuid: uuid,
          claimableAmount: amount,
          estimatedTime: estimatedDate,
        };
      });

      return {
        address: walletAddress,
        tokens: formattedBalances,
      };
    } catch (error) {
      console.error('Error getting claimable balances:', error);
      throw new Error(
        `Failed to get claimable balances: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
