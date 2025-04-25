import { startSwapMcpServer, startSwapJupiterServer } from '@binkai/model-context-protocol';

// Use a reliable Solana RPC endpoint
const SOL_RPC = 'https://api.mainnet-beta.solana.com';
// const SOL_RPC = 'https://solana-api.projectserum.com';

// Token addresses
const USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112'; // SOL

async function main() {
  console.log('🚀 Starting Swap MCP server example...\n');

  const swapParams = {
    name: 'binkai-swap-server',
    version: '1.0.0',
    data: {
      rpcUrl: SOL_RPC,
      fromToken: SOL_ADDRESS,
      toToken: USDC_ADDRESS,
      amount: '0.01', // Swap 0.01 SOL
      amountType: 'input',
      network: 'solana',
      provider: 'jupiter',
      slippage: 0.5,
    },
  };

  try {
    console.log('📝 Swap parameters:', JSON.stringify(swapParams, null, 2));

    // Start the swap MCP server
    // const server = await startSwapMcpServer({
    //   name: 'binkai-swap-server',
    //   version: '1.0.0',
    //   data: swapParams,
    // });
    const server = await startSwapJupiterServer(swapParams);

    console.log('✅ Swap MCP server started successfully');
    console.log('🔄 Server is running. Press Ctrl+C to stop.');

    // Keep the server running
    process.on('SIGINT', () => {
      console.log('👋 Shutting down server...');
      process.exit(0);
    });

    return server;
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(error => {
  console.error('❌ Error:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error('Stack trace:', error.stack);
  }
  process.exit(1);
});
