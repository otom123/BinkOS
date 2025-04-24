import { ethers } from 'ethers';
import {
  Keypair,
  Transaction as SolanaTransaction,
  VersionedTransaction,
  Connection,
  sendAndConfirmTransaction,
  sendAndConfirmRawTransaction,
} from '@solana/web3.js';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { Network } from '../network';
import { NetworkName } from '../network/types';
import {
  WalletConfig,
  SignMessageParams,
  SignTransactionParams,
  TransactionType,
  IWallet,
  TransactionRequest,
  TransactionReceipt,
  SignedTransactionRequest,
} from './types';

export class Wallet implements IWallet {
  readonly #evmWallet: ethers.HDNodeWallet;
  readonly #solanaKeypair: Keypair;
  readonly #network: Network;

  constructor(config: WalletConfig, network: Network) {
    this.#network = network;

    // Initialize EVM wallet
    this.#evmWallet = ethers.Wallet.fromPhrase(config.seedPhrase);

    // Initialize Solana wallet
    const seed = mnemonicToSeedSync(config.seedPhrase);
    const derivedPath = `m/44'/501'/${config.index ?? 0}'/0'`;
    const keyPair = derivePath(derivedPath, seed.toString('hex'));
    this.#solanaKeypair = Keypair.fromSeed(keyPair.key);
  }

  public async getAddress(network: NetworkName): Promise<string> {
    const networkType = this.#network.getNetworkType(network);

    if (networkType === 'evm') {
      return this.#evmWallet.address;
    } else {
      return this.#solanaKeypair.publicKey.toString();
    }
  }

  public async signMessage(params: SignMessageParams): Promise<string> {
    const networkType = this.#network.getNetworkType(params.network);

    if (networkType === 'evm') {
      return await this.#evmWallet.signMessage(params.message);
    } else {
      const messageBytes = new TextEncoder().encode(params.message);
      const signature = nacl.sign.detached(messageBytes, this.#solanaKeypair.secretKey);
      return bs58.encode(signature);
    }
  }

  public async signTransaction(params: SignTransactionParams): Promise<string> {
    const networkType = this.#network.getNetworkType(params.network);
    const transaction = params.transaction as TransactionType;

    if (networkType === 'evm') {
      const evmTx = transaction as ethers.Transaction;
      const signer = this.#evmWallet.connect(this.#network.getProvider(params.network, 'evm'));
      return await signer.signTransaction(evmTx);
    } else {
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([this.#solanaKeypair]);
        return Buffer.from(transaction.serialize()).toString('base64');
      } else if (transaction instanceof SolanaTransaction) {
        transaction.partialSign(this.#solanaKeypair);
        return Buffer.from(transaction.serialize()).toString('base64');
      }
      throw new Error('Invalid Solana transaction type');
    }
  }

  public async getPublicKey(network: NetworkName): Promise<string> {
    const networkType = this.#network.getNetworkType(network);

    if (networkType === 'evm') {
      return this.#evmWallet.publicKey;
    } else {
      return this.#solanaKeypair.publicKey.toBase58();
    }
  }

  // TODO: THIS METHOD WILL BE REMOVED IN THE FUTURE
  public async getPrivateKey(network: NetworkName): Promise<string> {
    const networkType = this.#network.getNetworkType(network);

    if (networkType === 'evm') {
      return this.#evmWallet.privateKey;
    } else {
      return bs58.encode(this.#solanaKeypair.secretKey);
    }
  }

  public async waitForSolanaTransaction(
    connection: Connection,
    signature: string,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<void> {
    const result = await connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      'confirmed',
    );

    if (result.value.err) {
      throw new Error(`Transaction failed: ${result.value.err.toString()}`);
    }
  }

  async watchTransaction(
    connection: Connection,
    txHash: string,
    serializedTx?: string,
    sendTransaction?: any,
    retry: number = 20,
  ): Promise<{ confirmed: boolean; message: string }> {
    if (retry <= 0) {
      return {
        confirmed: false,
        message: `❌ Transaction not confirmed`,
      };
    }

    try {
      const status = await connection.getSignatureStatus(txHash);

      if (
        status.value?.confirmationStatus !== 'confirmed' &&
        status.value?.confirmationStatus !== 'finalized'
      ) {
        await new Promise(r => setTimeout(r, 1500));

        if (serializedTx && sendTransaction) {
          sendTransaction(serializedTx);
        }

        return await this.watchTransaction(
          connection,
          txHash,
          serializedTx,
          sendTransaction,
          retry - 1,
        );
      }

      if (status.value?.err) {
        console.log(status.value?.err);
        return {
          confirmed: false,
          message: `❌ Transaction failed. Error: ${JSON.stringify(status.value?.err)}`,
        };
      }

      return {
        confirmed: true,
        message: '✅ Transaction submitted successfully',
      };
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500));

      if (serializedTx && sendTransaction) {
        sendTransaction(serializedTx);
      }

      return await this.watchTransaction(
        connection,
        txHash,
        serializedTx,
        sendTransaction,
        retry - 1,
      );
    }
  }

  public async sendTransaction(
    network: NetworkName,
    signedTransaction: SignedTransactionRequest,
  ): Promise<TransactionReceipt> {
    const networkType = this.#network.getNetworkType(network);
    const networkConfig = this.#network.getConfig(network);

    if (networkType === 'evm') {
      const provider = new ethers.JsonRpcProvider(networkConfig.config.rpcUrl);

      const tx = await provider.broadcastTransaction(signedTransaction.transaction);

      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction failed');

      return {
        hash: tx.hash,
        wait: async () => {
          const finalReceipt = await tx.wait();
          if (!finalReceipt) throw new Error('Transaction failed');
          return {
            hash: finalReceipt.hash,
            wait: async () => ({
              hash: finalReceipt.hash,
              wait: async () => {
                throw new Error('Already waited');
              },
            }),
          };
        },
      };
    } else {
      const connection = new Connection(networkConfig.config.rpcUrl);

      // Try to parse as VersionedTransaction first
      let isVersionedTransaction = false;
      try {
        const tx = VersionedTransaction.deserialize(
          Buffer.from(signedTransaction.transaction, 'base64'),
        );

        isVersionedTransaction = true;

        let lastValidBlockHeight = signedTransaction.lastValidBlockHeight;

        if (!tx.message.recentBlockhash) {
          const latestBlockhash = await connection.getLatestBlockhash('finalized');
          tx.message.recentBlockhash = latestBlockhash.blockhash;
          lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
        }

        if (!lastValidBlockHeight) {
          throw new Error('Last valid block height is required');
        }

        const simulation = await connection.simulateTransaction(tx, { sigVerify: true });

        if (simulation.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(simulation.value?.err)}`);
        }

        // Send and confirm transaction
        const signature = await connection.sendTransaction(tx);

        return {
          hash: signature,
          wait: async () => {
            await this.waitForSolanaTransaction(
              connection,
              signature,
              tx.message.recentBlockhash,
              lastValidBlockHeight,
            );
            return {
              hash: signature,
              wait: async () => ({
                hash: signature,
                wait: async () => {
                  throw new Error('Already waited');
                },
              }),
            };
          },
        };
      } catch (e) {
        // If not a VersionedTransaction, try as regular Transaction
        if (isVersionedTransaction) {
          throw e;
        }

        const tx = SolanaTransaction.from(Buffer.from(signedTransaction.transaction, 'base64'));

        if (!tx.recentBlockhash) {
          const latestBlockhash = await connection.getLatestBlockhash('finalized');
          tx.recentBlockhash = latestBlockhash.blockhash;
          tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
        }

        const simulation = await connection.simulateTransaction(tx);

        if (simulation.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(simulation.value?.err)}`);
        }

        // Send and confirm transaction
        const signature = await connection.sendRawTransaction(tx.serialize());

        return {
          hash: signature,
          wait: async () => {
            await this.waitForSolanaTransaction(
              connection,
              signature,
              tx.recentBlockhash!,
              tx.lastValidBlockHeight!,
            );
            return {
              hash: signature,
              wait: async () => ({
                hash: signature,
                wait: async () => {
                  throw new Error('Already waited');
                },
              }),
            };
          },
        };
      }
    }
  }

  public async signAndSendTransaction(
    network: NetworkName,
    transaction: TransactionRequest,
  ): Promise<TransactionReceipt> {
    const networkType = this.#network.getNetworkType(network);
    const networkConfig = this.#network.getConfig(network);
    console.log('🚀 ~ Wallet ~ signAndSendTransaction ~ networkConfig OKOK:', transaction);

    return {
      hash: '0x123FAKE',
      wait: async () => ({
        hash: '0x123FAKE',
        wait: async () => ({
          hash: '0x123FAKE',
          wait: async () => {
            throw new Error('Already waited');
          },
        }),
      }),
    };

    // if (networkType === 'evm') {
    //   const provider = this.#network.getProvider(network, 'evm');
    //   const signer = this.#evmWallet.connect(provider);

    //   // Create and sign transaction
    //   const tx = await signer.populateTransaction({
    //     to: transaction.to,
    //     data: transaction.data,
    //     value: transaction.value,
    //     gasLimit: transaction.gasLimit,
    //   });
    //   const signedTx = await signer.signTransaction(tx);

    //   // Send signed transaction
    //   const sentTx = await provider.broadcastTransaction(signedTx);
    //   const receipt = await sentTx.wait();
    //   if (!receipt) throw new Error('Transaction failed');

    //   return {
    //     hash: sentTx.hash,
    //     wait: async () => {
    //       const finalReceipt = await sentTx.wait();
    //       if (!finalReceipt) throw new Error('Transaction failed');
    //       return {
    //         hash: finalReceipt.hash,
    //         wait: async () => ({
    //           hash: finalReceipt.hash,
    //           wait: async () => {
    //             throw new Error('Already waited');
    //           },
    //         }),
    //       };
    //     },
    //   };
    // } else {
    //   const connection = new Connection(networkConfig.config.rpcUrl);
    //   let isVersionedTransaction = false;
    //   // Try to parse as VersionedTransaction first
    //   try {
    //     let tx = VersionedTransaction.deserialize(Buffer.from(transaction.data, 'base64'));
    //     isVersionedTransaction = true;
    //     let lastValidBlockHeight = transaction.lastValidBlockHeight;
    //     if (!tx.message.recentBlockhash) {
    //       const latestBlockhash = await connection.getLatestBlockhash('finalized');
    //       tx.message.recentBlockhash = latestBlockhash.blockhash;
    //       lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
    //     }

    //     if (!lastValidBlockHeight) {
    //       throw new Error('Last valid block height is required');
    //     }

    //     // Sign transaction
    //     tx.sign([this.#solanaKeypair]);

    //     // Send raw transaction
    //     const rawTransaction = Buffer.from(tx.serialize());
    //     const signature = await connection.sendRawTransaction(rawTransaction, {
    //       skipPreflight: true,
    //       preflightCommitment: 'confirmed',
    //     });

    //     return {
    //       hash: signature,
    //       wait: async () => {
    //         await this.waitForSolanaTransaction(
    //           connection,
    //           signature,
    //           tx.message.recentBlockhash,
    //           lastValidBlockHeight + 5, // fix waiting transaction for 5 blocks
    //         );
    //         return {
    //           hash: signature,
    //           wait: async () => ({
    //             hash: signature,
    //             wait: async () => {
    //               throw new Error('Already waited');
    //             },
    //           }),
    //         };
    //       },
    //     };
    //   } catch (e) {
    //     console.log('🚀 ~ Wallet ~ signAndSendTransactionSolana ~ error:', e);
    //     if (isVersionedTransaction) {
    //       throw e;
    //     }

    //     // If not a VersionedTransaction, try as regular Transaction
    //     const tx = SolanaTransaction.from(Buffer.from(transaction.data, 'base64'));
    //     if (!tx.recentBlockhash) {
    //       const latestBlockhash = await connection.getLatestBlockhash('finalized');
    //       tx.recentBlockhash = latestBlockhash.blockhash;
    //       tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
    //     }
    //     // Sign transaction
    //     tx.sign(this.#solanaKeypair);

    //     // Send raw transaction
    //     const rawTransaction = tx.serialize();
    //     const signature = await connection.sendRawTransaction(rawTransaction, {
    //       skipPreflight: false,
    //       preflightCommitment: 'confirmed',
    //     });

    //     return {
    //       hash: signature,
    //       wait: async () => {
    //         await this.waitForSolanaTransaction(
    //           connection,
    //           signature,
    //           tx.recentBlockhash!,
    //           tx.lastValidBlockHeight! + 5,
    //         );
    //         return {
    //           hash: signature,
    //           wait: async () => ({
    //             hash: signature,
    //             wait: async () => {
    //               throw new Error('Already waited');
    //             },
    //           }),
    //         };
    //       },
    //     };
    //   }
    // }
  }
}
