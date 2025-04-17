import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IPlugin } from '@binkai/core/src/plugin';
import { z } from 'zod';

export function createMcpServer(plugin: IPlugin, provider: any, options: any) {
  const tools: any[] = [];
  return {
    listOfTools: () => {
      return tools.map(tool => {
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
      });
    },
    toolHandler: async (name: string, parameters: unknown) => {
      const tool = tools.find(tool => tool.name === name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }

      const parsedParameters = tool.parameters.parse(parameters ?? {});
      const result = await tool.execute(parsedParameters);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    },
  };
}

export async function startMcpServer(plugin: IPlugin, provider: any, options: any) {
  try {
    console.error('MCP server starting...');
    const server = createMcpServer(plugin, provider, options);
    const transport = new StdioServerTransport();
    await transport.start();
    console.error('MCP server started');
    return server;
  } catch (error) {
    console.error('Error starting MCP server', error);
    throw error;
  }
}
