import { z } from 'zod';
import {
  BaseTool,
  CustomDynamicStructuredTool,
  IToolConfig,
  ToolProgress,
  ErrorStep,
  StructuredError,
} from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { IWalletProvider, WalletInfo } from './types';

export interface WalletToolConfig extends IToolConfig {
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export function mergeObjects<T extends Record<string, any>>(obj1: T, obj2: T): T {
  // Create a new object to avoid mutating the inputs
  const result = { ...obj1 };

  // Add or override properties from obj2
  for (const key in obj2) {
    if (Object.prototype.hasOwnProperty.call(obj2, key)) {
      // If both objects have the same key and both values are objects, merge recursively
      if (
        key in result &&
        typeof result[key] === 'object' &&
        result[key] !== null &&
        typeof obj2[key] === 'object' &&
        obj2[key] !== null &&
        !Array.isArray(result[key]) &&
        !Array.isArray(obj2[key])
      ) {
        result[key] = mergeObjects(result[key], obj2[key]);
      } else if (obj2[key] === null || obj2[key] === undefined) {
        // Keep obj1's value if obj2's value is null or undefined
        continue;
      } else if (result[key] === null || result[key] === undefined) {
        // Take obj2's value if obj1's value is null or undefined
        result[key] = obj2[key];
      } else {
        // Otherwise just take the value from obj2
        result[key] = obj2[key];
      }
    }
  }

  return result;
}

export class GetWalletBalanceTool extends BaseTool {
  public registry: ProviderRegistry;
  private supportedNetworks: Set<string>;

  constructor(config: WalletToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.supportedNetworks = new Set<string>(config.supportedNetworks || []);
  }

  registerProvider(provider: IWalletProvider): void {
    this.registry.registerProvider(provider);
    console.log('🔌 Provider registered:', provider.constructor.name);
    provider.getSupportedNetworks().forEach(network => {
      this.supportedNetworks.add(network);
    });
  }

  getName(): string {
    return 'get_wallet_balance';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    return `Get detailed information about tokens and native currencies in a wallet of all network (Solana, Etherum, BNB), including token balances, token addresses, symbols, and decimals. Supports networks: ${networks}. Available providers: ${providers}. Use this tool when you need to check what tokens or coins a wallet contains, their balances, and detailed token information.`;
  }

  private getsupportedNetworks(): string[] {
    const agentNetworks = Object.keys(this.agent.getNetworks());
    const providerNetworks = Array.from(this.supportedNetworks);
    return agentNetworks.filter(network => providerNetworks.includes(network));
  }

  getSchema(): z.ZodObject<any> {
    const supportedNetworks = this.getsupportedNetworks();
    if (supportedNetworks.length === 0) {
      throw new Error('No supported networks available');
    }

    return z.object({
      address: z
        .string()
        .optional()
        .describe('The wallet address to query (optional - uses agent wallet if not provided)'),
      network: z
        .enum(['bnb', 'solana', 'ethereum', 'arbitrum', 'base', 'optimism', 'polygon'])
        .describe('The blockchain to query the wallet on.'),
    });
  }

  createTool(): CustomDynamicStructuredTool {
    console.log('🛠️ Creating wallet balance tool');
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
          const network = args.network;
          let address = args.address;
          console.log(`🔍 Getting wallet balance for ${address || 'agent wallet'} on ${network}`);

          // STEP 1: Validate network
          const supportedNetworks = this.getsupportedNetworks();
          if (!supportedNetworks.includes(network)) {
            console.error(`❌ Network ${network} is not supported`);
            throw this.createError(
              ErrorStep.NETWORK_VALIDATION,
              `Network ${network} is not supported.`,
              {
                requestedNetwork: network,
                supportedNetworks: supportedNetworks,
              },
            );
          }

          // STEP 2: Get wallet address
          try {
            // If no address provided, get it from the agent's wallet
            if (!address) {
              console.log('🔑 No address provided, using agent wallet');
              address = await this.agent.getWallet().getAddress(network);
              console.log(`🔑 Using agent wallet address: ${address}`);
            }
          } catch (error) {
            console.error(`❌ Failed to get wallet address for network ${network}`);
            throw error;
          }

          onProgress?.({
            progress: 20,
            message: `Retrieving wallet information for ${address}`,
          });

          // STEP 3: Check providers
          const providers = this.registry.getProvidersByNetwork(network);
          if (providers.length === 0) {
            console.error(`❌ No providers available for network ${network}`);
            throw this.createError(
              ErrorStep.PROVIDER_AVAILABILITY,
              `No providers available for network ${network}.`,
              {
                network: network,
                availableProviders: this.registry.getProviderNames(),
                supportedNetworks: Array.from(this.supportedNetworks),
              },
            );
          }

          console.log(`🔄 Found ${providers.length} providers for network ${network}`);

          let results: WalletInfo = {};
          const errors: Record<string, string> = {};

          // STEP 4: Query providers
          // Try all providers and collect results
          for (const provider of providers) {
            console.log(`🔄 Querying provider: ${provider.getName()}`);
            try {
              const data = await provider.getWalletInfo(address, network);
              console.log(`✅ Successfully got data from ${provider.getName()}`);
              results = mergeObjects(results, data);
            } catch (error) {
              console.warn(
                `⚠️ Failed to get wallet info from ${provider.getName()}: ${error instanceof Error ? error.message : error}`,
              );
              this.logError(
                `Failed to get wallet info from ${provider.getName()}: ${error}`,
                'warn',
              );
              errors[provider.getName()] = error instanceof Error ? error.message : String(error);
            }
          }

          // If no successful results, throw error
          if (Object.keys(results).length === 0) {
            console.error(`❌ All providers failed for ${address}`);
            throw `All providers failed for ${address}`;
          }

          console.log(`💰 Wallet info retrieved successfully for ${address}`);

          if (Object.keys(errors).length > 0) {
            console.warn(`⚠️ Some providers failed but we have partial results`);
          }

          onProgress?.({
            progress: 100,
            message: `Successfully retrieved wallet information for ${address}`,
          });

          console.log(`✅ Returning wallet balance data for ${address}`);

          if (results.tokens && Array.isArray(results.tokens)) {
            results.tokens = results.tokens.filter(token => {
              if (token.symbol === 'BNB' || token.symbol === 'ETH' || token.symbol === 'SOL') {
                return true;
              }
              return Number(token.balance) > 0.00001;
            });
          }

          return JSON.stringify({
            status: 'success',
            data: results,
            errors: Object.keys(errors).length > 0 ? errors : undefined,
            network,
            address,
          });
        } catch (error) {
          console.error(
            '❌ Error in wallet balance tool:',
            error instanceof Error ? error.message : error,
          );
          return this.handleError(error, args);
        }
      },
    };
  }
}
