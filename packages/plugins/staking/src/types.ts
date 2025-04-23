import { NetworkName, Token } from '@binkai/core';
import { Provider } from 'ethers';
import { Connection } from '@solana/web3.js';

export type NetworkProvider = Provider | Connection;

export interface StakingQuote {
  provider?: string;
  network: NetworkName;
  quoteId: string;
  tokenA: Token;
  tokenB: Token;
  amountA: string;
  amountB: string;
  currentAPY: number;
  averageAPY?: number;
  maxSupply: number;
  currentSupply: number;
  liquidity: number;
  estimatedGas: string;
  type: 'supply' | 'withdraw' | 'stake' | 'unstake' | 'deposit';
  tx?: Transaction;
}

export interface StakingResult extends StakingQuote {
  transactionHash: string;
  status: 'success' | 'failed';
  error?: string;
}

export interface StakingParams {
  network: NetworkName;
  tokenA: string;
  tokenB?: string;
  amountA: string;
  amountB?: string;
  type: 'supply' | 'withdraw' | 'stake' | 'unstake' | 'deposit';
}

export interface Transaction {
  to: string;
  data: string;
  value: string;
  gasLimit?: bigint;
  network: NetworkName;
  spender: string;
}

export interface StakingBalance {
  tokenAddress: string;
  symbol: string;
  name: string;
  balance: string;
}
export interface IStakingProvider {
  /**
   * Get the name of the DEX provider
   */
  getName(): string;

  /**
   * Get supported networks for this provider
   */
  getSupportedNetworks(): NetworkName[];

  /**
   * Get the provider-specific prompt that helps guide the AI in using this provider effectively
   * This is optional - if not implemented, no special prompt will be used
   */
  getPrompt?(): string;

  /**
   * Check if user has sufficient balance for the swap
   * @param quote The swap quote to check balance against
   * @param walletAddress The address of the user
   * @returns Promise<{ isValid: boolean; message?: string }> Returns if balance is sufficient and error message if not
   */
  checkBalance(
    quote: StakingQuote,
    walletAddress: string,
  ): Promise<{ isValid: boolean; message?: string }>;

  /**
   * Adjusts a token amount based on user's balance to handle precision issues
   * @param tokenAddress The address of the token to adjust
   * @param amount The requested amount
   * @param walletAddress The user's wallet address
   * @param network The blockchain network
   * @returns The adjusted amount that can be safely used
   */
  adjustAmount(
    tokenAddress: string,
    amount: string,
    walletAddress: string,
    network: NetworkName,
  ): Promise<string>;

  /**
   * Invalidates the balance cache for a specific token and wallet
   * @param tokenAddress The address of the token
   * @param walletAddress The address of the wallet
   * @param network The blockchain network
   */
  invalidateBalanceCache(tokenAddress: string, walletAddress: string, network: NetworkName): void;

  /**
   * Get a quote for swapping tokens
   */
  getQuote(params: StakingParams, walletAddress: string): Promise<StakingQuote>;

  /**
   * Build a transaction for swapping tokens
   * @param quote The quote to execute
   * @param walletAddress The address of the user who will execute the swap
   */
  buildStakingTransaction(quote: StakingQuote, walletAddress: string): Promise<Transaction>;

  /**
   * Build a transaction for approving token spending
   * @param network The network to approve
   * @param tokenAddress The address of the token to approve
   * @param spender The address to approve spending for
   * @param amount The amount to approve
   * @param walletAddress The address of the user who will approve
   */
  buildApproveTransaction(
    network: NetworkName,
    tokenAddress: string,
    spender: string,
    amount: string,
    walletAddress: string,
  ): Promise<Transaction>;

  /**
   * Check the allowance of a token for a spender
   * @param network The network to check
   * @param tokenAddress The address of the token to check
   * @param owner The owner of the tokens
   * @param spender The address to check allowance for
   */
  checkAllowance(
    network: NetworkName,
    tokenAddress: string,
    owner: string,
    spender: string,
  ): Promise<bigint>;

  /**
   * Get all staking balances for a user
   * @param walletAddress The address of the user
   */
  getAllStakingBalances(walletAddress: string): Promise<{
    address: string;
    tokens: StakingBalance[];
  }>;

  /**
   * Get all claimable balances for a user
   * @param walletAddress The address of the user
   */
  getAllClaimableBalances(walletAddress: string): Promise<{
    address: string;
    tokens: StakingBalance[];
  }>;

  /**
   * Build a transaction for claiming a balance
   * @param uuid The UUID of the claimable balance
   */
  buildClaimTransaction(uuid: string): Promise<Transaction>;
}
