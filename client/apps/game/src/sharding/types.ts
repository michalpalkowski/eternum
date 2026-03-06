import type { Call } from "starknet";

export interface ExecutableAccount {
  execute: (calls: Call[]) => Promise<unknown>;
}
