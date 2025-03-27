import { z } from 'zod';
import {
  BaseTool,
  CustomDynamicStructuredTool,
  ErrorStep,
  IToolConfig,
  NetworkName,
  ToolProgress,
} from '@binkai/core';
import { ProviderRegistry } from './ProviderRegistry';
import { CreateTokenParams, ITokenProvider, TokenInfo } from './types';
import { DefaultTokenProvider } from './providers/DefaultTokenProvider';
import { defaultTokens } from './data/defaultTokens';

export interface CreateTokenToolConfig extends IToolConfig {
  supportedNetworks?: NetworkName[];
}

export class CreateTokenTool extends BaseTool {
  public registry: ProviderRegistry;
  private supportedNetworks: Set<NetworkName>;
  private defaultTokenProvider: DefaultTokenProvider;
  // Cache for token information to avoid modifying default tokens
  private tokenCache: Partial<Record<NetworkName, Record<string, TokenInfo>>> = {};

  constructor(config: CreateTokenToolConfig) {
    super(config);
    this.registry = new ProviderRegistry();
    this.supportedNetworks = new Set<NetworkName>(config.supportedNetworks || []);

    // Initialize default token provider
    this.defaultTokenProvider = new DefaultTokenProvider();

    // Register the default token provider first
    this.registerProvider(this.defaultTokenProvider);
    console.log(
      '✓ Default token provider registered with',
      Object.keys(defaultTokens).length,
      'networks and',
      Object.values(defaultTokens).reduce((acc, tokens) => acc + Object.keys(tokens).length, 0),
      'tokens',
    );

    // Initialize token cache for each network
    this.defaultTokenProvider.getSupportedNetworks().forEach(network => {
      this.tokenCache[network] = {};
    });
  }

  registerProvider(provider: ITokenProvider): void {
    this.registry.registerProvider(provider);
    console.log('✓ Provider registered CreateTokenTool', provider.constructor.name);
    // Add provider's supported networks
    provider.getSupportedNetworks().forEach(network => {
      this.supportedNetworks.add(network);
      // Initialize token cache for this network if it doesn't exist
      if (!this.tokenCache[network]) {
        this.tokenCache[network] = {};
      }
    });
  }

  getName(): string {
    return 'create_token';
  }

  getDescription(): string {
    const providers = this.registry.getProviderNames().join(', ');
    const networks = Array.from(this.supportedNetworks).join(', ');
    return `Create token blockchain with name, symbol, description using various providers (${providers}). Supports networks: ${networks}.`;
  }

  private getSupportedNetworks(): NetworkName[] {
    // Get networks from agent's wallet
    const agentNetworks = Object.keys(this.agent.getNetworks()) as NetworkName[];

    // Intersect with supported networks from providers
    const providerNetworks = Array.from(this.supportedNetworks);

    // Return intersection of agent networks and provider supported networks
    return agentNetworks.filter(network => providerNetworks.includes(network));
  }

  getSchema(): z.ZodObject<any> {
    const providers = this.registry.getProviderNames();
    if (providers.length === 0) {
      throw new Error('No token providers registered');
    }

    const supportedNetworks = this.getSupportedNetworks();
    if (supportedNetworks.length === 0) {
      throw new Error('No supported networks available');
    }

    return z.object({
      name: z.string().describe('The name of token created'),
      symbol: z.string().describe('The symbol of token created'),
      description: z.string().describe('Description of token created'),
      network: z
        .enum(['bnb'])
        .default(NetworkName.BNB)
        .describe('The network to create the token on'),
      provider: z
        .enum(['four-meme'])
        .default('four-meme')
        .describe('The DEX provider to use for the create token.'),
      img: z.string().optional().describe('The logo image to use for the create token.'),
      amount: z
        .string()
        .optional()
        .describe('Small amount to buy coins helps protect your coin from snipers.'),
    });
  }

  createTool(): CustomDynamicStructuredTool {
    console.log('🛠️ Creating create token tool');
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
            name,
            symbol,
            description,
            img,
            network,
            amount,
            provider: preferredProvider,
          } = args;
          console.log('🤖 Create token Args:', args);

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

          // STEP 2: Get wallet address
          let userAddress;
          try {
            // Get agent's wallet and address
            const wallet = this.agent.getWallet();
            userAddress = await wallet.getAddress(network);
          } catch (error: any) {
            throw error;
          }

          const createTokenParams: CreateTokenParams = {
            name,
            symbol,
            description,
            network,
            img,
            amount,
          };

          let selectedProvider: any;
          let signature: string;

          onProgress?.({
            progress: 20,
            message: 'Searching for best provider to create token',
          });
          // STEP 3: Get provider
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
            } else {
              const providers = this.registry.getProvidersByNetwork(network);
              console.log('🤖 Providers:', providers);
              selectedProvider = providers[1];
            }
          } catch (error: any) {
            if ('step' in error) {
              throw error; // Re-throw structured errors
            }
          }
          onProgress?.({
            progress: 40,
            message: `Signing message with symbol ${args.symbol}`,
          });
          // STEP 4: Get provider
          try {
            const signatureMessage = await selectedProvider.buildSignatureMessage(userAddress);
            const wallet = this.agent.getWallet();
            signature = await wallet.signMessage({
              network,
              message: signatureMessage,
            });
          } catch (error: any) {
            throw error;
          }
          onProgress?.({
            progress: 60,
            message: `Building create transaction with symbol ${args.symbol}`,
          });
          // STEP 5: Build create transaction
          let tx;
          let accessToken;
          try {
            accessToken = await selectedProvider.getAccessToken(signature, userAddress, network);
            tx = await selectedProvider.buildCreateToken(
              createTokenParams,
              userAddress,
              accessToken,
              signature,
            );
            console.log('🤖 Create Tx:', tx);
          } catch (error: any) {
            throw error;
          }

          onProgress?.({
            progress: 80,
            message: `Creating ${args.name} token with symbol ${args.symbol}`,
          });
          // STEP 6: Execute create transaction
          let receipt;
          let finalReceipt;
          try {
            // Sign and send create transaction
            const wallet = this.agent.getWallet();
            receipt = await wallet.signAndSendTransaction(network, {
              to: tx?.tx?.to,
              data: tx?.tx?.data,
              value: BigInt(tx?.tx?.value || 0),
            });

            // Wait for transaction to be mined
            finalReceipt = await receipt?.wait();
          } catch (error: any) {
            throw error;
          }

          // STEP 7: Get token info
          onProgress?.({
            progress: 90,
            message: `Getting token address for ${args.name} with symbol ${args.symbol}`,
          });

          let token = { ...tx.token };

          if (tx.token.id && selectedProvider.getName() === 'four-meme') {
            try {
              // Wait for 25 seconds before fetching token info
              // await new Promise(resolve => setTimeout(resolve, 25000));

              // For Four Meme tokens, get the token address using the token ID
              const fourMemeProvider = selectedProvider as any;
              //const tokenInfo = await fourMemeProvider.getTokenInfoById(tx.token.id, accessToken);

              // parse transaction create token
              const tokenAddress = await fourMemeProvider.parseTransactionCreateToken(
                finalReceipt?.hash,
              );

              if (tokenAddress) {
                token.address = tokenAddress;
                token.link = tokenAddress ? `https://four.meme/token/${tokenAddress}` : '';
              }
            } catch (error) {
              // Keep using the original token info if fetching fails
            }
          }

          console.log('🤖 Data', {
            status: 'success',
            provider: selectedProvider.getName(),
            token,
            transactionHash: finalReceipt?.hash,
            network,
          });

          // Return result as JSON string
          return JSON.stringify({
            status: 'success',
            provider: selectedProvider.getName(),
            token,
            transactionHash: finalReceipt?.hash,
            network,
          });
        } catch (error: any) {
          // Use BaseTool's error handling
          return this.handleError(error, args);
        }
      },
    };
  }
}
