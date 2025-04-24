import axios from 'axios';
import {
  ITokenProvider,
  TokenInfo,
  TokenInfoSecurity,
  TokenQueryParams,
} from '@binkai/token-plugin';
import {
  AlchemyConfig,
  AlchemyTokenResponse,
  TokenOverviewResponse,
  TokenSecurityResponse,
  CHAIN_MAPPING,
  SupportedChain,
} from './types';
import { NetworkName } from '@binkai/core';
import { IWalletProvider, WalletInfo } from '@binkai/wallet-plugin';
import { ethers } from 'ethers';
export class AlchemyProvider implements ITokenProvider, IWalletProvider {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly supportedNetworks: NetworkName[];

  constructor(config: AlchemyConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://api.g.alchemy.com';
    this.apiKey = config.apiKey;
    this.supportedNetworks = Object.keys(CHAIN_MAPPING) as NetworkName[];
  }

  getName(): string {
    return 'alchemy';
  }

  getSupportedNetworks(): NetworkName[] {
    return this.supportedNetworks;
  }

  searchTokens(query: string, network: NetworkName): Promise<TokenInfo[]> {
    throw new Error('Not implemented');
  }

  private isNetworkSupported(network: NetworkName): boolean {
    return this.supportedNetworks.includes(network);
  }

  private mapChain(network: NetworkName): string {
    const mappedChain = CHAIN_MAPPING[network as SupportedChain];
    if (!mappedChain) {
      throw new Error(`Network ${network} is not supported by Alchemy`);
    }
    return mappedChain;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };

    return headers;
  }
  private isAddress(query: string): boolean {
    // Basic address validation - can be enhanced based on network requirements
    return /^[0-9a-zA-Z]{32,44}$/.test(query);
  }

  private async getTokenOverview(
    address: string,
    network: NetworkName,
  ): Promise<TokenOverviewResponse> {
    try {
      const response = await axios.get(`${this.baseUrl}/defi/token_overview`, {
        headers: this.getHeaders(),
        params: {
          address: address,
        },
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Alchemy API token overview error: ${error.response?.data?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  async getTokenInfo(params: TokenQueryParams): Promise<TokenInfo> {
    try {
      console.log('getTokenInfo alchemy:', params);

      const walletInfo = await this.getWalletInfo(params.query, params.network);
      console.log('walletInfo:', walletInfo);

      return {} as TokenInfo;
    } catch (error) {
      throw new Error('Not implemented');
    }
  }

  async isValidAddress(address: string, network: NetworkName): Promise<boolean> {
    if (!this.isNetworkSupported(network)) {
      return false;
    }

    if (!this.isAddress(address)) {
      return false;
    }

    try {
      const response = await this.getTokenOverview(address, network);
      return response.success;
    } catch {
      return false;
    }
  }

  async getWalletInfo(address: string, network: NetworkName): Promise<WalletInfo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/data/v1/${this.apiKey}/assets/tokens/by-address`,
        {
          addresses: [
            {
              address: address,
              networks: this.mapChain(network),
            },
          ],
          withMetadata: true,
          withPrices: true,
        },
        {
          headers: this.getHeaders(),
          params: { wallet: address },
        },
      );

      let data;
      if (response.data && response.data.data && response.data.data.tokens) {
        const tokens = response.data.data.tokens;
        data = tokens
          .filter(
            (token: any) =>
              token.tokenPrices.length > 0 && BigInt(token.tokenBalance) > 0n && token.tokenAddress,
          )
          .map((token: any) => {
            return {
              tokenAddress: token?.tokenAddress,
              symbol: token?.tokenMetadata?.symbol,
              name: token?.tokenMetadata?.name,
              decimals: token?.tokenMetadata?.decimals,
              usdValue: token?.tokenPrices?.[0]?.value || 0,
              balance: ethers.formatUnits(token?.tokenBalance, token?.tokenMetadata?.decimals),
            };
          });
      }

      return {
        address: address,
        nativeBalance: undefined,
        tokens: data,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Alchemy API error: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  formatBalance(balance: string): string {
    const formattedBalance =
      Number(balance) > 0.001
        ? Number(balance)
            .toFixed(3)
            .replace(/\.?0+$/, '')
        : Number(balance).toFixed(0);
    return formattedBalance;
  }
}
