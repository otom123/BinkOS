import {
  IWalletProvider,
  Transaction,
  TransferParams,
  TransferQuote,
  WalletBalance,
  WalletInfo,
} from '@binkai/wallet-plugin';
import { Connection, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import solanaWeb3, { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  NetworkName,
  SOL_NATIVE_TOKEN_ADDRESS,
  SOL_NATIVE_TOKEN_ADDRESS2,
  Token,
} from '@binkai/core';
import { Metaplex } from '@metaplex-foundation/js';
import { ethers } from 'ethers';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
interface SolanaProviderConfig {
  rpcUrl?: string;
}

const CONSTANTS = {
  QUOTE_EXPIRY: 10 * 60 * 1000, // 10 minutes in milliseconds
  GAS_COST: 0.005,
} as const;

export class SolanaProvider implements IWalletProvider {
  private connection: Connection;
  protected quotes: Map<string, { quote: TransferQuote; expiresAt: number }>;

  constructor(config: SolanaProviderConfig) {
    this.connection = new Connection(
      config.rpcUrl || 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );
    this.quotes = new Map();
  }

  getName(): string {
    return 'solana';
  }

  getSupportedNetworks(): NetworkName[] {
    return [NetworkName.SOLANA];
  }

  async getWalletInfo(address: string): Promise<WalletInfo> {
    const nativeBalance = await this.getNativeBalance(address);
    return {
      address,
      nativeBalance: nativeBalance,
      tokens: undefined,
    };
  }

  async getNativeBalance(address: string): Promise<WalletBalance> {
    const balance = await this.connection.getBalance(new PublicKey(address));
    return {
      symbol: 'SOL',
      balance: (balance / LAMPORTS_PER_SOL).toString(),
      decimals: 9,
    };
  }

  async getTokenBalance(tokenAddress: string, walletAddress: string): Promise<WalletBalance> {
    const tokenPublicKey = new PublicKey(tokenAddress);
    const walletPublicKey = new PublicKey(walletAddress);

    const accountInfo = await this.connection.getParsedTokenAccountsByOwner(walletPublicKey, {
      mint: tokenPublicKey,
    });

    if (accountInfo.value.length === 0) {
      return {
        symbol: '',
        balance: '0',
        decimals: 0,
        tokenAddress: tokenAddress,
      };
    }

    const tokenBalance = accountInfo.value[0].account.data.parsed.info.tokenAmount;

    return {
      symbol: '', // Would need token metadata service to get symbol
      balance: tokenBalance.uiAmount.toString(),
      decimals: tokenBalance.decimals,
      tokenAddress: tokenAddress,
    };
  }

  /**
   * Adjusts the amount for native token transfers to account for gas costs
   * @param tokenAddress The address of the token being transferred
   * @param amount The original amount to transfer
   * @param userAddress The address of the user making the transfer
   * @param network The network on which the transfer is happening
   * @returns The adjusted amount after accounting for gas costs
   */
  async adjustAmount(
    tokenAddress: string,
    amount: string,
    userAddress: string,
    network: NetworkName,
  ): Promise<string> {
    // Only adjust for native token transfers
    if (!this.isNativeSolana(tokenAddress)) {
      return amount;
    }
    try {
      // Get user's balance
      const balance = await this.connection.getBalance(new PublicKey(userAddress));
      const amountBigInt = ethers.parseUnits(amount, 9);

      const gasCost = ethers.parseUnits(CONSTANTS.GAS_COST.toString(), 9);

      // If balance is less than amount + gas, adjust the amount
      if (balance < amountBigInt + gasCost) {
        // If we don't have enough for even gas, return 0
        if (balance <= gasCost) {
          return '0';
        }

        // Otherwise, subtract gas cost from balance to get max sendable amount
        const adjustedAmount = balance - Number(gasCost);
        return ethers.formatUnits(adjustedAmount, 9);
      }

      // If we have enough balance, no adjustment needed
      return amount;
    } catch (error) {
      console.error('Error adjusting amount:', error);
      // In case of error, return original amount
      return amount;
    }
  }

  async getQuote(params: TransferParams, walletAddress: string): Promise<TransferQuote> {
    this.validateNetwork(params.network);
    let token;
    if (this.isNativeSolana(params.token)) {
      token = {
        address: params.token,
        decimals: 9,
        symbol: 'SOL',
      };
    } else {
      token = await this.getTokenInfoSolana(
        params.token,
        params.network,
        this.connection,
        this.getName(),
      );
    }

    // Adjust amount for native token transfers
    let adjustedAmount = await this.adjustAmount(
      params.token,
      params.amount,
      walletAddress,
      params.network,
    );
    // Generate a unique quote ID
    const quoteId = Math.random().toString(36).substring(2);

    // Create the quote
    const quote: TransferQuote = {
      network: params.network,
      quoteId,
      token,
      fromAddress: walletAddress,
      toAddress: params.toAddress,
      amount: adjustedAmount,
      estimatedGas: '5000', // Solana has fixed transaction cost
    };

    // Store the quote with expiry
    this.quotes.set(quoteId, {
      quote,
      expiresAt: Date.now() + CONSTANTS.QUOTE_EXPIRY,
    });

    return quote;
  }

  async buildTransferTransaction(
    quote: TransferQuote,
    walletAddress: string,
  ): Promise<Transaction> {
    this.validateNetwork(quote.network);
    const amount = parseTokenAmount(quote.amount, quote.token.decimals);

    // Verify the quote exists and is valid
    const storedQuote = this.quotes.get(quote.quoteId);
    if (!storedQuote || storedQuote.expiresAt < Date.now()) {
      throw new Error('Quote expired or invalid');
    }

    // Verify the sender matches
    if (quote.fromAddress !== walletAddress) {
      throw new Error('Quote sender does not match wallet address');
    }

    const blockhash = await this.connection.getLatestBlockhash('confirmed');

    if (!blockhash) {
      throw new Error('Transaction simulation failed 1: Blockhash not found');
    }

    // Build transfer using legacy transaction to avoid version issues
    const tx = new solanaWeb3.Transaction();
    tx.feePayer = new PublicKey(quote.fromAddress);
    tx.recentBlockhash = blockhash.blockhash;
    tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;

    if (this.isNativeSolana(quote.token.address)) {
      // Handle native SOL transfer
      tx.add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: new PublicKey(quote.fromAddress),
          toPubkey: new PublicKey(quote.toAddress),
          lamports: Number(amount),
        }),
      );
    } else {
      console.log('spl token transfer');
      // Handle SPL token transfer
      const mintPubkey = new PublicKey(quote.token.address);
      const fromPubkey = new PublicKey(quote.fromAddress);
      const toPubkey = new PublicKey(quote.toAddress);

      // Get the source token account (sender's token account)
      const sourceTokenAccounts = await this.connection.getParsedTokenAccountsByOwner(fromPubkey, {
        mint: mintPubkey,
      });

      if (sourceTokenAccounts.value.length === 0) {
        throw new Error('Source token account not found');
      }

      const sourceTokenAccount = sourceTokenAccounts.value[0].pubkey;

      // Get or create the destination token account (recipient's token account)
      const destinationTokenAccount = await getAssociatedTokenAddress(mintPubkey, toPubkey);

      // Check if the destination token account exists
      const destinationAccountInfo = await this.connection.getAccountInfo(destinationTokenAccount);
      if (!destinationAccountInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            fromPubkey, // payer
            destinationTokenAccount, // ata
            toPubkey, // owner
            mintPubkey, // mint
          ),
        );
      }

      // Create transfer instruction
      tx.add(
        createTransferCheckedInstruction(
          sourceTokenAccount, // source token account
          mintPubkey, // mint
          destinationTokenAccount, // destination token account
          fromPubkey, // owner of source token account
          Number(amount), // amount
          quote.token.decimals, // decimals
        ),
      );
    }

    // Serialize without signatures since they will be added by the wallet
    const dataTx = Buffer.from(tx.serialize({ verifySignatures: false })).toString('base64');

    return {
      to: quote.toAddress,
      data: dataTx,
      value: Number(amount).toString(),
      network: quote.network,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
  }

  protected validateNetwork(network: NetworkName): void {
    if (!this.getSupportedNetworks().includes(network)) {
      throw new Error(`Network ${network} is not supported by ${this.getName()}`);
    }
  }

  async parseMetaplexMetadata(connection: Connection, mintAddress: string): Promise<any> {
    try {
      const metaplex = Metaplex.make(connection);
      const token = await metaplex.nfts().findByMint({ mintAddress: new PublicKey(mintAddress) });
      return {
        name: token.name,
        symbol: token.symbol,
        uri: token.uri,
        mintAddress,
      };
    } catch (error) {
      throw new Error(`Error parsing Metaplex metadata: ${error}`);
    }
  }

  protected async getTokenInfoSolana(
    tokenAddress: string,
    network: NetworkName,
    providers: Connection,
    providerName: string,
  ): Promise<Token> {
    const tokenMint = new PublicKey(tokenAddress);
    const tokenInfo = await providers.getParsedAccountInfo(tokenMint);

    if (!tokenInfo.value || !('parsed' in tokenInfo.value.data)) {
      throw new Error(`Invalid token info for ${tokenAddress} on ${network}`);
    }

    const parsedData = tokenInfo.value.data.parsed;
    if (!('info' in parsedData)) {
      throw new Error(`Missing token info for ${tokenAddress}`);
    }

    const { decimals, symbol } = parsedData.info;

    const metadata = await this.parseMetaplexMetadata(this.connection, tokenAddress);

    return {
      address: tokenAddress,
      decimals: Number(decimals),
      symbol: metadata?.symbol || symbol,
    };
  }

  private isNativeSolana(tokenAddress: string): boolean {
    return (
      tokenAddress.toLowerCase() === SOL_NATIVE_TOKEN_ADDRESS.toLowerCase() ||
      tokenAddress.toLowerCase() === SOL_NATIVE_TOKEN_ADDRESS2.toLowerCase()
    );
  }

  async checkBalance(
    quote: TransferQuote,
    walletAddress: string,
  ): Promise<{ isValid: boolean; message?: string }> {
    this.validateNetwork(quote.network);

    try {
      const walletPublicKey = new PublicKey(walletAddress);
      let balance: number;

      if (this.isNativeSolana(quote.token.address)) {
        balance = await this.connection.getBalance(walletPublicKey);

        // Parse the required amount using the token's decimals
        const requiredAmount = ethers.parseUnits(quote.amount, quote.token.decimals);

        // Check if we need to account for gas costs for native token transfers
        let effectiveBalance = balance;
        if (this.isNativeSolana(quote.token.address)) {
          // For native token transfers, we need to ensure there's enough for the transfer amount plus gas
          const gasLimit = ethers.parseUnits(CONSTANTS.GAS_COST.toString(), quote.token.decimals);
          effectiveBalance = balance - Number(gasLimit);
          if (effectiveBalance < 0) effectiveBalance = 0;
        }

        if (effectiveBalance < requiredAmount) {
          return {
            isValid: false,
            message: `Insufficient SOL balance. Required: ${quote.amount} ${quote.token.symbol}, Available: ${ethers.formatUnits(balance, quote.token.decimals)} ${quote.token.symbol}${
              this.isNativeSolana(quote.token.address) ? ' (gas costs will be deducted)' : ''
            }`,
          };
        }

        return { isValid: true };
      } else {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPublicKey, {
          mint: new PublicKey(quote.token.address),
        });

        if (tokenAccounts.value.length === 0) {
          return {
            isValid: false,
            message: 'No token account found',
          };
        }

        const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
        if (tokenBalance.uiAmount < Number(quote.amount)) {
          return {
            isValid: false,
            message: `Insufficient token balance. Required: ${quote.amount}, Available: ${tokenBalance.uiAmount}`,
          };
        }
      }

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        message: `Error checking balance: ${error}`,
      };
    }
  }
}

function parseTokenAmount(amount: string, decimals: number) {
  try {
    // Handle edge cases
    if (!amount || amount === '0') return BigInt(0);

    // Check if the amount has more decimal places than allowed
    const parts = amount.split('.');
    if (parts.length === 2 && parts[1].length > decimals) {
      // Truncate the excess decimal places
      const truncatedAmount = `${parts[0]}.${parts[1].substring(0, decimals)}`;
      return ethers.parseUnits(truncatedAmount, decimals);
    }

    // Normal case - use ethers.parseUnits directly
    return ethers.parseUnits(amount, decimals);
  } catch (error) {
    console.error('Error parsing token amount:', error);
    // In case of any error, return zero
    return BigInt(0);
  }
}
