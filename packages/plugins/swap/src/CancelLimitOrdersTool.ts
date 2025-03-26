import { z } from 'zod';
import {
  BaseTool,
  CustomDynamicStructuredTool,
  ErrorStep,
  IToolConfig,
  ToolProgress,
} from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { ILimitOrderProvider, WrapToken } from './types';

export interface CancelLimitOrdersToolConfig extends IToolConfig {
  defaultNetwork?: string;
  supportedNetworks?: string[];
}

export class CancelLimitOrdersTool extends BaseTool {
  public registry: ProviderRegistry;
  private supportedNetworks: Set<string>;

  constructor(config: CancelLimitOrdersToolConfig) {
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
    return 'cancelLimitOrders';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    let description = `The CancelLimitOrdersTool allows users to cancel their pending limit orders across various DEX providers. 
    This tool can cancel specific limit orders by order ID or cancel all pending orders.
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
      network: z
        .enum(['bnb', 'solana', 'ethereum', 'arbitrum', 'base', 'optimism', 'polygon', 'null'])
        .describe(
          `The blockchain network where the limit orders to cancel are located. 
        If set to 'null', orders from all supported networks will be considered.`,
        )
        .default('bnb'),
      orderId: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'The specific order ID(s) to cancel. Can be a single order ID or an array of order IDs. If not provided, all pending orders will be canceled.',
        ),
      provider: z
        .enum(providers as [string, ...string[]])
        .optional()
        .default('thena')
        .describe(
          'The DEX provider to use for canceling the order. If not specified, the first available provider will be used.',
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
          const { network, orderId, provider: preferredProvider } = args;

          console.log('🔄 Canceling limit orders...');
          console.log('🤖 Args:', args);

          onProgress?.({
            progress: 5,
            message: 'Initializing order cancellation process...',
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
            progress: 15,
            message: 'Validating network and retrieving wallet information...',
          });

          // Get wallet address for each network
          let wallet = this.agent.getWallet();
          let userAddress = await wallet.getAddress(network);

          onProgress?.({
            progress: 25,
            message: 'Selecting appropriate provider for your orders...',
          });

          // Initialize selectedProvider with a default provider that supports canceling limit orders
          let selectedProvider: ILimitOrderProvider;

          if (preferredProvider) {
            selectedProvider = this.registry.getProvider(preferredProvider) as ILimitOrderProvider;
          } else {
            // Get the first provider that supports canceling limit orders
            const cancelOrderProviders = this.registry
              .getProviders()
              .filter((provider): provider is ILimitOrderProvider => 'cancelOrder' in provider);

            if (cancelOrderProviders.length === 0) {
              throw this.createError(
                ErrorStep.PROVIDER_VALIDATION,
                `No providers available that support canceling limit orders.`,
                { networks: networksToQuery },
              );
            }

            selectedProvider = cancelOrderProviders[0];
          }

          onProgress?.({
            progress: 40,
            message: orderId
              ? `Preparing to cancel ${Array.isArray(orderId) ? orderId.length : 1} specific order(s)...`
              : 'Preparing to cancel all your pending orders...',
          });

          // Cancel specific order(s) or all orders
          let result: any;
          if (orderId) {
            // Handle both single order ID and array of order IDs
            const orderIds = Array.isArray(orderId) ? orderId : [orderId];

            // Cancel each specified order
            const cancelResults: any[] = [];
            for (let i = 0; i < orderIds.length; i++) {
              const id = orderIds[i];

              onProgress?.({
                progress: 40 + Math.floor((i / orderIds.length) * 40),
                message: `Canceling order ${id} (${i + 1}/${orderIds.length})...`,
              });

              //convert id to number
              const cancelResult: any = await selectedProvider.cancelOrder(Number(id));
              if (!cancelResult?.tx) {
                throw new Error(`Failed to cancel order ${id}`);
              }

              const statusOrderId: any = await selectedProvider.getStatusOrderId(Number(id));

              onProgress?.({
                progress: 80 + Math.floor((i / orderIds.length) * 10),
                message: `Signing transaction for order ${id}...`,
              });

              const { tx, to } = cancelResult;
              const cancelReceipt = await wallet.signAndSendTransaction(network, {
                to: to,
                data: tx as any,
                value: 0n,
              });

              onProgress?.({
                progress: 90 + Math.floor((i / orderIds.length) * 5),
                message: `Confirming transaction for order ${id}...`,
              });

              await cancelReceipt.wait();

              onProgress?.({
                progress: 95,
                message: `Unwrapping WBNB to BNB...`,
              });

              //unwrap token if needed
              userAddress = await wallet.getAddress(network);
              const amount = statusOrderId[6][4];
              const unwrapTx = await selectedProvider.unwrapToken(amount, userAddress);

              const unwrapReceipt = await wallet.signAndSendTransaction(network, {
                to: WrapToken.WBNB,
                data: unwrapTx.data,
                value: BigInt(0),
                gasLimit: unwrapTx?.gasLimit || '85000',
              });

              // Wait for approval to be mined
              const unwraptxh = await unwrapReceipt.wait();
              if (unwraptxh?.hash) {
                onProgress?.({
                  progress: 97,
                  message: `Successfully unwrapped WBNB to BNB`,
                });
              }

              cancelResults.push({
                orderId: id,
                success: true,
                message: 'Order canceled successfully',
              });
            }

            result = {
              success: cancelResults.every(r => r.success),
              message: `Canceled ${cancelResults.filter(r => r.success).length} of ${orderIds.length} orders`,
              details: cancelResults,
            };
          }

          onProgress?.({
            progress: 99,
            message: 'Finalizing cancellation process...',
          });

          onProgress?.({
            progress: 100,
            message: 'Order cancellation completed successfully!',
          });

          // Return result as JSON string
          return JSON.stringify({
            status: 'success',
            message: 'Successfully canceled orders.',
            details: result?.details || {},
            network: network,
          });
        } catch (error: any) {
          onProgress?.({
            progress: 100,
            message: `Error: ${error instanceof Error ? error.message : 'An unexpected error occurred'}`,
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
