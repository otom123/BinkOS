import { z } from 'zod';
import {
  BaseTool,
  CustomDynamicStructuredTool,
  ErrorStep,
  IToolConfig,
  ToolProgress,
} from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { ILimitOrderProvider } from './types';

export interface GetLimitOrdersToolConfig extends IToolConfig {
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export class GetLimitOrdersTool extends BaseTool {
  public registry: ProviderRegistry;
  private supportedNetworks: Set<string>;

  constructor(config: GetLimitOrdersToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.supportedNetworks = new Set<string>(config.supportedNetworks || []);
  }

  registerProvider(provider: ILimitOrderProvider): void {
    this.registry.registerProvider(provider);
    console.log('✓ Provider registered', provider.constructor.name);
    // Add provider's supported networks
    provider.getSupportedNetworks().forEach((network: string) => {
      this.supportedNetworks.add(network);
    });
  }

  getName(): string {
    return 'getLimitOrders';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    let description = `The GetLimitOrdersTool allows users to retrieve their pending limit orders across various DEX providers. 
    This tool can fetch all limit orders or filter them by network, token pair, or status. 
    Supported networks include ${networks}. Providers include ${providers}.`;

    // Add provider-specific prompts if they exist
    const providerPrompts = this.registry
      .getProviders()
      .map((provider: any) => {
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
      network: z.enum([
        'bnb',
        'solana',
        'ethereum',
        'arbitrum',
        'base',
        'optimism',
        'polygon',
        'null',
      ]).describe(`The blockchain network to query for limit orders. 
        If set to 'null', orders from all supported networks will be retrieved.`),
      provider: z
        .enum(providers as [string, ...string[]])
        .optional()
        .describe(
          'The DEX provider to use for the swap. If not specified, the best rate will be found',
        ),
    });
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
          const { network, status, provider: preferredProvider } = args;

          console.log('🔄 Retrieving limit orders...');
          console.log('🤖 Args:', args);

          onProgress?.({
            progress: 5,
            message: 'Initializing limit order retrieval...',
          });

          // Determine which networks to query
          let networksToQuery: string[] = [];
          if (network === 'null') {
            networksToQuery = this.getSupportedNetworks();
          } else {
            // Validate the specified network
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
            networksToQuery = [network];
          }

          onProgress?.({
            progress: 20,
            message: 'Validating network and retrieving wallet information...',
          });

          // Get wallet address for each network
          let wallet = this.agent.getWallet();
          let userAddress = await wallet.getAddress(network);

          onProgress?.({
            progress: 35,
            message: 'Selecting appropriate provider for order retrieval...',
          });

          // Initialize selectedProvider with a default provider that supports limit orders
          let selectedProvider: ILimitOrderProvider;

          if (preferredProvider) {
            selectedProvider = this.registry.getProvider(preferredProvider) as ILimitOrderProvider;
          } else {
            // Get the first provider that supports limit orders
            const limitOrderProviders = this.registry
              .getProviders()
              .filter((provider): provider is ILimitOrderProvider => 'getAllOrderIds' in provider);

            if (limitOrderProviders.length === 0) {
              throw this.createError(
                ErrorStep.PROVIDER_VALIDATION,
                `No providers available that support limit orders.`,
                { networks: networksToQuery },
              );
            }

            selectedProvider = limitOrderProviders[0];
          }

          onProgress?.({
            progress: 50,
            message: 'Fetching all order IDs from provider...',
          });

          // Retrieve orders from each network and provider
          const allOrders = await selectedProvider.getAllOrderIds(userAddress);
          console.log('🤖 All orders:', allOrders);

          onProgress?.({
            progress: 70,
            message: `Found ${allOrders.length} orders. Validating each order...`,
          });

          // Validate each order
          let validatedCount = 0;
          const validOrders = await Promise.all(
            allOrders.map(async (orderId, index) => {
              onProgress?.({
                progress: 70 + Math.floor((index / allOrders.length) * 25),
                message: `Validating order ${index + 1}/${allOrders.length}...`,
              });

              const isValid = await selectedProvider.checkValidOrderId(orderId);
              validatedCount += isValid ? 1 : 0;
              return isValid ? orderId : null;
            }),
          ).then(orders => orders.filter(Boolean));

          onProgress?.({
            progress: 95,
            message: 'Finalizing order data...',
          });

          onProgress?.({
            progress: 100,
            message: `Retrieved ${validOrders.length} valid limit orders.`,
          });

          // Return result as JSON string
          return JSON.stringify({
            status: 'success',
            orders: validOrders,
            count: validOrders.length,
            networks: networksToQuery,
          });
        } catch (error: any) {
          console.error('Get limit orders error:', error);

          onProgress?.({
            progress: 100,
            message: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
          });

          return JSON.stringify({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error occurred',
          });
        }
      },
    };
  }
}
