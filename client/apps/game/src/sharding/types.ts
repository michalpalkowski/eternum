import type { Call } from "starknet";

export interface ExecutableAccount {
  execute: (calls: Call[]) => Promise<unknown>;
  waitForTransaction?: (transactionHash: string) => Promise<unknown>;
  getTransactionReceipt?: (transactionHash: string) => Promise<unknown>;
  provider?: {
    waitForTransaction?: (transactionHash: string) => Promise<unknown>;
    getTransactionReceipt?: (transactionHash: string) => Promise<unknown>;
  };
}
