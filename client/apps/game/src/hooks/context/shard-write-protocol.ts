/**
 * Shard Write Protocol — guarantees gameplay writes target the shard Katana,
 * never the main chain.
 *
 * Problem: shard Katana forks Sepolia, so `starknet_chainId` returns the same
 * `SN_SEPOLIA` on both. Chain-based switching cannot distinguish them.
 * The ONLY distinguishing factor is the RPC URL.
 *
 * Solution: use `controller.switchRpc(shardRpcUrl)` to point the keychain at
 * the shard endpoint. This recreates the account with a provider bound to
 * the shard URL. All subsequent `execute()` calls go through the keychain
 * which routes to the switched RPC.
 *
 * The write guard (Proxy on `execute`) provides a runtime safety net:
 * before every TX it verifies the controller's active `rpcUrl()` matches
 * the expected shard URL. If someone accidentally switches back, the TX
 * is blocked with a clear error.
 */

import type { AccountInterface } from "starknet";

/**
 * Minimal controller interface required by the shard write protocol.
 * The actual Controller class (from @cartridge/controller fork) implements these,
 * but the published types don't include them — hence the separate interface.
 */
export type ShardableController = {
  rpcUrl: () => string;
  switchRpc: (rpcUrl: string) => Promise<void>;
};

const SHARD_GUARD_MARKER = Symbol("shard-write-guard");

export class ShardWriteProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ShardWriteProtocolError";
  }
}

const normalizeRpcUrl = (value: string): string => {
  const parsed = new URL(value);
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

/**
 * Switch the controller's keychain to route TX through the shard RPC.
 *
 * This calls `controller.switchRpc(shardRpcUrl)` which:
 * 1. Tells the keychain to use the shard URL for TX submission
 * 2. Calls `probe()` to recreate the account with the new provider
 *
 * After this, `controller.rpcUrl()` returns the shard URL and
 * `controller.account.execute()` routes through it.
 */
export const enforceControllerShardRpc = async (
  controller: ShardableController,
  shardRpcUrl: string,
): Promise<{ rpcUrl: string }> => {
  if (!controller.switchRpc) {
    throw new ShardWriteProtocolError(
      "Controller does not support switchRpc() — update @cartridge/controller to the shard-aware fork",
    );
  }

  await controller.switchRpc(shardRpcUrl);

  // Verify the switch actually took effect
  const activeRpc = controller.rpcUrl?.();
  if (!activeRpc) {
    throw new ShardWriteProtocolError("Controller does not expose rpcUrl() after switchRpc");
  }

  const normalizedActive = normalizeRpcUrl(activeRpc);
  const normalizedExpected = normalizeRpcUrl(shardRpcUrl);
  if (normalizedActive !== normalizedExpected) {
    throw new ShardWriteProtocolError(
      `switchRpc succeeded but rpcUrl mismatch: active=${normalizedActive}, expected=${normalizedExpected}`,
    );
  }

  return { rpcUrl: normalizedExpected };
};

/**
 * Wrap an account with a runtime guard that blocks `execute()` if the
 * controller is not pointing at the expected shard RPC.
 *
 * This is defense-in-depth: even if something re-switches the controller
 * back to the main chain, the guard catches it before any TX leaves.
 */
export const withShardWriteGuard = (
  account: AccountInterface,
  params: {
    controller: ShardableController;
    shardRpcUrl: string;
  },
): AccountInterface => {
  type GuardedAccount = AccountInterface & {
    [SHARD_GUARD_MARKER]?: { rpcUrl: string };
  };

  const guarded = account as GuardedAccount;
  const normalizedRpcUrl = normalizeRpcUrl(params.shardRpcUrl);

  // Already guarded with same URL — return as-is
  if (guarded[SHARD_GUARD_MARKER]?.rpcUrl === normalizedRpcUrl) {
    return account;
  }

  const proxy = new Proxy(account as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      if (property === SHARD_GUARD_MARKER) {
        return { rpcUrl: normalizedRpcUrl };
      }

      if (property === "execute") {
        return async (...args: unknown[]) => {
          // Runtime check: is the controller still pointing at shard?
          const activeRpc = params.controller.rpcUrl?.();
          if (!activeRpc) {
            throw new ShardWriteProtocolError("Shard write blocked: controller rpcUrl() unavailable");
          }

          if (normalizeRpcUrl(activeRpc) !== normalizedRpcUrl) {
            throw new ShardWriteProtocolError(
              `Shard write blocked: controller pointing at ${normalizeRpcUrl(activeRpc)}, expected ${normalizedRpcUrl}`,
            );
          }

          console.log("[shard-guard] TX via:", activeRpc);

          const execute = (target as any).execute;
          return await execute.apply(account, args);
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });

  return proxy as unknown as AccountInterface;
};
