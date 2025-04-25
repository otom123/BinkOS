import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SwapPlugin } from '@binkai/swap-plugin';
import { JupiterProvider } from '@binkai/jupiter-provider';
import { Connection } from '@solana/web3.js';
import {
  NetworkName,
  Agent,
  Wallet,
  NetworksConfig,
  NetworkType,
  Network,
  settings,
} from '@binkai/core';
import { SwapMcpServerOptions } from './types';

export async function createSwapMcpServer(server: Server, options: SwapMcpServerOptions) {
  try {
    // Check required environment variables
    if (!settings.has('OPENAI_API_KEY')) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    console.log('🚀 Initializing Swap MCP Server...');

    // Initialize Solana connection
    const connection = new Connection(options.data.rpcUrl, 'confirmed');
    console.log('🔌 Connected to Solana network:', options.data.rpcUrl);

    // Initialize Jupiter provider
    const jupiterProvider = new JupiterProvider(connection);
    console.log('🔄 Initialized Jupiter provider');

    // Initialize SwapPlugin
    const swapPlugin = new SwapPlugin();
    console.log('🔄 Initialized SwapPlugin');

    // Initialize SwapPlugin with Jupiter provider
    await swapPlugin.initialize({
      defaultSlippage: options.data.slippage,
      defaultNetwork: NetworkName.SOLANA,
      providers: [jupiterProvider],
      supportedNetworks: [NetworkName.SOLANA],
    });
    console.log('✅ SwapPlugin initialized with Jupiter provider');

    // Create networks config
    const networks: NetworksConfig['networks'] = {
      [NetworkName.SOLANA]: {
        type: 'solana' as NetworkType,
        config: {
          rpcUrl: options.data.rpcUrl,
          name: 'Solana',
          nativeCurrency: {
            name: 'Solana',
            symbol: 'SOL',
            decimals: 9,
          },
        },
      },
    };
    const network = new Network({ networks });

    // Create wallet
    const wallet = new Wallet(
      {
        seedPhrase:
          settings.get('WALLET_MNEMONIC') ||
          'test test test test test test test test test test test junk',
        index: 9,
      },
      network,
    );
    const walletAddress = await wallet.getAddress(NetworkName.SOLANA);
    console.log('👛 Wallet initialized with address:', walletAddress);

    // Create agent
    const agent = new Agent(
      {
        model: 'gpt-4',
        temperature: 0,
      },
      wallet,
      networks,
    );
    console.log('🤖 Agent initialized');

    // Register swap plugin with agent
    await agent.registerPlugin(swapPlugin);
    console.log('✅ Swap plugin registered with agent');

    // Get the swap tool
    const tools = swapPlugin.getTools();
    const swapTool = tools.find(tool => tool.getName() === 'swap');
    if (!swapTool) {
      throw new Error('Swap tool not found in plugin tools');
    }
    console.log('🔄 Found swap tool:', swapTool.getName());

    // Execute the swap directly
    try {
      console.log('🔄 Starting swap process...');
      console.log('🚀 User address:', walletAddress);

      // Validate token addresses
      if (!options.data.fromToken || !options.data.toToken) {
        throw new Error('Invalid token addresses');
      }

      // Construct proper swap parameters according to SwapTool schema
      const swapParams = {
        fromToken: options.data.fromToken,
        toToken: options.data.toToken,
        amount: options.data.amount,
        amountType: options.data.amountType,
        network: options.data.network,
        provider: options.data.provider,
        slippage: options.data.slippage,
        limitPrice: 0,
        userAddress: walletAddress,
      };

      console.log('📝 Swap parameters:', JSON.stringify(swapParams, null, 2));

      // Execute the swap using the agent's invokeTool method
      console.log('🔄 Invoking swap tool...');
      const result = await agent.invokeTool(swapTool.getName(), swapParams);
      console.log('✅ Swap result:', result);

      // Parse the result if it's a string
      const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;

      // Check if the swap was successful
      if (parsedResult.status === 'success') {
        console.log('✅ Swap successful:', parsedResult);
      } else {
        throw new Error(parsedResult.error || 'Swap failed');
      }
    } catch (error) {
      console.error('❌ Swap error:', error);
      throw error;
    }

    console.log('✅ Swap MCP server setup complete');
    return server;
  } catch (error) {
    console.error('❌ Error setting up Swap MCP server:', error);
    throw error;
  }
}

export async function startSwapMcpServer(options: SwapMcpServerOptions) {
  try {
    console.log('🚀 Starting Swap MCP server...');
    const server = new Server({
      name: options.name,
      version: options.version,
    });

    // Create the server first
    const transport = new StdioServerTransport();
    server.connect(transport);

    // Then initialize the swap functionality
    await createSwapMcpServer(server, options);

    console.log('✅ Swap MCP server started successfully');
    return server;
  } catch (error) {
    console.error('❌ Error starting Swap MCP server:', error);
    throw error;
  }
}
