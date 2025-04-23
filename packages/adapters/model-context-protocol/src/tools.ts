import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IPlugin } from '@binkai/core/src/plugin';
import { z } from 'zod';
import { BaseTool } from '@binkai/core/src/agent/tools/BaseTool';

export interface McpServerOptions {
  name: string;
  version: string;
}

export async function createMcpServer(plugin: IPlugin, options: McpServerOptions) {
  // Create MCP server instance
  const server = new McpServer({
    name: options.name,
    version: options.version,
  });

  // Get all tools from the plugin
  const tools = plugin.getTools();

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

export async function startMcpServer(plugin: IPlugin, options: McpServerOptions) {
  try {
    console.log('Starting MCP server...');

    // Create server instance
    const server = await createMcpServer(plugin, options);

    // Create and start transport
    const transport = new StdioServerTransport();
    await transport.start();

    console.log('MCP server started successfully');
    return server;
  } catch (error) {
    console.error('Error starting MCP server:', error);
    throw error;
  }
}
