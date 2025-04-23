import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SwapPlugin } from '@binkai/swap-plugin';
import { JupiterProvider } from '@binkai/jupiter-provider';
import { Connection } from '@solana/web3.js';
import { NetworkName, Agent, Wallet, NetworksConfig, NetworkType, Network } from '@binkai/core';

export interface SwapMcpServerOptions {
  name: string;
  version: string;
  rpcUrl: string;
}

export async function createSwapMcpServer(options: SwapMcpServerOptions) {
  // Initialize Solana connection
  const connection = new Connection(options.rpcUrl);

  // Create Jupiter provider
  const jupiterProvider = new JupiterProvider(connection);

  // Create SwapPlugin instance
  const swapPlugin = new SwapPlugin();

  // Initialize SwapPlugin with Jupiter provider
  await swapPlugin.initialize({
    defaultSlippage: 0.5,
    defaultNetwork: NetworkName.SOLANA,
    providers: [jupiterProvider],
    supportedNetworks: [NetworkName.SOLANA],
  });

  // Create networks config
  const networks: NetworksConfig['networks'] = {
    [NetworkName.SOLANA]: {
      type: 'solana',
      config: {
        name: NetworkName.SOLANA,
        rpcUrl: options.rpcUrl,
      },
    },
  };
  const network = new Network({ networks });
  // Create a dummy wallet
  const wallet = new Wallet(
    {
      seedPhrase: 'test test test test test test test test test test test junk',
      index: 0,
    },
    network,
  );

  // Create a dummy agent for the tools
  const agent = new Agent(
    {
      model: 'gpt-4',
      temperature: 0,
    },
    wallet,
    networks,
  );

  // Set the agent for the plugin
  await swapPlugin.register(agent);

  // Create MCP server instance
  const server = new McpServer({
    name: options.name,
    version: options.version,
  });

  // Get all tools from the plugin
  const tools = swapPlugin.getTools();

  // Register each tool with the MCP server
  for (const tool of tools) {
    // Create the tool instance
    const toolInstance = tool.createTool();

    server.tool(tool.getName(), async args => {
      try {
        // Execute the tool with the provided arguments
        const result = await toolInstance.func(args);

        // Format the response according to MCP protocol
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(`Error executing tool ${tool.getName()}:`, error);

        // Return error response
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
                tool: tool.getName(),
              }),
            },
          ],
        };
      }
    });
  }

  return server;
}

export async function startSwapMcpServer(options: SwapMcpServerOptions) {
  try {
    console.log('Starting Swap MCP server...');

    // Create server instance
    const server = await createSwapMcpServer(options);

    // Create and start transport
    const transport = new StdioServerTransport();
    await transport.start();

    console.log('✅ Swap MCP server started successfully');
    return server;
  } catch (error) {
    console.error('Error starting Swap MCP server:', error);
    throw error;
  }
}
