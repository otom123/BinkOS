export interface SwapMcpServerOptions {
  name: string;
  version: string;
  data: {
    rpcUrl: string;
    fromToken: string;
    toToken: string;
    amount: string;
    amountType: string;
    network: string;
    provider: string;
    slippage: number;
  };
}
