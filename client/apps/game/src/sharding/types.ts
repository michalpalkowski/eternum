import type { Call } from "starknet";

export interface ExecutableAccount {
  execute: (calls: Call[], details?: Record<string, unknown>) => Promise<unknown>;
  getNonce?: (blockIdentifier?: unknown) => Promise<unknown>;
  address?: string;
  waitForTransaction?: (transactionHash: string) => Promise<unknown>;
  getTransactionReceipt?: (transactionHash: string) => Promise<unknown>;
  provider?: {
    waitForTransaction?: (transactionHash: string) => Promise<unknown>;
    getTransactionReceipt?: (transactionHash: string) => Promise<unknown>;
    getNonceForAddress?: (address: string, blockIdentifier?: unknown) => Promise<unknown>;
  };
}
