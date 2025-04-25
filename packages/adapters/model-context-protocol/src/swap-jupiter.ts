import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import WebSocket from 'ws';
import { SwapPlugin } from '@binkai/swap-plugin';
import { JupiterProvider } from '@binkai/jupiter-provider';
import { Connection } from '@solana/web3.js';
import {
  Agent,
  Network,
  NetworkName,
  NetworksConfig,
  NetworkType,
  settings,
  Wallet,
} from '@binkai/core';
import { SwapMcpServerOptions } from './types';

class SwapJupiterClient {
  private ws: WebSocket | null = null;
  private subscriptions: Set<string> = new Set();
  private dataCache: Map<string, any> = new Map();
  private connectionAttempts: number = 0;
  private maxConnectionAttempts: number = 5;
  private reconnectDelay: number = 5000;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private wsUrl: string = 'wss://127.0.0.1:6277';

  constructor() {
    this.connect();
  }

  private connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      console.error('[WebSocket] Max connection attempts reached. Giving up.');
      return;
    }

    console.error(
      `[WebSocket] Connecting to swap-jupiter (attempt ${this.connectionAttempts + 1}/${
        this.maxConnectionAttempts
      })...`,
    );

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.error('[WebSocket] Connected to swap-jupiter');
      this.connectionAttempts = 0;
      this.isConnecting = false;
      this.resubscribe();

      // Set up ping interval to keep connection alive
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => this.ping(), 30000);
    });

    this.ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString());

        // Handle ping response
        if (message.event === 'pong') {
          return;
        }

        // Handle data updates
        if (message.data && message.arg) {
          const key = `${message.arg.channel}:${message.arg.instId}`;
          this.dataCache.set(key, message.data);

          console.error(`[WebSocket] Received update for ${key}`);
        }
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error);
      }
    });

    this.ws.on('error', error => {
      console.error('[WebSocket] Error:', error);
    });

    this.ws.on('close', () => {
      console.error('[WebSocket] Disconnected');
      this.isConnecting = false;

      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      this.connectionAttempts++;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });
  }

  private ping() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'ping' }));
    }
  }

  private resubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const subscription of this.subscriptions) {
      const [channel, instId] = subscription.split(':');
      this.sendSubscription(channel, instId);
      console.error(`[WebSocket] Resubscribed to ${channel} for ${instId}`);
    }
  }

  private sendSubscription(channel: string, instId: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        args: [
          {
            channel,
            instId,
          },
        ],
      }),
    );
  }

  subscribe(channel: string, instId: string): void {
    const key = `${channel}:${instId}`;

    if (this.subscriptions.has(key)) {
      return; // Already subscribed
    }

    console.error(`[WebSocket] Subscribing to ${channel} for ${instId}`);
    this.subscriptions.add(key);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(channel, instId);
    }
  }

  unsubscribe(channel: string, instId: string): void {
    const key = `${channel}:${instId}`;

    if (!this.subscriptions.has(key)) {
      return; // Not subscribed
    }

    console.error(`[WebSocket] Unsubscribing from ${channel} for ${instId}`);
    this.subscriptions.delete(key);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          op: 'unsubscribe',
          args: [
            {
              channel,
              instId,
            },
          ],
        }),
      );
    }
  }

  getLatestData(channel: string, instId: string): any | null {
    const key = `${channel}:${instId}`;
    return this.dataCache.get(key) || null;
  }

  isSubscribed(channel: string, instId: string): boolean {
    const key = `${channel}:${instId}`;
    return this.subscriptions.has(key);
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }

    this.subscriptions.clear();
    this.dataCache.clear();
  }
}

class SwapJupiterServer {
  private server: Server;
  private wsClient: SwapJupiterClient;

  constructor(data: SwapMcpServerOptions) {
    console.error('[Setup] Initializing SwapJupiter MCP server...');

    this.server = new Server(
      {
        name: 'swap-jupiter-mcp-server',
        version: '0.0.0-alpha-1',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    // Initialize WebSocket client
    this.wsClient = new SwapJupiterClient();

    this.setupToolHandlers(data);

    this.server.onerror = error => console.error('[Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async setupToolHandlers(data: SwapMcpServerOptions) {
    // SETUP WITH SWAP PLUGIN - JUPITER PROVIDER
    const connection = new Connection(data.data.rpcUrl);
    const swapPlugin = new SwapPlugin();
    const jupiterProvider = new JupiterProvider(connection);
    await swapPlugin.initialize({
      defaultSlippage: data.data.slippage,
      defaultNetwork: NetworkName.SOLANA,
      providers: [jupiterProvider],
      supportedNetworks: [NetworkName.SOLANA],
    });
    const networks: NetworksConfig['networks'] = {
      [NetworkName.SOLANA]: {
        type: 'solana' as NetworkType,
        config: {
          rpcUrl: data.data.rpcUrl,
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
    const agent = new Agent(
      {
        model: 'gpt-4',
        temperature: 0,
      },
      wallet,
      networks,
    );
    await agent.registerPlugin(swapPlugin);
    const tools = swapPlugin.getTools();
    const swapTool = tools.find(tool => tool.getName() === 'swap');

    if (!swapTool) {
      throw new Error('Swap tool not found in plugin tools');
    }
    console.log('🔄 Found swap tool:', swapTool.getName());

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: swapTool.getName(),
          description: swapTool.getDescription(),
          inputSchema: swapTool.getSchema(),
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        console.log('🔄 Received tool call:', request);
        const validTools = ['swap'];

        if (!validTools.includes(request.params.name)) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
        console.log('🔄 loggggggg');
        const swapParams = {
          fromToken: data.data.fromToken,
          toToken: data.data.toToken,
          amount: data.data.amount,
          amountType: data.data.amountType,
          network: data.data.network,
          provider: data.data.provider,
          slippage: data.data.slippage,
          limitPrice: 0,
          userAddress: walletAddress,
        };

        if (request.params.name === 'swap') {
          const result = await agent.invokeTool(swapTool.getName(), swapParams);

          // Parse the result if it's a string
          const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
          console.log('✅ Swap result:', parsedResult);

          // Original JSON format
          return {
            content: [
              {
                type: 'text',
                text: parsedResult,
              },
            ],
          };
        }

        // This should never happen due to the check at the beginning
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error('[Error] Failed to fetch data:', error);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch data: ${error.message}`);
        }
        throw error;
      }
    });
  }

  private async cleanup() {
    console.error('[Cleanup] Shutting down...');
    this.wsClient.close();
    await this.server.close();
  }
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('SwapJupiter MCP server running on stdio');
  }
}

export async function startSwapJupiterServer(data: SwapMcpServerOptions) {
  try {
    console.log('🚀 Starting Swap Jupiter server...');
    const server = new SwapJupiterServer(data);
    await server.run();
    console.log('✅ Swap Jupiter server started successfully');
  } catch (error) {
    console.error('❌ Error starting Swap Jupiter server:', error);
    throw error;
  }
}
