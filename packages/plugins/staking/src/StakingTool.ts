import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { BaseTool, CustomDynamicStructuredTool, IToolConfig } from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { IStakingProvider, StakingQuote, StakingParams } from './types';
import { validateTokenAddress } from './utils/addressValidation';
export interface StakingToolConfig extends IToolConfig {
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export class StakingTool extends BaseTool {
  public registry: ProviderRegistry;
  private defaultNetwork: string;
  private supportedNetworks: Set<string>;

  constructor(config: StakingToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.defaultNetwork = config.defaultNetwork || 'bnb';
    this.supportedNetworks = new Set<string>(config.supportedNetworks || []);
  }

  registerProvider(provider: IStakingProvider): void {
    this.registry.registerProvider(provider);
    console.log('✓ Provider registered', provider.constructor.name);
    // Add provider's supported networks
    provider.getSupportedNetworks().forEach(network => {
      this.supportedNetworks.add(network);
    });
  }

  getName(): string {
    return 'staking';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    let description = `Swap tokens using various DEX providers (${providers}). Supports networks: ${networks}. You can specify either input amount (how much to spend) or output amount (how much to receive).`;

    // Add provider-specific prompts if they exist
    const providerPrompts = this.registry
      .getProviders()
      .map((provider: IStakingProvider) => {
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
      fromToken: z.string().describe('The token address staking from'),
      toToken: z.string().describe('The token address staking to'),
      amount: z.string().describe('The amount of tokens to staking'),
      type: z
        .enum(['supply', 'withdraw', 'stake', 'unstake'])
        .describe('The type of staking operation to perform'),
      network: z
        .enum(supportedNetworks as [string, ...string[]])
        .default(this.defaultNetwork)
        .describe('The blockchain network to execute the staking on'),
      provider: z
        .enum(providers as [string, ...string[]])
        .optional()
        .describe(
          'The staking provider to use for the staking. If not specified, the best rate will be found',
        ),
    });
  }

  private async findBestQuote(
    params: StakingParams & { network: string },
    userAddress: string,
  ): Promise<{ provider: IStakingProvider; quote: StakingQuote }> {
    // Validate network is supported
    const providers = this.registry.getProvidersByNetwork(params.network);
    if (providers.length === 0) {
      throw new Error(`No providers available for network ${params.network}`);
    }

    const quotes = await Promise.all(
      providers.map(async (provider: IStakingProvider) => {
        try {
          console.log('🤖 Getting quote from', provider.getName());
          const quote = await provider.getQuote(params, userAddress);
          return { provider, quote };
        } catch (error) {
          console.warn(`Failed to get quote from ${provider.getName()}:`, error);
          return null;
        }
      }),
    );

    type QuoteResult = { provider: IStakingProvider; quote: StakingQuote };
    const validQuotes = quotes.filter((q): q is QuoteResult => q !== null);
    if (validQuotes.length === 0) {
      throw new Error('No valid quotes found');
    }

    // Find the best quote based on amount type
    return validQuotes.reduce((best: QuoteResult, current: QuoteResult) => {
      if (params.type === 'supply' || params.type === 'stake') {
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
      func: async (args: any) => {
        try {
          const {
            fromToken,
            toToken,
            amount,
            type,
            network = this.defaultNetwork,
            provider: preferredProvider,
          } = args;

          console.log('🤖 Staking Args:', args);

          // Validate token addresses
          if (!validateTokenAddress(fromToken, network)) {
            throw new Error(`Invalid fromToken address for network ${network}: ${fromToken}`);
          }
          if (!validateTokenAddress(toToken, network)) {
            throw new Error(`Invalid toToken address for network ${network}: ${toToken}`);
          }

          // Get agent's wallet and address
          const wallet = this.agent.getWallet();
          const userAddress = await wallet.getAddress(network);

          // Validate network is supported
          const supportedNetworks = this.getSupportedNetworks();
          if (!supportedNetworks.includes(network)) {
            throw new Error(
              `Network ${network} is not supported. Supported networks: ${supportedNetworks.join(', ')}`,
            );
          }

          const stakingParams: StakingParams = {
            network,
            fromToken,
            toToken,
            amount,
            type,
          };

          let selectedProvider: IStakingProvider;
          let quote: StakingQuote;

          if (preferredProvider) {
            try {
              selectedProvider = this.registry.getProvider(preferredProvider);
              // Validate provider supports the network
              if (!selectedProvider.getSupportedNetworks().includes(network)) {
                throw new Error(
                  `Provider ${preferredProvider} does not support network ${network}`,
                );
              }
              quote = await selectedProvider.getQuote(stakingParams, userAddress);
            } catch (error) {
              console.warn(
                `Failed to get quote from preferred provider ${preferredProvider}:`,
                error,
              );
              console.log('🔄 Falling back to checking all providers for best quote...');
              const bestQuote = await this.findBestQuote(
                {
                  ...stakingParams,
                  network,
                },
                userAddress,
              );
              selectedProvider = bestQuote.provider;
              quote = bestQuote.quote;
            }
          } else {
            const bestQuote = await this.findBestQuote(
              {
                ...stakingParams,
                network,
              },
              userAddress,
            );
            selectedProvider = bestQuote.provider;
            quote = bestQuote.quote;
          }

          console.log('🤖 The selected provider is:', selectedProvider.getName());

          // Check user's balance before proceeding
          const balanceCheck = await selectedProvider.checkBalance(quote, userAddress);

          if (!balanceCheck.isValid) {
            throw new Error(balanceCheck.message || 'Insufficient balance for staking');
          }

          // Build staking transaction
          const stakingTx = await selectedProvider.buildStakingTransaction(quote, userAddress);

          // Check if approval is needed and handle it
          const allowance = await selectedProvider.checkAllowance(
            network,
            quote.fromToken.address,
            userAddress,
            stakingTx.to,
          );

          const requiredAmount = BigInt(Number(quote.fromAmount) * 10 ** quote.fromToken.decimals);

          console.log('🤖 Allowance: ', allowance, ' Required amount: ', requiredAmount);

          if (allowance < requiredAmount) {
            const approveTx = await selectedProvider.buildApproveTransaction(
              network,
              quote.fromToken.address,
              stakingTx.to,
              quote.fromAmount,
              userAddress,
            );
            console.log('🤖 Approving...');
            // Sign and send approval transaction
            const approveReceipt = await wallet.signAndSendTransaction(network, {
              to: approveTx.to,
              data: approveTx.data,
              value: BigInt(approveTx.value),
            });

            console.log('🤖 ApproveReceipt:', approveReceipt);

            // Wait for approval to be mined
            await approveReceipt.wait();
          }
          console.log('🤖 Staking...');

          // Sign and send Staking transaction
          const receipt = await wallet.signAndSendTransaction(network, {
            to: stakingTx.to,
            data: stakingTx.data,
            value: BigInt(stakingTx.value),
          });
          // Wait for transaction to be mined
          const finalReceipt = await receipt.wait();

          // Return result as JSON string
          return JSON.stringify({
            provider: selectedProvider.getName(),
            fromToken: quote.fromToken,
            toToken: quote.toToken,
            fromAmount: quote.fromAmount.toString(),
            toAmount: quote.toAmount.toString(),
            transactionHash: finalReceipt.hash,
            type: quote.type,
            network,
          });
        } catch (error) {
          console.error('Staking error:', error);
          return JSON.stringify({
            status: 'error',
            message: error,
          });
        }
      },
    };
  }
}
