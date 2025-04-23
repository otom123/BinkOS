import { startSwapMcpServer } from '@binkai/model-context-protocol';

const SOL_RPC = 'https://solana-rpc.debridge.finance';

async function main() {
  console.log('🚀 Starting Swap MCP server example...\n');

  try {
    // Start the swap MCP server
    await startSwapMcpServer({
      name: 'binkai-swap-server',
      version: '1.0.0',
      rpcUrl: SOL_RPC,
    });

    console.log('✓ Swap MCP server started successfully\n');
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
