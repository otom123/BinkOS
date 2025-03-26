import { ethers } from 'ethers';
import {
  Agent,
  Wallet,
  Network,
  settings,
  NetworkType,
  NetworksConfig,
  NetworkName,
} from '@binkai/core';
import { SwapPlugin } from '@binkai/swap-plugin';
import { ThenaProvider } from '@binkai/thena-provider';
import { BirdeyeProvider } from '@binkai/birdeye-provider';
import { WalletPlugin } from '@binkai/wallet-plugin';
import { TokenPlugin } from '@binkai/token-plugin';
import { BnbProvider } from '@binkai/rpc-provider';

// Hardcoded RPC URLs for demonstration
const BNB_RPC = 'https://bsc-dataseed1.binance.org';
const ETH_RPC = 'https://eth.llamarpc.com';

async function main() {
  console.log('🚀 Starting BinkOS limit order example...\n');

  // Check required environment variables
  if (!settings.has('OPENAI_API_KEY')) {
    console.error('❌ Error: Please set OPENAI_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('🔑 OpenAI API key found\n');

  // Define available networks
  console.log('📡 Configuring networks...');
  const networks: NetworksConfig['networks'] = {
    bnb: {
      type: 'evm' as NetworkType,
      config: {
        chainId: 56,
        rpcUrl: BNB_RPC,
        name: 'BNB Chain',
        nativeCurrency: {
          name: 'BNB',
          symbol: 'BNB',
          decimals: 18,
        },
      },
    },
    ethereum: {
      type: 'evm' as NetworkType,
      config: {
        chainId: 1,
        rpcUrl: ETH_RPC,
        name: 'Ethereum',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
      },
    },
  };
  console.log('✓ Networks configured:', Object.keys(networks).join(', '), '\n');

  // Initialize network
  console.log('🌐 Initializing network...');
  const network = new Network({ networks });
  console.log('✓ Network initialized\n');

  // Initialize provider
  console.log('🔌 Initializing provider...');
  const provider = new ethers.JsonRpcProvider(BNB_RPC);
  console.log('✓ Provider initialized\n');

  // Initialize a new wallet
  console.log('👛 Creating wallet...');
  const wallet = new Wallet(
    {
      seedPhrase:
        settings.get('WALLET_MNEMONIC') ||
        'test test test test test test test test test test test test',
      index: 0,
    },
    network,
  );

  console.log('✓ Wallet created\n');

  console.log('🤖 Wallet BNB:', await wallet.getAddress(NetworkName.BNB));
  console.log('🤖 Wallet ETH:', await wallet.getAddress(NetworkName.ETHEREUM));
  // Create an agent with OpenAI
  console.log('🤖 Initializing AI agent...');
  const agent = new Agent(
    {
      model: 'gpt-4o',
      temperature: 0,
    },
    wallet,
    networks,
  );
  console.log('✓ Agent initialized\n');

  // Create and configure the swap plugin
  console.log('🔄 Initializing swap plugin...');
  const swapPlugin = new SwapPlugin();

  console.log('🔍 Initializing token plugin...');
  const tokenPlugin = new TokenPlugin();

  // Create and configure the wallet plugin
  console.log('🔄 Initializing wallet plugin...');
  const walletPlugin = new WalletPlugin();

  const bnbProvider = new BnbProvider({
    rpcUrl: BNB_RPC,
  });

  // Create Birdeye provider with API key
  const birdeye = new BirdeyeProvider({
    apiKey: settings.get('BIRDEYE_API_KEY'),
  });
  // Create providers with proper chain IDs
  const thena = new ThenaProvider(provider, 56);

  // Initialize plugin with provider
  await walletPlugin.initialize({
    defaultChain: 'bnb',
    providers: [bnbProvider, birdeye],
    supportedChains: ['bnb'],
  });

  // Configure the plugin with supported chains
  await tokenPlugin.initialize({
    defaultChain: 'bnb',
    providers: [birdeye],
    supportedChains: ['solana', 'bnb'],
  });

  // Configure the plugin with supported chains
  await swapPlugin.initialize({
    defaultSlippage: 0.5,
    defaultChain: 'bnb',
    providers: [thena],
    supportedChains: ['bnb', 'ethereum'],
  });
  console.log('✓ Swap plugin initialized\n');

  console.log('🔌 Registering wallet plugin with agent...');
  await agent.registerPlugin(walletPlugin);
  console.log('✓ Plugin registered\n');

  console.log('🔌 Registering token plugin with agent...');
  await agent.registerPlugin(tokenPlugin);
  console.log('✓ Plugin registered\n');

  // Register the plugin with the agent
  console.log('🔌 Registering swap plugin with agent...');
  await agent.registerPlugin(swapPlugin);
  console.log('✓ Plugin registered\n');
  //   console.log(`Example 1: cancel limit orders [
  //   987654, 987655,
  //   987656, 987657,
  //   987658, 987659,
  //   987660, 987661
  // ] via thena on bnb`);
  //   const result1 = await agent.execute({
  //     input: `
  //      cancel limit orders [
  //   987654, 987655,
  //   987656, 987657,
  //   987658, 987659,
  //   987660, 987661
  // ] via thena on bnb
  //     `,
  //   });
  //   console.log('✓ cancel limit orders result:', result1, '\n');

  console.log(`Example 2: cancel limit order 123456 via thena on bnb`);
  const result2 = await agent.execute({
    input: `
       cancel limit order 123456 via thena on bnb
      `,
  });
  console.log('✓ cancel limit order result:', result2, '\n');
  // Get plugin information
  const registeredPlugin = agent.getPlugin('swap') as SwapPlugin;

  // Check available providers for each chain
  console.log('📊 Available providers by chain:');
  const chains = registeredPlugin.getSupportedNetworks();
  for (const chain of chains) {
    const providers = registeredPlugin.getProvidersForNetwork(chain);
    console.log(`Chain ${chain}:`, providers.map(p => p.getName()).join(', '));
  }
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
