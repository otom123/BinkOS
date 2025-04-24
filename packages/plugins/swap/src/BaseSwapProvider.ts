import {
  EVM_NATIVE_TOKEN_ADDRESS,
  NetworkName,
  SOL_NATIVE_TOKEN_ADDRESS,
  SOL_NATIVE_TOKEN_ADDRESS2,
  Token,
} from '@binkai/core';
import { ISwapProvider, SwapQuote, SwapParams, Transaction, NetworkProvider } from './types';
import { ethers, Contract, Interface, Provider } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  adjustTokenAmount,
  isWithinTolerance,
  DEFAULT_TOLERANCE_PERCENTAGE,
  parseTokenAmount,
  EVM_DECIMALS,
} from './utils/tokenUtils';
import {
  isSolanaNetwork,
  isProviderInstance,
  isSolanaProvider,
  getEvmProviderForNetwork as getEvmProvider,
  getSolanaProviderForNetwork as getSolanaProvider,
  isNetworkSupported,
  validateNetwork as validateNetworkUtil,
} from './utils/networkUtils';
import {
  createTokenBalanceCache,
  createTokenCache,
  getTokenInfo,
  getTokenInfoSolana,
} from './utils/tokenOperations';

export abstract class BaseSwapProvider implements ISwapProvider {
  protected providers: Map<NetworkName, NetworkProvider> = new Map();
  protected tokenCache = createTokenCache();
  protected readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  protected quotes: Map<string, { quote: SwapQuote; expiresAt: number }> = new Map();
  protected readonly QUOTE_EXPIRY = 5 * 60 * 1000; // 5 minutes
  protected readonly TOLERANCE_PERCENTAGE = DEFAULT_TOLERANCE_PERCENTAGE;
  // Initialize the token balance cache
  protected balanceCache = createTokenBalanceCache();

  // Network-specific gas buffers
  protected readonly GAS_BUFFERS: Record<NetworkName, bigint> = {
    [NetworkName.ETHEREUM]: ethers.parseEther('0.001'), // 0.001 ETH
    [NetworkName.POLYGON]: ethers.parseEther('0.1'), // 0.1 MATIC
    [NetworkName.ARBITRUM]: ethers.parseEther('0.001'), // 0.001 ETH
    [NetworkName.OPTIMISM]: ethers.parseEther('0.001'), // 0.001 ETH
    [NetworkName.BNB]: ethers.parseEther('0.0001'), // 0.001 BNB
    [NetworkName.SOLANA]: BigInt(1000000), // 0.001 SOL in lamports
    [NetworkName.SEPOLIA]: ethers.parseEther('0.001'), // 0.001 ETH
    [NetworkName.SOLANA_DEVNET]: BigInt(1000000), // 0.001 SOL in lamports
  };

  constructor(providerConfig: Map<NetworkName, NetworkProvider>) {
    // Validate providers against supported networks
    const supportedNetworks = this.getSupportedNetworks();
    for (const [network, provider] of providerConfig.entries()) {
      if (!supportedNetworks.includes(network)) {
        throw new Error(`Network ${network} is not supported by ${this.getName()}`);
      }
      // Validate provider type based on network
      if (isSolanaNetwork(network) && !isSolanaProvider(provider)) {
        throw new Error(`Invalid provider type for Solana network ${network}`);
      }
      if (!isSolanaNetwork(network) && !isProviderInstance(provider)) {
        throw new Error(`Invalid provider type for EVM network ${network}`);
      }
    }
    this.providers = providerConfig;

    // Set up periodic cache cleanup
    this.setupCacheCleanup();
  }

  abstract getName(): string;
  abstract getQuote(params: SwapParams, walletAddress: string): Promise<SwapQuote>;
  abstract getSupportedNetworks(): NetworkName[];

  getPrompt?(): string;

  protected abstract isNativeToken(tokenAddress: string): boolean;

  /**
   * Validates if the network is supported
   * @param network The network to validate
   * @throws Error if the network is not supported
   */
  protected validateNetwork(network: NetworkName): void {
    validateNetworkUtil(this.getSupportedNetworks(), this.providers, network, this.getName());
  }

  /**
   * Get the EVM provider for a specific network
   * @param network The network to get the provider for
   * @returns The EVM provider for the specified network
   * @throws Error if the network is not supported or if it's not an EVM network
   */
  protected getEvmProviderForNetwork(network: NetworkName): Provider {
    return getEvmProvider(this.providers, network, this.getName());
  }

  /**
   * Get the Solana provider for a specific network
   * @param network The network to get the provider for
   * @returns The Solana provider for the specified network
   * @throws Error if the network is not supported or if it's not a Solana network
   */
  protected getSolanaProviderForNetwork(network: NetworkName): Connection {
    return getSolanaProvider(this.providers, network, this.getName());
  }

  /**
   * Check if a network is supported by this provider
   * @param network The network to check
   * @returns True if the network is supported, false otherwise
   */
  protected isNetworkSupported(network: NetworkName): boolean {
    return isNetworkSupported(this.getSupportedNetworks(), this.providers, network);
  }

  /**
   * Get the gas buffer for a specific network
   * @param network The network to get the gas buffer for
   * @returns The gas buffer amount for the specified network
   */
  protected getGasBuffer(network: NetworkName): bigint {
    const buffer = this.GAS_BUFFERS[network];
    if (!buffer) {
      throw new Error(`No gas buffer defined for network ${network}`);
    }
    return buffer;
  }

  /**
   * Gets the token balance for a wallet address
   * @param tokenAddress The address of the token
   * @param walletAddress The address of the wallet
   * @param network The network to get the balance from
   * @param forceRefresh Whether to force a refresh of the cached balance
   * @returns A promise that resolves to the token balance (both bigint and formatted string)
   */
  protected async getTokenBalance(
    tokenAddress: string,
    walletAddress: string,
    network: NetworkName,
    forceRefresh: boolean = false,
  ): Promise<{ balance: bigint; formattedBalance: string }> {
    this.validateNetwork(network);

    // If force refresh, invalidate the cache entry
    if (forceRefresh) {
      this.balanceCache.invalidateBalance(tokenAddress, walletAddress, network);
    }

    // Get token info for decimals
    const token = await this.getToken(tokenAddress, network);

    // Use the balance cache to get the balance
    return await this.balanceCache.getTokenBalance(
      tokenAddress,
      walletAddress,
      network,
      this.providers,
      this.getName(),
      token.decimals,
    );
  }

  /**
   * Adjusts the input amount for native token swaps to account for gas costs
   * @param amount The original amount to spend
   * @param decimals The decimals of the token
   * @param walletAddress The address of the user
   * @param network The network to use
   * @returns The adjusted amount after accounting for gas buffer
   */

  protected async adjustNativeTokenAmount(
    amount: string,
    decimals: number,
    walletAddress: string,
    network: NetworkName,
  ): Promise<string> {
    this.validateNetwork(network);
    let balance;
    let amountBN;
    if (isSolanaNetwork(network)) {
      const provider = this.getSolanaProviderForNetwork(network);
      amountBN = parseTokenAmount(amount, decimals);
      balance = await provider.getBalance(new PublicKey(walletAddress));
    } else {
      const provider = this.getEvmProviderForNetwork(network);
      amountBN = parseTokenAmount(amount, decimals);
      balance = await provider.getBalance(walletAddress);
    }

    //convert if type of balance is number
    if (typeof balance === 'number') {
      balance = BigInt(balance);
    }

    const gasBuffer = this.getGasBuffer(network);

    // Check if user has enough balance for amount + gas buffer
    if (balance < amountBN + gasBuffer) {
      // If not enough balance for both, ensure at least gas buffer is available
      if (amountBN <= gasBuffer) {
        throw new Error(
          `Amount too small. Minimum amount should be greater than ${ethers.formatUnits(gasBuffer, decimals)} native token to cover gas`,
        );
      }
      // Subtract gas buffer from amount
      const adjustedAmountBN = amountBN - gasBuffer;
      const adjustedAmount = ethers.formatUnits(adjustedAmountBN, decimals);
      console.log(
        '🤖 Adjusted amount for gas buffer:',
        `${ethers.formatUnits(amountBN, decimals)}`,
        `(insufficient balance for full amount + ${ethers.formatUnits(gasBuffer, decimals)} gas)`,
      );
      return adjustedAmount;
    }

    console.log(
      '🤖 Using full amount:',
      amount,
      `(sufficient balance for amount + ${ethers.formatUnits(gasBuffer, decimals)} gas)`,
    );
    return amount;
  }

  protected async getTokenInfo(tokenAddress: string, network: NetworkName): Promise<Token> {
    this.validateNetwork(network);
    if (isSolanaNetwork(network)) {
      // TODO: Implement Solana
      return await getTokenInfoSolana(tokenAddress, network, this.providers, this.getName());
    }
    const provider = this.getEvmProviderForNetwork(network);
    return await getTokenInfo(tokenAddress, network, provider);
  }

  protected async getToken(tokenAddress: string, network: NetworkName): Promise<Token> {
    this.validateNetwork(network);
    if (isSolanaNetwork(network)) {
      return await getTokenInfoSolana(tokenAddress, network, this.providers, this.getName());
    }
    // Use the tokenCache utility instead of manual caching
    return await this.tokenCache.getToken(tokenAddress, network, this.providers, this.getName());
  }

  async checkBalance(
    quote: SwapQuote,
    walletAddress: string,
  ): Promise<{ isValid: boolean; message?: string }> {
    try {
      // Handle edge cases
      if (!quote || !walletAddress) {
        return { isValid: false, message: 'Invalid quote or wallet address' };
      }
      if (!quote.fromAmount || quote.fromAmount === '0') {
        return { isValid: true }; // Zero amount is always valid
      }

      this.validateNetwork(quote.network);
      if (isSolanaNetwork(quote.network)) {
        const provider = this.getSolanaProviderForNetwork(quote.network);

        const tokenToCheck = quote.fromToken;
        const requiredAmount = BigInt(
          Math.floor(parseFloat(quote.fromAmount) * Math.pow(10, quote.fromToken.decimals)),
        );

        const gasBuffer = this.getGasBuffer(quote.network);

        // Check if the token is native SOL
        const isNativeToken = this.isNativeSolana(tokenToCheck.address);

        if (isNativeToken) {
          // For native SOL, just check the wallet balance directly
          const balance = await provider.getBalance(new PublicKey(walletAddress));
          const totalRequired = requiredAmount + gasBuffer;

          if (BigInt(balance) < totalRequired) {
            const formattedBalance = (Number(balance) / Math.pow(10, 9)).toFixed(9);
            const formattedRequired = (Number(requiredAmount) / Math.pow(10, 9)).toFixed(9);
            const formattedTotal = (Number(totalRequired) / Math.pow(10, 9)).toFixed(9);
            return {
              isValid: false,
              message: `Insufficient SOL balance. Required: ${formattedRequired} (+ ~${(Number(gasBuffer) / Math.pow(10, 9)).toFixed(9)} for gas = ${formattedTotal}), Available: ${formattedBalance}`,
            };
          }
          return { isValid: true };
        } else {
          // For SPL tokens
          const connection = this.getSolanaProviderForNetwork(quote.network);
          const tokenAccount = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(walletAddress),
            {
              mint: new PublicKey(quote.fromToken.address),
            },
          );
          const mintInfo = await provider.getParsedAccountInfo(
            new PublicKey(quote.fromToken.address),
          );

          if (!mintInfo.value || !('parsed' in mintInfo.value.data)) {
            return {
              isValid: false,
              message: `Invalid token address: ${quote.fromToken.address}`,
            };
          }

          if (tokenAccount.value.length === 0) {
            return {
              isValid: false,
              message: `No token account found for ${tokenToCheck.symbol}`,
            };
          }

          const balance = BigInt(tokenAccount.value[0].account.data.parsed.info.tokenAmount.amount);

          if (balance < requiredAmount) {
            const formattedBalance = ethers.formatUnits(balance, quote.fromToken.decimals);
            const formattedRequired = ethers.formatUnits(requiredAmount, quote.fromToken.decimals);

            return {
              isValid: false,
              message: `Insufficient ${tokenToCheck.symbol ? tokenToCheck.symbol : ''} balance. Required: ${formattedRequired} ${tokenToCheck.symbol ? tokenToCheck.symbol : ''}, Available: ${formattedBalance} ${tokenToCheck.symbol ? tokenToCheck.symbol : ''}`,
            };
          }

          // Check if user has enough SOL for gas
          const nativeBalance = await provider.getBalance(new PublicKey(walletAddress));
          if (BigInt(nativeBalance) < gasBuffer) {
            const formattedBalance = ethers.formatUnits(nativeBalance, 9);
            return {
              isValid: false,
              message: `Insufficient SOL for gas fees. Required: ~${ethers.formatUnits(gasBuffer, 9)}, Available: ${formattedBalance}`,
            };
          }
        }

        return { isValid: true };
      } else {
        const tokenToCheck = quote.fromToken;
        const requiredAmount = parseTokenAmount(quote.fromAmount, quote.fromToken.decimals);
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
            const formattedRequired = ethers.formatUnits(requiredAmount, quote.fromToken.decimals);
            return {
              isValid: false,
              message: `Insufficient ${quote.fromToken.symbol} balance. Required: ${formattedRequired} ${quote.fromToken.symbol}, Available: ${formattedBalance} ${quote.fromToken.symbol}`,
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

  async buildApproveTransaction(
    network: NetworkName,
    token: string,
    spender: string,
    amount: string,
    walletAddress: string,
  ): Promise<Transaction> {
    this.validateNetwork(network);
    if (isSolanaNetwork(network)) {
      // TODO: Implement Solana
    }
    if (this.isNativeToken(token)) {
      throw new Error('Native token does not need approval');
    }

    const tokenInfo = await this.getToken(token, network);
    const erc20Interface = new Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]);

    const data = erc20Interface.encodeFunctionData('approve', [
      spender,
      parseTokenAmount(amount, tokenInfo.decimals),
    ]);

    // Invalidate the native token balance cache since gas will be spent
    this.invalidateBalanceCache(EVM_NATIVE_TOKEN_ADDRESS, walletAddress, network);

    return {
      to: token,
      data,
      value: '0',
      network,
      spender: token,
    };
  }

  async checkAllowance(
    network: NetworkName,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    this.validateNetwork(network);
    if (isSolanaNetwork(network)) {
      // TODO: Implement Solana
    }
    const provider = this.getEvmProviderForNetwork(network);
    if (this.isNativeToken(tokenAddress)) {
      return BigInt(Number.MAX_SAFE_INTEGER) * BigInt(10 ** 18);
    }

    const erc20 = new Contract(
      tokenAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      provider,
    );
    return await erc20.allowance(owner, spender);
  }

  protected storeQuote(quote: SwapQuote, additionalData?: any) {
    this.quotes.set(quote.quoteId, {
      quote,
      expiresAt: Date.now() + this.QUOTE_EXPIRY,
      ...additionalData,
    });

    setTimeout(() => {
      this.quotes.delete(quote.quoteId);
    }, this.QUOTE_EXPIRY);
  }

  async buildSwapTransaction(quote: SwapQuote, walletAddress: string): Promise<Transaction> {
    try {
      this.validateNetwork(quote.network);
      if (isSolanaNetwork(quote.network)) {
        // TODO: Implement Solana
      }
      const storedData = this.quotes.get(quote.quoteId);
      if (!storedData) {
        throw new Error('Quote expired or not found. Please get a new quote.');
      }

      // Invalidate the balance cache for the tokens involved in the swap
      // since balances will change after the transaction is executed
      this.invalidateBalanceCache(quote.fromToken.address, walletAddress, quote.network);
      this.invalidateBalanceCache(quote.toToken.address, walletAddress, quote.network);

      return {
        to: storedData.quote.tx?.to || '',
        data: storedData.quote.tx?.data || '',
        value: storedData.quote.tx?.value || '0',
        gasLimit: storedData.quote.tx?.gasLimit,
        network: storedData.quote.network,
        spender: storedData.quote.tx?.to || '',
        lastValidBlockHeight: storedData.quote.tx?.lastValidBlockHeight,
      };
    } catch (error) {
      console.error('Error building swap transaction:', error);
      throw new Error(
        `Failed to build swap transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Public method to adjust token amount based on user's balance
   * This can be called directly from the SwapTool to handle precision issues
   *
   * @param tokenAddress The address of the token to adjust
   * @param amount The requested amount
   * @param walletAddress The user's wallet address
   * @param network The blockchain network
   * @returns The adjusted amount that can be safely used
   */
  async adjustAmount(
    tokenAddress: string,
    amount: string,
    walletAddress: string,
    network: NetworkName,
  ): Promise<string> {
    try {
      // Handle edge cases
      if (!amount || amount === '0') return '0';
      if (!tokenAddress || !walletAddress) return amount;

      this.validateNetwork(network);

      // Get token info (including decimals)
      const token = await this.getToken(tokenAddress, network);
      const decimals = token.decimals;

      // Check if it's a native token
      const isNativeToken = this.isNativeToken(tokenAddress);
      const isNativeSolana = this.isNativeSolana(tokenAddress);

      if (isNativeToken || isNativeSolana) {
        // For native tokens, use adjustNativeTokenAmount which handles gas buffer
        return this.adjustNativeTokenAmount(amount, decimals, walletAddress, network);
      } else {
        // For ERC20 tokens, get balance using the cache
        const { formattedBalance } = await this.getTokenBalance(
          tokenAddress,
          walletAddress,
          network,
        );

        // Adjust the amount if needed
        return adjustTokenAmount(amount, formattedBalance, decimals, this.TOLERANCE_PERCENTAGE);
      }
    } catch (error) {
      console.error('Error in adjustAmount:', error);
      // In case of any error, return the original amount
      return amount;
    }
  }

  private isNativeSolana(tokenAddress: string): boolean {
    return (
      tokenAddress.toLowerCase() === SOL_NATIVE_TOKEN_ADDRESS.toLowerCase() ||
      tokenAddress.toLowerCase() === SOL_NATIVE_TOKEN_ADDRESS2.toLowerCase()
    );
  }

  /**
   * Invalidates the balance cache for a specific token and wallet
   * Useful after transactions that change balances
   *
   * @param tokenAddress The address of the token
   * @param walletAddress The address of the wallet
   * @param network The blockchain network
   */
  invalidateBalanceCache(tokenAddress: string, walletAddress: string, network: NetworkName): void {
    this.balanceCache.invalidateBalance(tokenAddress, walletAddress, network);

    // If it's not a native token, also invalidate the native token balance
    // since gas was likely spent
    if (!this.isNativeToken(tokenAddress)) {
      this.balanceCache.invalidateBalance(EVM_NATIVE_TOKEN_ADDRESS, walletAddress, network);
    }
  }

  /**
   * Sets up periodic cleanup of expired cache entries
   * @private
   */
  private setupCacheCleanup(): void {
    // Clean up expired entries every 5 minutes
    const CLEANUP_INTERVAL = 5 * 60 * 1000;

    setInterval(() => {
      try {
        // Clean up token cache
        this.tokenCache.clearExpiredEntries();

        // Clean up balance cache
        this.balanceCache.clearExpiredEntries();

        // Clean up quotes cache
        const now = Date.now();
        for (const [key, value] of this.quotes.entries()) {
          if (now > value.expiresAt) {
            this.quotes.delete(key);
          }
        }
      } catch (error) {
        console.error('Error cleaning up caches:', error);
      }
    }, CLEANUP_INTERVAL);
  }

  async wrapToken(amount: string, tokenAddress: string): Promise<any> {
    // Create interface for wrapped token contract
    const wrapInterface = new Interface(['function deposit() payable returns ()']);

    // Encode the deposit function call
    const data = wrapInterface.encodeFunctionData('deposit');

    // Return transaction object
    return {
      to: tokenAddress,
      data,
      value: parseTokenAmount(amount, EVM_DECIMALS),
      network: NetworkName.BNB,
    };
  }

  async unwrapToken(amount: string, walletAddress: string): Promise<any> {
    // Create interface for wrapped token contract
    const wrapInterface = new Interface(['function withdraw(uint256 wad) returns ()']);

    // Encode the withdraw function call with the amount parameter
    const data = wrapInterface.encodeFunctionData('withdraw', [amount]);

    // Return transaction object
    return {
      to: walletAddress,
      data,
      value: 0, // No ETH value needed for unwrap
      network: NetworkName.BNB,
    };
  }
}
