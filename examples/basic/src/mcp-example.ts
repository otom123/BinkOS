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
import { JupiterProvider } from '@binkai/jupiter-provider';
import { Connection } from '@solana/web3.js';
import { TokenPlugin } from '@binkai/token-plugin';
import { BirdeyeProvider } from '@binkai/birdeye-provider';
import { WalletPlugin } from '@binkai/wallet-plugin';
import { startMcpServer } from '@binkai/model-context-protocol';
// Hardcoded RPC URLs for demonstration
const BNB_RPC = 'https://bsc-dataseed1.binance.org';
const SOL_RPC = 'https://solana-rpc.debridge.finance';

async function main() {
  console.log('🚀 Starting BinkOS swap on Solana example...\n');

  // Check required environment variables
  if (!settings.has('OPENAI_API_KEY')) {
    console.error('❌ Error: Please set OPENAI_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('🔑 OpenAI API key found\n');

  // Define available networks
  console.log('📡 Configuring networks...');
  const networks: NetworksConfig['networks'] = {
    [NetworkName.SOLANA]: {
      type: 'solana' as NetworkType,
      config: {
        rpcUrl: SOL_RPC,
        name: 'Solana',
        nativeCurrency: {
          name: 'Solana',
          symbol: 'SOL',
          decimals: 9,
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
  const provider = new Connection(SOL_RPC);
  console.log('✓ Provider initialized\n');

  // Initialize a new wallet
  console.log('👛 Creating wallet...');
  const wallet = new Wallet(
    {
      seedPhrase:
        settings.get('WALLET_MNEMONIC') ||
        'test test test test test test test test test test test junk',
      index: 9,
    },
    network,
  );

  console.log('✓ Wallet created\n');

  console.log('🤖 Wallet SOL:', await wallet.getAddress(NetworkName.SOLANA));

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

  // Create Birdeye provider with API key
  const birdeye = new BirdeyeProvider({
    apiKey: settings.get('BIRDEYE_API_KEY'),
  });

  await tokenPlugin.initialize({
    defaultChain: 'solana',
    providers: [birdeye],
    supportedChains: ['solana'],
  });
  console.log('✓ Token plugin initialized\n');

  // Create providers with proper chain IDs
  const jupiter = new JupiterProvider(provider);

  // Configure the plugin with supported chains
  await swapPlugin.initialize({
    defaultSlippage: 0.5,
    defaultChain: 'solana',
    providers: [jupiter],
    supportedChains: ['solana'], // These will be intersected with agent's networks
  });
  console.log('✓ Swap plugin initialized\n');

  // Create and configure the wallet plugin
  console.log('🔄 Initializing wallet plugin...');
  const walletPlugin = new WalletPlugin();

  // Initialize wallet plugin with provider
  await walletPlugin.initialize({
    providers: [birdeye],
    supportedChains: ['solana'],
  });
  console.log('✓ Wallet plugin initialized\n');

  console.log('🔌 Registering token plugin with agent...');
  await agent.registerPlugin(tokenPlugin);
  console.log('✓ Plugin registered\n');

  // Register the plugin with the agent
  console.log('🔌 Registering swap plugin with agent...');
  await agent.registerPlugin(swapPlugin);
  console.log('✓ Plugin registered\n');

  // Register the wallet plugin with the agent
  console.log('🔌 Registering wallet plugin with agent...');
  await agent.registerPlugin(walletPlugin);
  console.log('✓ Wallet plugin registered\n');

  await startMcpServer(swapPlugin, provider, {
    port: 3000,
  });
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
