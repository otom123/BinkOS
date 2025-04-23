import { z } from 'zod';
import { BaseTool, CustomDynamicStructuredTool, IToolConfig, ToolProgress } from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { IStakingProvider, StakingBalance, StakingQuote, StakingParams } from './types';

export interface GetBestHighestAPYToolConfig extends IToolConfig {
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export class GetBestHighestAPYTool extends BaseTool {
  public registry: ProviderRegistry;
  private supportedNetworks: Set<string>;

  constructor(config: GetBestHighestAPYToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.supportedNetworks = new Set<string>(config.supportedNetworks || []);
  }

  registerProvider(provider: IStakingProvider): void {
    this.registry.registerProvider(provider);
    console.log('🔌 Provider registered:', provider.getName());
    provider.getSupportedNetworks().forEach(network => {
      this.supportedNetworks.add(network);
    });
  }

  getName(): string {
    return 'get_best_highest_apy';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    return `Get the highest APY for staking a token across all supported networks. Supports networks: ${networks}. Available providers: ${providers}. Use this tool when you need to find the best APY for staking a token.`;
  }

  private getSupportedNetworks(): string[] {
    const agentNetworks = Object.keys(this.agent.getNetworks());
    const providerNetworks = Array.from(this.supportedNetworks);
    return agentNetworks.filter(network => providerNetworks.includes(network));
  }

  mockResponseTool(args: any): Promise<string> {
    let allStakingBalances: { address: string; tokens: StakingBalance[] }[] = [];
    const combinedTokens: StakingBalance[] = [];
    allStakingBalances.forEach(balanceData => {
      if (balanceData.tokens && balanceData.tokens.length > 0) {
        combinedTokens.push(...balanceData.tokens);
      }
    });

    return Promise.resolve(
      JSON.stringify({
        status: 'success',
        data: {
          address: args.address,
          token: combinedTokens,
        },
        network: args.network,
        address: args.address,
      }),
    );
  }

  getSchema(): z.ZodObject<any> {
    const supportedNetworks = this.getSupportedNetworks();
    if (supportedNetworks.length === 0) {
      throw new Error('No supported networks available');
    }

    return z.object({
      address: z
        .string()
        .optional()
        .describe('The wallet address to query (optional - uses agent wallet if not provided)'),
      network: z
        .enum(['bnb', 'solana', 'ethereum'])
        .default('bnb')
        .describe('The blockchain to query the staking balances on.'),
    });
  }

  private async findBestAPY(
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
          console.log('🤖 Quote:', quote);
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

    // Find the best quote based on highest APY
    const best = validQuotes.reduce((best, current) => {
      return current.quote.currentAPY > best.quote.currentAPY ? current : best;
    }, validQuotes[0]);

    return {
      provider: best.provider,
      quote: best.quote,
    };
  }

  createTool(): CustomDynamicStructuredTool {
    console.log('🛠️ Creating staking balance tool');
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
          if (this.agent.isMockResponseTool()) {
            return this.mockResponseTool(args);
          }

          let address = args.address;
          console.log(
            `🔍 Getting staking balances for ${address || 'agent wallet'} on ${args.network}`,
          );

          const stakingParams: StakingParams = {
            network: args.network,
            tokenA: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            amountA: '0.1',
            type: 'stake',
          };
          let selectedProvider: IStakingProvider;
          let quote: StakingQuote;

          // STEP 1: Validate network
          // Validate network is supported
          const supportedNetworks = this.getSupportedNetworks();
          if (!supportedNetworks.includes(args.network)) {
            throw new Error(
              `Network ${args.network} is not supported. Supported networks: ${supportedNetworks.join(', ')}`,
            );
          }
          // STEP 2: Get wallet address
          try {
            // If no address provided, get it from the agent's wallet
            if (!address) {
              console.log('🔑 No address provided, using agent wallet');
              address = await this.agent.getWallet().getAddress(args.network);
              console.log(`🔑 Using agent wallet address: ${address}`);
            }
          } catch (error) {
            console.error(`❌ Failed to get wallet address for network ${args.network}`);
            throw error;
          }

          onProgress?.({
            progress: 50,
            message: `Searching for the best APY for ${address} on ${args.network}.`,
          });

          const bestQuote = await this.findBestAPY(
            {
              ...stakingParams,
              network: args.network,
            },
            address,
          );
          selectedProvider = bestQuote.provider;
          quote = bestQuote.quote;

          return JSON.stringify({
            status: 'success',
            data: { provider: selectedProvider.getName(), highestAPY: quote.currentAPY },
          });
        } catch (error) {
          console.error(
            '❌ Error in staking balance tool:',
            error instanceof Error ? error.message : error,
          );
          return this.handleError(error, args);
        }
      },
    };
  }
}
