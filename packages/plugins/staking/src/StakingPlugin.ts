import { StakingTool } from './StakingTool';
import { GetStakingBalanceTool } from './GetStakingBalanceTool';
import { GetBestHighestAPYTool } from './GetBestHighestAPY';
import { IStakingProvider } from './types';
import { ProviderRegistry } from './ProviderRegistry';
import { BaseTool, IPluginConfig, BasePlugin, NetworkName } from '@binkai/core';

export interface StakingPluginConfig extends IPluginConfig {
  defaultNetwork?: string;
  providers?: IStakingProvider[];
  supportedNetworks?: string[];
}

export class StakingPlugin extends BasePlugin {
  public registry: ProviderRegistry;
  private stakingTool!: StakingTool;
  private getStakingBalanceTool!: GetStakingBalanceTool;
  private getBestHighestAPYTool!: GetBestHighestAPYTool;
  private supportedNetworks: Set<string>;

  constructor() {
    super();
    this.registry = new ProviderRegistry();
    this.supportedNetworks = new Set();
  }

  getName(): string {
    return 'staking';
  }

  async initialize(config: StakingPluginConfig): Promise<void> {
    // Initialize supported networks
    if (config.supportedNetworks) {
      config.supportedNetworks.forEach(network => this.supportedNetworks.add(network));
    }

    // Configure staking tool
    this.stakingTool = new StakingTool({
      defaultNetwork: config.defaultNetwork,
      supportedNetworks: Array.from(this.supportedNetworks),
    });

    this.getStakingBalanceTool = new GetStakingBalanceTool({
      defaultNetwork: config.defaultNetwork,
      supportedNetworks: Array.from(this.supportedNetworks),
    });

    this.getBestHighestAPYTool = new GetBestHighestAPYTool({
      defaultNetwork: config.defaultNetwork,
      supportedNetworks: Array.from(this.supportedNetworks),
    });

    // Register providers if provided in config
    if (config.providers) {
      for (const provider of config.providers) {
        this.registerProvider(provider);
      }
    }
  }

  getTools(): BaseTool[] {
    return [
      this.stakingTool as unknown as BaseTool,
      this.getStakingBalanceTool as unknown as BaseTool,
      this.getBestHighestAPYTool as unknown as BaseTool,
    ];
  }

  /**
   * Register a new Staking provider
   */
  registerProvider(provider: IStakingProvider): void {
    this.registry.registerProvider(provider);
    this.stakingTool.registerProvider(provider);
    this.getStakingBalanceTool.registerProvider(provider);
    this.getBestHighestAPYTool.registerProvider(provider);
    // Add provider's supported networks
    provider.getSupportedNetworks().forEach((network: NetworkName) => {
      this.supportedNetworks.add(network);
    });
  }

  /**
   * Get all registered providers
   */
  getProviders(): IStakingProvider[] {
    return this.registry.getProvidersByNetwork('*');
  }

  /**
   * Get providers for a specific network
   */
  getProvidersForNetwork(network: NetworkName): IStakingProvider[] {
    return this.registry.getProvidersByNetwork(network);
  }

  /**
   * Get all supported networks
   */
  getSupportedNetworks(): NetworkName[] {
    return Array.from(this.supportedNetworks) as NetworkName[];
  }

  async cleanup(): Promise<void> {
    // Cleanup any provider resources if needed
    const providers = this.getProviders();
    await Promise.all(
      providers.map(async provider => {
        if ('cleanup' in provider && typeof provider.cleanup === 'function') {
          await provider.cleanup();
        }
      }),
    );
  }
}
