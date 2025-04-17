import { ethers } from 'ethers';
import {
  Agent,
  Wallet,
  Network,
  settings,
  NetworkType,
  NetworksConfig,
  NetworkName,
  IToolExecutionCallback,
  ToolExecutionData,
  ToolExecutionState,
  PlanningAgent,
  IHumanReviewCallback,
  HumanReviewData,
  AskUserData,
  IAskUserCallback,
} from '@binkai/core';
import { SwapPlugin } from '@binkai/swap-plugin';
import { PancakeSwapProvider } from '@binkai/pancakeswap-provider';
// import { OkxProvider } from '@binkai/okx-provider';
import { TokenPlugin } from '@binkai/token-plugin';
import { BirdeyeProvider } from '@binkai/birdeye-provider';
import { WalletPlugin } from '@binkai/wallet-plugin';
import { BnbProvider } from '@binkai/rpc-provider';
// import { FourMemeProvider } from '@binkai/four-meme-provider';
import { BridgePlugin } from '@binkai/bridge-plugin';
import { deBridgeProvider } from '@binkai/debridge-provider';
import { JupiterProvider } from '@binkai/jupiter-provider';
import { Connection } from '@solana/web3.js';
import { AlchemyProvider } from '@binkai/alchemy-provider';
import { ThenaProvider } from '@binkai/thena-provider';

import { KnowledgePlugin } from '@binkai/knowledge-plugin';
import { BinkProvider } from '@binkai/bink-provider';
import { ImagePlugin } from '@binkai/image-plugin';

// Hardcoded RPC URLs for demonstration
const BNB_RPC = 'https://bsc-dataseed1.binance.org';
const ETH_RPC = 'https://eth.llamarpc.com';
const SOL_RPC = 'https://api.mainnet-beta.solana.com';

// Example callback implementation
class ExampleToolExecutionCallback implements IToolExecutionCallback {
  onToolExecution(data: ToolExecutionData): void {
    const stateEmoji = {
      [ToolExecutionState.STARTED]: '🚀',
      [ToolExecutionState.IN_PROCESS]: '⏳',
      [ToolExecutionState.COMPLETED]: '✅',
      [ToolExecutionState.FAILED]: '❌',
    };

    const emoji = stateEmoji[data.state] || '🔄';

    console.log(`${emoji} [${new Date(data.timestamp).toISOString()}] ${data.message}`);

    if (data.state === ToolExecutionState.IN_PROCESS && data.data) {
      console.log(`   Progress: ${data.data.progress || 0}%`);
    }

    if (data.state === ToolExecutionState.COMPLETED && data.data) {
      console.log(
        `   Result: ${JSON.stringify(data.data).substring(0, 100)}${JSON.stringify(data.data).length > 100 ? '...' : ''}`,
      );
    }

    if (data.state === ToolExecutionState.FAILED && data.error) {
      console.log(`   Error: ${data.error.message || String(data.error)}`);
    }
  }
}

class ExampleHumanReviewCallback implements IHumanReviewCallback {
  onHumanReview(data: HumanReviewData): void {
    console.log(`Human review: ${data.toolName}`, data.data);
  }
}

class ExampleAskUserCallback implements IAskUserCallback {
  onAskUser(data: AskUserData): void {
    console.log(`Ask user: ${data.question}`);
  }
}

async function main() {
  console.log('🚀 Starting BinkOS swap example...\n');

  // Check required environment variables
  if (!settings.has('OPENAI_API_KEY')) {
    console.error('❌ Error: Please set OPENAI_API_KEY in your .env file');
    process.exit(1);
  }

  console.log('🔑 OpenAI API key found\n');

  // Define available networks
  console.log('📡 Configuring networks...');
  const networks: NetworksConfig['networks'] = {
    [NetworkName.BNB]: {
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
    [NetworkName.ETHEREUM]: {
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
  const provider = new ethers.JsonRpcProvider(BNB_RPC);
  console.log('✓ Provider initialized\n');

  // Initialize a new wallet
  console.log('👛 Creating wallet...');
  const wallet = new Wallet(
    {
      seedPhrase:
        settings.get('WALLET_MNEMONIC') ||
        'test test test test test test test test test test test junk',
      index: 0,
    },
    network,
  );
  console.log('✓ Wallet created\n');

  console.log('🤖 Wallet BNB:', await wallet.getAddress(NetworkName.BNB));
  console.log('🤖 Wallet ETH:', await wallet.getAddress(NetworkName.ETHEREUM));
  console.log('🤖 Wallet SOL:', await wallet.getAddress(NetworkName.SOLANA));
  // Create an agent with OpenAI
  console.log('🤖 Initializing AI agent...');
  const agent = new PlanningAgent(
    {
      isHumanReview: true,
      model: 'gpt-4o',
      temperature: 0,
      systemPrompt:
        'You are a BINK AI agent. You are able to perform swaps, bridges and get token information on multiple chains. If you do not have the token address, you can use the symbol to get the token information before performing a bridge or swap.',
    },
    wallet,
    networks,
  );
  console.log('✓ Agent initialized\n');

  const solanaProvider = new Connection(SOL_RPC);

  // Register the tool execution callback
  console.log('🔔 Registering tool execution callback...');
  agent.registerToolExecutionCallback(new ExampleToolExecutionCallback());
  agent.registerHumanReviewCallback(new ExampleHumanReviewCallback());
  agent.registerAskUserCallback(new ExampleAskUserCallback());
  console.log('✓ Callback registered\n');

  // Create and configure the swap plugin
  console.log('🔄 Initializing swap plugin...');
  const swapPlugin = new SwapPlugin();

  console.log('🔄 Initializing bridge plugin...');
  const bridgePlugin = new BridgePlugin();

  console.log('🔍 Initializing token plugin...');
  const tokenPlugin = new TokenPlugin();

  // Create Birdeye provider with API key
  const birdeye = new BirdeyeProvider({
    apiKey: settings.get('BIRDEYE_API_KEY'),
  });

  const thena = new ThenaProvider(provider, 56);
  const alchemy = new AlchemyProvider({
    apiKey: settings.get('ALCHEMY_API_KEY'),
  });

  // Create and configure the wallet plugin
  console.log('🔄 Initializing wallet plugin...');
  const walletPlugin = new WalletPlugin();
  // Create provider with API key
  const bnbProvider = new BnbProvider({
    rpcUrl: BNB_RPC,
  });

  // Initialize plugin with provider
  await walletPlugin.initialize({
    providers: [bnbProvider, birdeye, alchemy],
    supportedChains: ['bnb', 'solana'],
  });
  // Configure the plugin with supported chains
  await tokenPlugin.initialize({
    providers: [birdeye, alchemy],
    supportedChains: ['solana', 'bnb'],
  });
  console.log('✓ Token plugin initialized\n');

  // Create providers with proper chain IDs
  const pancakeswap = new PancakeSwapProvider(provider, 56);
  // Create providers with proper chain IDs
  const jupiter = new JupiterProvider(solanaProvider);

  // const okx = new OkxProvider(provider, 56);

  // const fourMeme = new FourMemeProvider(provider, 56);

  const binkProvider = new BinkProvider({
    apiKey: settings.get('BINK_API_KEY') || '',
    baseUrl: settings.get('BINK_API_URL') || '',
    imageApiUrl: settings.get('BINK_IMAGE_API_URL') || '',
  });
  // Initialize plugin with provider
  const knowledgePlugin = new KnowledgePlugin();
  await knowledgePlugin.initialize({
    providers: [binkProvider],
  });

  // Configure the plugin with supported chains
  await swapPlugin.initialize({
    providers: [pancakeswap, jupiter, thena],
    supportedChains: ['bnb', 'ethereum', 'solana'], // These will be intersected with agent's networks
  });
  console.log('✓ Swap plugin initialized\n');

  // Create providers with proper chain IDs
  const debridge = new deBridgeProvider([provider, solanaProvider], 7565164);

  const imagePlugin = new ImagePlugin();
  // Configure the plugin with supported chains
  await bridgePlugin.initialize({
    providers: [debridge],
    supportedChains: ['bnb', 'solana'], // These will be intersected with agent's networks
  });

  await imagePlugin.initialize({
    providers: [binkProvider],
    supportedChains: ['bnb'],
  });
  console.log('✓ Token plugin initialized\n');

  // Register the plugin with the agent
  console.log('🔌 Registering token plugin with agent...');
  await agent.registerPlugin(imagePlugin);
  console.log('✓ Plugin registered\n');

  console.log('✓ Bridge plugin initialized\n');

  // Register the plugin with the agent
  console.log('🔌 Registering swap plugin with agent...');
  await agent.registerPlugin(swapPlugin);
  console.log('✓ Plugin registered\n');

  console.log('🔌 Registering wallet plugin with agent...');
  await agent.registerPlugin(walletPlugin);
  console.log('✓ Plugin registered\n');

  console.log('🔌 Registering token plugin with agent...');
  await agent.registerPlugin(tokenPlugin);
  console.log('✓ Plugin registered\n');

  console.log('🔌 Registering bridge plugin with agent...');
  await agent.registerPlugin(bridgePlugin);
  console.log('✓ Plugin registered\n');

  console.log('🔌 Registering knowledge plugin with agent...');
  await agent.registerPlugin(knowledgePlugin);
  console.log('✓ Plugin registered\n');

  return await agent.graph;

  // Example 1: Buy with exact input amount on BNB Chain
  // console.log('💱 Example 1: Buy BINK from exactly 0.0001 BNB with 0.5% slippage on bnb chain.');
  // const result1 = await agent.execute({
  //   input: `
  //     Buy BINK from exactly 0.0001 BNB with 0.5% slippage on bnb chain.
  //   `,
  //   //input: `swap crosschain 5 WETH on BNB to JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN on solana`,
  // });
  // console.log('✓ Swap result:', result1, '\n');

  // Example 2: Sell with exact output amount on BNB Chain
  // console.log('💱 Example 2: buy BINK from 10 USDC on solana');
  // const result2 = await agent.execute(`
  //    buy CAKE on BNB from 10 USDC on solana and stake it on ethereum chain
  //   `,
  // );

  // console.log('✓ Swap result:', result2, '\n');

  // // Get plugin information
  // // const registeredPlugin = agent.getPlugin('swap') as SwapPlugin;
  // const registeredPlugin = agent.getPlugin('bridge') as BridgePlugin;

  // // // Check available providers for each chain
  // console.log('📊 Available providers by chain:');
  // const chains = registeredPlugin.getSupportedNetworks();
  // for (const chain of chains) {
  //   const providers = registeredPlugin.getProvidersForNetwork(chain);
  //   console.log(`Chain ${chain}:`, providers.map(p => p.getName()).join(', '));
  // }
  // console.log();
}

// main().catch(error => {
//   console.error('❌ Error:', error.message);
//   process.exit(1);
// });

export const graph = main() as any;
