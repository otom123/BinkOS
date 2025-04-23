import { BirdeyeProvider } from '@binkai/birdeye-provider';
import { BnbProvider, SolanaProvider } from '@binkai/rpc-provider';
import { AlchemyProvider } from '@binkai/alchemy-provider';
import {
  Agent,
  Network,
  NetworkName,
  NetworksConfig,
  NetworkType,
  settings,
  Wallet,
} from '@binkai/core';
import { TokenPlugin } from '@binkai/token-plugin';
import { WalletPlugin } from '@binkai/wallet-plugin';
import { ethers } from 'ethers';

async function main() {
  // Define available networks
  const BNB_RPC = 'https://bsc-dataseed1.binance.org';
  const ETH_RPC = 'https://eth.llamarpc.com';
  const SOL_RPC = 'https://solana-rpc.debridge.finance';

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
  const providerSolana = new ethers.JsonRpcProvider(SOL_RPC);
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

  console.log('🤖 Wallet BNB:', await wallet.getAddress(NetworkName.BNB));
  console.log('🤖 Wallet ETH:', await wallet.getAddress(NetworkName.ETHEREUM));
  console.log('🤖 Wallet SOL:', await wallet.getAddress(NetworkName.SOLANA));
  // Create an agent with OpenAI
  console.log('🤖 Initializing AI agent...');
  const agent = new Agent(
    {
      model: 'gpt-4.1',
      temperature: 0,
    },
    wallet,
    networks,
  );
  console.log('✓ Agent initialized\n');

  // Create and configure the wallet plugin
  console.log('🔄 Initializing wallet plugin...');
  const walletPlugin = new WalletPlugin();
  // Create provider with API key
  const bnbProvider = new BnbProvider({
    rpcUrl: BNB_RPC,
  });
  const solanaProvider = new SolanaProvider({
    rpcUrl: SOL_RPC,
  });

  const alchemyProvider = new AlchemyProvider({
    apiKey: settings.get('ALCHEMY_API_KEY'),
  });
  // Create Birdeye provider with API key
  const birdeyeProvider = new BirdeyeProvider({
    apiKey: settings.get('BIRDEYE_API_KEY'),
  });

  // Initialize plugin with provider
  await walletPlugin.initialize({
    defaultChain: 'bnb',
    providers: [alchemyProvider, birdeyeProvider, solanaProvider],
    supportedChains: ['bnb', 'solana'],
  });

  // Create and configure the token plugin
  console.log('🔍 Initializing token plugin...');
  const tokenPlugin = new TokenPlugin();
  await tokenPlugin.initialize({
    defaultChain: 'bnb',
    providers: [birdeyeProvider],
    supportedChains: ['bnb', 'solana'],
  });
  console.log('✓ Token plugin initialized\n');

  // Register with BinkOS agent
  // await agent.registerPlugin(transferPlugin);
  await agent.registerPlugin(walletPlugin);
  await agent.registerPlugin(tokenPlugin);

  // Execute token transfer through natural language
  const result = await agent.execute({
    input: 'send 0.01 USDT(Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB) to wallet() on solana',
  });
  console.log('🤖 Result:', result);
}

main().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
