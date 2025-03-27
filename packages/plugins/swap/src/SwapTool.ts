import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  BaseTool,
  CustomDynamicStructuredTool,
  IToolConfig,
  ToolProgress,
  StructuredError,
  ErrorStep,
  EVM_NATIVE_TOKEN_ADDRESS,
} from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { ISwapProvider, SwapQuote, SwapParams } from './types';
import { validateTokenAddress } from './utils/addressValidation';
import { parseTokenAmount } from './utils/tokenUtils';
import { isSolanaNetwork } from './utils/networkUtils';
import type { TokenInfo } from '@binkai/token-plugin';
import { defaultTokens } from '@binkai/token-plugin';
import { WrapToken } from './types';

export interface SwapToolConfig extends IToolConfig {
  defaultSlippage?: number;
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export class SwapTool extends BaseTool {
  public registry: ProviderRegistry;
  private defaultSlippage: number;
  private supportedNetworks: Set<string>;

  constructor(config: SwapToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.defaultSlippage = config.defaultSlippage || 0.5;
    this.supportedNetworks = new Set<string>(config.supportedNetworks || []);
  }

  registerProvider(provider: ISwapProvider): void {
    this.registry.registerProvider(provider);
    console.log('✓ Provider registered', provider.constructor.name);
    // Add provider's supported networks
    provider.getSupportedNetworks().forEach(network => {
      this.supportedNetworks.add(network);
    });
  }

  getName(): string {
    return 'swap';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    let description = `The SwapTool enables users to exchange one cryptocurrency token for another using various Decentralized Exchange (DEX) 
    providers across supported blockchain networks. This tool facilitates token swaps, 
    allowing users to specify either the input amount (the amount they wish to spend, if amount is percent, must get balance before swap). 
    or the output amount (the amount they wish to receive). Supported networks include ${networks}.
    Do not reasoning about Token information. If user want to do action with token A, you would take actions on token A. 
    Providers include ${providers}.`;

    // Add provider-specific prompts if they exist
    const providerPrompts = this.registry
      .getProviders()
      .map((provider: ISwapProvider) => {
        const prompt = provider.getPrompt?.();
        return prompt ? `${provider.getName()}: ${prompt}` : null;
      })
      .filter((prompt: unknown): prompt is string => !!prompt);

    if (providerPrompts.length > 0) {
      description += '\n\nProvider-specific information:\n' + providerPrompts.join('\n');
    }

    return description;
  }

  private getSupportedNetworks(): string[] {
    // Get networks from agent's wallet
    const agentNetworks = Object.keys(this.agent.getNetworks());

    // Intersect with supported networks from providers
    const providerNetworks = Array.from(this.supportedNetworks);

    // Return intersection of agent networks and provider supported networks
    return agentNetworks.filter(network => providerNetworks.includes(network));
  }

  getSchema(): z.ZodObject<any> {
    const providers = this.registry.getProviderNames();
    if (providers.length === 0) {
      throw new Error('No swap providers registered');
    }

    const supportedNetworks = this.getSupportedNetworks();
    if (supportedNetworks.length === 0) {
      throw new Error('No supported networks available');
    }

    return z.object({
      fromToken: z.string().describe(`The adress of source token on network. (spend)`),
      toToken: z.string().describe(`The adress of destination token on network. (receive)`),
      amount: z.string().describe('The amount of tokens to swap'),
      limitPrice: z.number().optional().describe('The limit price of the order'),
      amountType: z
        .enum(['input', 'output'])
        .describe('Whether the amount is input (spend) or output (receive)'),
      network: z.enum([
        'bnb',
        'solana',
        'ethereum',
        'arbitrum',
        'base',
        'optimism',
        'polygon',
        'null',
      ]).describe(`Determine blockchain network from user input. 
        Priority rules:
          1. Use explicitly mentioned network
          2. Infer from native tokens (ETH→Ethereum, SOL→Solana)
          3. For cross-chain mentions, determine main network
          4. Return null if no network detected`),
      provider: z
        .enum(providers as [string, ...string[]])
        .optional()
        .describe(
          'The DEX provider to use for the swap. If not specified, the best rate will be found',
        ),
      slippage: z
        .number()
        .optional()
        .describe(`Maximum slippage percentage allowed (default: ${this.defaultSlippage})`),
    });
  }

  private async findBestQuote(
    params: SwapParams & { network: string },
    userAddress: string,
  ): Promise<{ provider: ISwapProvider; quote: SwapQuote }> {
    // Validate network is supported
    const providers = this.registry.getProvidersByNetwork(params.network);
    if (providers.length === 0) {
      throw new Error(`No providers available for network ${params.network}`);
    }

    const quotes = await Promise.all(
      providers.map(async (provider: ISwapProvider) => {
        try {
          console.log('🤖 Getting quote from', provider.getName());
          const quote = await provider.getQuote(params, userAddress);
          return { provider, quote };
        } catch (error: any) {
          console.warn(`Failed to get quote from ${provider.getName()}:`, error);
          return null;
        }
      }),
    );

    type QuoteResult = { provider: ISwapProvider; quote: SwapQuote };
    const validQuotes = quotes.filter((q): q is QuoteResult => q !== null);
    if (validQuotes.length === 0) {
      throw new Error('No valid quotes found');
    }

    // Find the best quote based on amount type
    return validQuotes.reduce((best: QuoteResult, current: QuoteResult) => {
      if (params.type === 'input') {
        // For input amount, find highest output amount
        const bestAmount = BigInt(Number(best.quote.toAmount) * 10 ** best.quote.toToken.decimals);
        const currentAmount = BigInt(
          Number(current.quote.toAmount) * 10 ** current.quote.toToken.decimals,
        );
        return currentAmount > bestAmount ? current : best;
      } else {
        // For output amount, find lowest input amount
        const bestAmount = BigInt(
          Number(best.quote.fromAmount) * 10 ** best.quote.fromToken.decimals,
        );
        const currentAmount = BigInt(
          Number(current.quote.fromAmount) * 10 ** current.quote.fromToken.decimals,
        );
        return currentAmount < bestAmount ? current : best;
      }
    }, validQuotes[0]);
  }

  createTool(): CustomDynamicStructuredTool {
    console.log('✓ Creating tool', this.getName());
    return {
      name: this.getName(),
      description: this.getDescription(),
      schema: this.getSchema(),
      func: async (
        args: any,
        runManager?: any,
        config?: any,
        onProgress?: (data: ToolProgress) => void,
      ) => {
        try {
          const {
            fromToken,
            toToken,
            amount,
            amountType,
            network,
            provider: preferredProvider,
            slippage = this.defaultSlippage,
            limitPrice,
          } = args;

          console.log('🔄 Doing swap operation...');
          console.log('🤖 Swap Args:', args);

          // STEP 1: Validate network
          const supportedNetworks = this.getSupportedNetworks();
          if (!supportedNetworks.includes(network)) {
            throw this.createError(
              ErrorStep.NETWORK_VALIDATION,
              `Network ${network} is not supported.`,
              {
                requestedNetwork: network,
                supportedNetworks: supportedNetworks,
              },
            );
          }

          // STEP 2: Validate token addresses
          if (!validateTokenAddress(fromToken, network)) {
            throw this.createError(
              ErrorStep.TOKEN_NOT_FOUND,
              `Invalid fromToken address for network ${network}: ${fromToken}`,
              {
                token: fromToken,
                network: network,
                tokenType: 'fromToken',
              },
            );
          }

          if (!validateTokenAddress(toToken, network)) {
            throw this.createError(
              ErrorStep.TOKEN_NOT_FOUND,
              `Invalid toToken address for network ${network}: ${toToken}`,
              {
                token: toToken,
                network: network,
                tokenType: 'toToken',
              },
            );
          }

          // STEP 3: Get wallet address
          let userAddress;
          try {
            // Get agent's wallet and address
            const wallet = this.agent.getWallet();
            userAddress = await wallet.getAddress(network);
          } catch (error: any) {
            throw error;
          }

          const swapParams: SwapParams = {
            network,
            fromToken,
            toToken,
            amount,
            type: amountType,
            slippage,
            limitPrice,
          };

          let selectedProvider: ISwapProvider;
          let quote: SwapQuote;
          let isWrapToken = false;

          onProgress?.({
            progress: 0,
            message: 'Searching for the best exchange rate for your swap.',
          });

          // STEP 4: Get provider and quote
          try {
            if (preferredProvider) {
              selectedProvider = this.registry.getProvider(preferredProvider);

              // Validate provider supports the network
              if (!selectedProvider.getSupportedNetworks().includes(network)) {
                throw this.createError(
                  ErrorStep.PROVIDER_VALIDATION,
                  `Provider ${preferredProvider} does not support network ${network}.`,
                  {
                    provider: preferredProvider,
                    requestedNetwork: network,
                    providerSupportedNetworks: selectedProvider.getSupportedNetworks(),
                  },
                );
              }

              // STEP 5: Handle wrapped token BNB
              // validate is valid limit order
              if (swapParams?.limitPrice && swapParams.fromToken === EVM_NATIVE_TOKEN_ADDRESS) {
                onProgress?.({
                  progress: 5,
                  message: `Wrapping BNB to WBNB`,
                });

                const wrapTx = await selectedProvider.wrapToken(amount.toString(), WrapToken.WBNB);

                const wallet = this.agent.getWallet();
                const wrapReceipt = await wallet.signAndSendTransaction(network, {
                  to: wrapTx.to,
                  data: wrapTx.data,
                  value: BigInt(wrapTx.value),
                });

                // Wait for approval to be mined
                const wrapResult = await wrapReceipt.wait();

                if (!wrapResult?.hash) {
                  throw new Error(`Failed to wrap BNB to WBNB`);
                }
                // set wrap token address
                swapParams.fromToken = WrapToken.WBNB;
                isWrapToken = true;

                onProgress?.({
                  progress: 8,
                  message: `Successfully wrapped BNB to WBNB`,
                });
              }

              try {
                quote = await selectedProvider.getQuote(swapParams, userAddress);
              } catch (error: any) {
                throw error;
              }
            } else {
              try {
                const bestQuote = await this.findBestQuote(
                  {
                    ...swapParams,
                    network,
                  },
                  userAddress,
                );
                selectedProvider = bestQuote.provider;
                quote = bestQuote.quote;
              } catch (error: any) {
                throw error;
              }
            }
          } catch (error: any) {

            console.warn(`Failed to get quote:`, error);
            throw error;
          }

          console.log('🤖 The selected provider is:', selectedProvider.getName());

          onProgress?.({
            progress: 10,
            message: `Verifying you have sufficient ${quote.fromToken.symbol || 'tokens'} for this swap.`,
          });

          // STEP 5: Check balance
          try {
            const balanceCheck = await selectedProvider.checkBalance(quote, userAddress);
            if (!balanceCheck.isValid) {
              throw 'Not valid checking balance';
            }
          } catch (error: any) {
            throw error; // Re-throw structured errors
          }


          onProgress?.({
            progress: 20,
            message: `Preparing to swap ${quote.fromAmount} ${quote.fromToken.symbol || 'tokens'} for approximately ${quote.toAmount} ${quote.toToken.symbol || 'tokens'} via ${selectedProvider.getName()}.`,
          });

          // STEP 6: Build swap transaction
          let swapTx;
          try {
            swapTx = await selectedProvider.buildSwapTransaction(quote, userAddress);
          } catch (error: any) {
            throw error;
          }

          onProgress?.({
            progress: 40,
            message: `Checking allowance... Verifying if approval is needed for ${selectedProvider.getName()} to access your ${quote.fromToken.symbol || 'tokens'}.`,
          });

          // STEP 7: Handle token approval (for EVM chains)
          if (!isSolanaNetwork(network)) {
            try {
              // Check if approval is needed and handle it
              const allowance = await selectedProvider.checkAllowance(
                network,
                quote.fromToken.address,
                userAddress,
                swapTx.spender,
              );

              const requiredAmount = parseTokenAmount(quote.fromAmount, quote.fromToken.decimals);

              console.log('🤖 Allowance: ', allowance, ' Required amount: ', requiredAmount);

              if (allowance < requiredAmount) {
                try {
                  const approveTx = await selectedProvider.buildApproveTransaction(
                    network,
                    quote.fromToken.address,
                    swapTx.spender,
                    quote.fromAmount,
                    userAddress,
                  );

                  // Sign and send approval transaction
                  onProgress?.({
                    progress: 60,
                    message: `Approving ${selectedProvider.getName()} to access your ${quote.fromToken.symbol || 'tokens'}`,
                  });

                  const wallet = this.agent.getWallet();
                  const approveReceipt = await wallet.signAndSendTransaction(network, {
                    to: approveTx.to,
                    data: approveTx.data,
                    value: BigInt(approveTx.value),
                  });

                  console.log('🤖 ApproveReceipt:', approveReceipt);

                  // Wait for approval to be mined
                  await approveReceipt.wait();
                } catch (error: any) {
                  throw error;
                }
              }
            } catch (error: any) {
              throw error; // Re-throw structured errors
            }
          }

          console.log('🤖 Swapping...');

          onProgress?.({
            progress: 80,
            message: `Swapping ${quote.fromAmount} ${quote.fromToken.symbol || 'tokens'} for approximately ${quote.toAmount} ${quote.toToken.symbol || 'tokens'} with ${slippage}% max slippage.`,
          });

          // STEP 8: Execute swap transaction
          let receipt;
          let finalReceipt;
          try {
            // Sign and send swap transaction
            const wallet = this.agent.getWallet();
            receipt = await wallet.signAndSendTransaction(network, {
              to: swapTx.to,
              data: swapTx.data,
              value: BigInt(swapTx.value),
              lastValidBlockHeight: swapTx.lastValidBlockHeight,
            });

            // Wait for transaction to be mined
            finalReceipt = await receipt?.wait();
          } catch (error: any) {
            throw error;
          }

          // STEP 9: unwrap token if needed
          // if (swapParams?.limitPrice && swapParams.fromToken === WrapToken.WBNB && isWrapToken) {
          //   const wallet = this.agent.getWallet();
          //   userAddress = await wallet.getAddress(network);
          //   onProgress?.({
          //     progress: 90,
          //     message: `Unwrapping WBNB to BNB`,
          //   });

          //   const unwrapTx = await selectedProvider.unwrapToken(amount.toString(), userAddress);

          //   const unwrapReceipt = await wallet.signAndSendTransaction(network, {
          //     to: WrapToken.WBNB,
          //     data: unwrapTx.data,
          //     value: BigInt(0),
          //     gasLimit: unwrapTx?.gasLimit || '85000',
          //   });

          //   // Wait for approval to be mined
          //   const unwraptxh = await unwrapReceipt.wait();
          //   if (unwraptxh?.hash) {
          //     onProgress?.({
          //       progress: 95,
          //       message: `Successfully unwrapped WBNB to BNB. Transaction hash: ${unwraptxh?.hash}`,
          //     });
          //   }
          // }

          try {
            // Clear token balance caches after successful swap
            selectedProvider.invalidateBalanceCache(quote.fromToken.address, userAddress, network);
            selectedProvider.invalidateBalanceCache(quote.toToken.address, userAddress, network);
          } catch (error: any) {
            console.error('Error clearing token balance caches:', error);
            // Non-critical error, don't throw
            
          }

          onProgress?.({
            progress: 100,
            message: `Swap complete! Successfully swapped ${quote.fromAmount} ${quote.fromToken.symbol || 'tokens'} for ${quote.toAmount} ${quote.toToken.symbol || 'tokens'} via ${selectedProvider.getName()}. Transaction hash: ${finalReceipt.hash}`,
          });

          // Return result as JSON string
          return JSON.stringify({
            status: 'success',
            provider: selectedProvider.getName(),
            fromToken: quote.fromToken,
            toToken: quote.toToken,
            fromAmount: quote.fromAmount.toString(),
            toAmount: quote.toAmount.toString(),
            transactionHash: finalReceipt?.hash || '',
            priceImpact: quote.priceImpact,
            type: quote.type,
            network,
          });
        } catch (error: any) {
          console.error('Swap error:', error);

          // Special handling for token validation errors that we can try to fix
          if (
            error instanceof Error ||
            (typeof error === 'object' && error !== null && 'step' in error)
          ) {
            const errorStep = 'step' in error ? error.step : '';
            const isTokenValidationError =
              errorStep === 'token_validation' ||
              errorStep === ErrorStep.TOKEN_NOT_FOUND ||
              error.message?.includes('Invalid fromToken address') ||
              error.message?.includes('Invalid toToken address');

            if (isTokenValidationError && !args._attempt) {
              return await this.attemptTokenAddressFix(args, error);
            }
          }

          // Use BaseTool's error handling
          return this.handleError(error, args);
        }
      },
    };
  }

  // Helper method to attempt fixing token addresses
  private async attemptTokenAddressFix(args: any, error: any): Promise<string> {
    console.log('🔍 Fixing token addresses in Swap...');

    // Determine which token has the error
    const isFromTokenAddressError =
      error.message?.includes('Invalid fromToken address') ||
      error.details?.tokenType === 'fromToken';
    const isToTokenAddressError =
      error.message?.includes('Invalid toToken address') || error.details?.tokenType === 'toToken';

    // Add type assertion for args.network to match the NetworkName type
    const tokenInfos = defaultTokens[args.network as keyof typeof defaultTokens] as
      | Record<string, TokenInfo>
      | undefined;

    // Add null check for tokenInfos
    if (!tokenInfos) {
      console.log(`❌ No token information found for network ${args.network}`);
      return this.handleError(
        this.createError(
          ErrorStep.TOKEN_NOT_FOUND,
          `No token information found for network ${args.network}`,
          { network: args.network },
        ),
        args,
      );
    }

    let updatedArgs = { ...args, _attempt: true };
    let foundCorrectAddress = false;

    // Attempt to fix token addresses
    if (isFromTokenAddressError) {
      for (const [address, tokenInfo] of Object.entries(tokenInfos) as [string, TokenInfo][]) {
        if (tokenInfo.symbol.toLowerCase() === args.fromToken.toLowerCase()) {
          console.log(`🔍 Found correct address for ${args.fromToken}: ${address}`);
          updatedArgs.fromToken = address;
          foundCorrectAddress = true;
          break;
        }
      }
    }

    if (isToTokenAddressError) {
      for (const [address, tokenInfo] of Object.entries(tokenInfos) as [string, TokenInfo][]) {
        if (tokenInfo.symbol.toLowerCase() === args.toToken.toLowerCase()) {
          console.log(`🔍 Found correct address for ${args.toToken}: ${address}`);
          updatedArgs.toToken = address;
          foundCorrectAddress = true;
          break;
        }
      }
    }

    // Retry the operation with corrected addresses if found
    if (foundCorrectAddress) {
      console.log('🔄 Retrying with corrected token address...');
      try {
        const result = await this.createTool().func(updatedArgs);
        return result;
      } catch (retryError) {
        console.error('Error during retry:', retryError);
        return this.handleError(
          this.createError(
            ErrorStep.TOKEN_NOT_FOUND,
            `We attempted to correct the token address but the swap still failed.`,
            {
              error: retryError instanceof Error ? retryError.message : String(retryError),
              originalArgs: args,
              correctedArgs: updatedArgs,
            },
          ),
          updatedArgs,
        );
      }
    } else {
      // If we couldn't find a matching token symbol
      return this.handleError(
        this.createError(
          ErrorStep.TOKEN_NOT_FOUND,
          `Could not find a valid address for the token symbol.`,
          {
            network: args.network,
            fromToken: args.fromToken,
            toToken: args.toToken,
          },
        ),
        args,
      );
    }
  }
}
