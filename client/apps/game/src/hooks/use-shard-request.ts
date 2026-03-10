import { getContractByName } from "@dojoengine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { hash, type Call } from "starknet";
import { dojoConfig } from "../../dojo-config";
import { useShardStore } from "./store/use-shard-store";
import {
  buildShardPlayUrl,
  parseShardIdParts,
  type RequestedShardContext,
  parseOperatorConfigResponse,
  parseShardStatusEntriesFromStatusResponse,
  parseTransportHealthFromStatusResponse,
} from "@/sharding/protocol";
import { resolveMainGameReturnUrl, resolveRuntimeContextFromWindow } from "@/sharding/runtime-context";
import type { ExecutableAccount } from "@/sharding/types";

export type ShardRequestPhase = "idle" | "requesting" | "waiting" | "ready" | "error";
export type ShardRequestErrorCode =
  | "MISSING_ACCOUNT"
  | "INVALID_ENTITY_IDS"
  | "MISSING_OPERATOR_URL"
  | "OPERATOR_CONFIG_FAILED"
  | "EXECUTE_FAILED"
  | "TX_HASH_MISSING"
  | "RECEIPT_UNSUPPORTED"
  | "RECEIPT_FAILED"
  | "SHARD_ID_RESOLUTION_FAILED"
  | "REQUEST_TIMEOUT"
  | "OPERATOR_REJECTED"
  | "POLL_FAILED";

interface ShardUrls {
  katanaUrl: string;
  toriiUrl: string;
  toriiGrpcUrl: string | null;
  gameContractAddress: string;
  shardId: string;
}

interface UseShardRequestOptions {
  shardingContractAddress?: string | null;
  worldAddress?: string | null;
}

const SHARDING_REQUESTED_SELECTOR = hash.getSelectorFromName("ShardingRequested").toLowerCase();
const SHARD_REQUEST_POLL_INTERVAL_MS = 2000;
const SHARD_REQUEST_TIMEOUT_MS = 120_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeFeltToHex = (value: unknown, fieldName: string): string => {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`.toLowerCase();
  }

  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return `0x${BigInt(value).toString(16)}`.toLowerCase();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} must not be empty`);
    }
    try {
      return `0x${BigInt(trimmed).toString(16)}`.toLowerCase();
    } catch {
      throw new Error(`${fieldName} must be a valid felt value`);
    }
  }

  throw new Error(`${fieldName} must be a felt-compatible value`);
};

const normalizeOnchainShardId = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("onchain shard id must not be empty");
  }
  try {
    return `0x${BigInt(trimmed).toString(16)}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

const parseTxHashFromExecuteResult = (executeResult: unknown): string => {
  if (typeof executeResult === "string" || typeof executeResult === "bigint" || typeof executeResult === "number") {
    return normalizeFeltToHex(executeResult, "transaction_hash");
  }

  if (!isRecord(executeResult)) {
    throw new Error("execute() result must include transaction_hash");
  }

  const rawHash = executeResult.transaction_hash ?? executeResult.transactionHash;
  if (rawHash === undefined || rawHash === null) {
    throw new Error("execute() result is missing transaction_hash");
  }

  return normalizeFeltToHex(rawHash, "transaction_hash");
};

const extractReceiptEvents = (receipt: unknown): Array<Record<string, unknown>> => {
  if (!isRecord(receipt)) {
    return [];
  }

  const fromRoot = receipt.events;
  if (Array.isArray(fromRoot)) {
    return fromRoot.filter((event): event is Record<string, unknown> => isRecord(event));
  }

  const nestedReceipt = receipt.receipt;
  if (!isRecord(nestedReceipt)) {
    return [];
  }

  const fromNested = nestedReceipt.events;
  if (!Array.isArray(fromNested)) {
    return [];
  }

  return fromNested.filter((event): event is Record<string, unknown> => isRecord(event));
};

const resolveReceiptFromAccount = async (account: ExecutableAccount, txHash: string): Promise<unknown> => {
  if (typeof account.waitForTransaction === "function") {
    return account.waitForTransaction(txHash);
  }
  if (typeof account.provider?.waitForTransaction === "function") {
    return account.provider.waitForTransaction(txHash);
  }
  if (typeof account.getTransactionReceipt === "function") {
    return account.getTransactionReceipt(txHash);
  }
  if (typeof account.provider?.getTransactionReceipt === "function") {
    return account.provider.getTransactionReceipt(txHash);
  }
  throw new Error("Account does not support transaction receipt lookup");
};

const resolveRequestedShardContextFromReceipt = (params: {
  txHash: string;
  receipt: unknown;
  expectedGameContractAddress: string;
  expectedShardContractAddress: string;
}): RequestedShardContext => {
  const events = extractReceiptEvents(params.receipt);
  for (const event of events) {
    const rawFromAddress = event.from_address ?? event.fromAddress;
    const rawKeys = event.keys;
    const rawData = event.data;
    if (!Array.isArray(rawKeys) || !Array.isArray(rawData)) {
      continue;
    }
    if (rawKeys.length === 0 || rawData.length === 0) {
      continue;
    }

    let fromAddress: string;
    let selector: string;
    let gameAddressFromEvent: string | null = null;
    let onchainShardId: string;
    try {
      fromAddress = normalizeFeltToHex(rawFromAddress, "event.from_address");
      selector = normalizeFeltToHex(rawKeys[0], "event.keys[0]");
      if (rawKeys.length > 1) {
        gameAddressFromEvent = normalizeFeltToHex(rawKeys[1], "event.keys[1]");
      }
      onchainShardId = normalizeFeltToHex(rawData[0], "event.data[0]");
    } catch {
      continue;
    }

    if (fromAddress !== params.expectedShardContractAddress) {
      continue;
    }
    if (selector !== SHARDING_REQUESTED_SELECTOR) {
      continue;
    }
    if (gameAddressFromEvent !== null && gameAddressFromEvent !== params.expectedGameContractAddress) {
      continue;
    }

    return {
      txHash: params.txHash,
      gameContractAddress: params.expectedGameContractAddress,
      onchainShardId,
      shardId: `${params.expectedGameContractAddress}@${onchainShardId}`,
    };
  }

  throw new Error("ShardingRequested event not found in transaction receipt");
};

const resolveRequestedShardContextFromChain = async (params: {
  txHash: string;
  account: ExecutableAccount;
  expectedGameContractAddress: string;
  expectedShardContractAddress: string;
}): Promise<RequestedShardContext> => {
  const callContract = params.account.provider?.callContract;
  if (typeof callContract !== "function") {
    throw new Error("Account provider does not support callContract fallback");
  }

  const result = await callContract({
    contractAddress: params.expectedShardContractAddress,
    entrypoint: "get_shard_id",
    calldata: [params.expectedGameContractAddress],
  });

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error("get_shard_id returned empty result");
  }

  const onchainShardId = normalizeFeltToHex(result[0], "get_shard_id[0]");

  return {
    txHash: params.txHash,
    gameContractAddress: params.expectedGameContractAddress,
    onchainShardId,
    shardId: `${params.expectedGameContractAddress}@${onchainShardId}`,
  };
};

const parseOperatorRejection = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const reason = typeof payload.error === "string" ? payload.error : null;
  const code = typeof payload.error_code === "string" ? payload.error_code : null;
  if (reason === null) {
    return null;
  }
  return code === null ? reason : `${reason} (${code})`;
};

const fetchOperatorConfig = async (operatorUrl: string) => {
  const configResponse = await fetch(`${operatorUrl}/config`);
  if (!configResponse.ok) {
    throw new Error(`Failed to fetch operator config: HTTP ${configResponse.status}`);
  }
  const configPayload: unknown = await configResponse.json();
  return parseOperatorConfigResponse(configPayload);
};

const isShardAlreadyLockedError = (message: string): boolean =>
  /slot locked by shard/i.test(message) || /locked by shard/i.test(message);

const buildRequestedShardContextFromShardId = (shardId: string): RequestedShardContext => {
  const parts = parseShardIdParts(shardId);
  const normalizedOnchainShardId = normalizeOnchainShardId(parts.onchainShardId);

  return {
    txHash: "0x0",
    gameContractAddress: parts.gameContractAddress,
    onchainShardId: normalizedOnchainShardId,
    shardId: `${parts.gameContractAddress}@${normalizedOnchainShardId}`,
  };
};

export const useShardRequest = (
  account: ExecutableAccount | null,
  operatorUrl: string,
  options?: UseShardRequestOptions,
) => {
  const [phase, setPhase] = useState<ShardRequestPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShardRequestErrorCode | null>(null);
  const [shardUrls, setShardUrls] = useState<ShardUrls | null>(null);
  const [targetShardId, setTargetShardId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollLockRef = useRef(false);
  const pollStartedAtRef = useRef<number | null>(null);
  const pollTargetRef = useRef<RequestedShardContext | null>(null);
  const setMainShardRequestState = useShardStore((state) => state.setMainShardRequestState);
  const clearMainShardRequestState = useShardStore((state) => state.clearMainShardRequestState);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollStartedAtRef.current = null;
    pollTargetRef.current = null;
    pollLockRef.current = false;
  }, []);

  const failRequest = useCallback(
    (code: ShardRequestErrorCode, message: string) => {
      const currentTargetShardId = pollTargetRef.current?.shardId ?? targetShardId;
      stopPolling();
      setErrorCode(code);
      setError(message);
      setPhase("error");
      setMainShardRequestState({
        phase: "error",
        targetShardId: currentTargetShardId,
        errorCode: code,
        error: message,
      });
    },
    [setMainShardRequestState, stopPolling, targetShardId],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const pollShardStatus = useCallback(async () => {
    if (pollLockRef.current) {
      return;
    }

    const target = pollTargetRef.current;
    if (target === null) {
      return;
    }

    const startedAt = pollStartedAtRef.current;
    if (startedAt !== null && Date.now() - startedAt >= SHARD_REQUEST_TIMEOUT_MS) {
      failRequest(
        "REQUEST_TIMEOUT",
        `Shard request timed out after ${Math.round(SHARD_REQUEST_TIMEOUT_MS / 1000)}s`,
      );
      return;
    }

    pollLockRef.current = true;
    try {
      const statusResponse = await fetch(`${operatorUrl}/shard/${target.gameContractAddress}`);

      if (statusResponse.status === 404) {
        return;
      }
      if (statusResponse.status === 409) {
        const payload: unknown = await statusResponse.json().catch(() => null);
        const rejection = parseOperatorRejection(payload);
        failRequest(
          "OPERATOR_REJECTED",
          rejection ?? `Operator rejected shard request: HTTP ${statusResponse.status}`,
        );
        return;
      }
      if (!statusResponse.ok) {
        throw new Error(`Failed to fetch shard status: HTTP ${statusResponse.status}`);
      }

      const statusPayload: unknown = await statusResponse.json();
      const shardEntries = parseShardStatusEntriesFromStatusResponse(statusPayload);
      const normalizedTargetOnchainId = normalizeOnchainShardId(target.onchainShardId);
      const shardEntry = shardEntries.find((entry) => {
        if (entry.gameContractAddress !== target.gameContractAddress) {
          return false;
        }
        const entryShardIdParts = parseShardIdParts(entry.shardId);
        return normalizeOnchainShardId(entryShardIdParts.onchainShardId) === normalizedTargetOnchainId;
      });
      if (shardEntry === undefined) {
        return;
      }

      const entryShardIdParts = parseShardIdParts(shardEntry.shardId);

      const transportResponse = await fetch(
        `${operatorUrl}/shard/${target.gameContractAddress}/${entryShardIdParts.onchainShardId}/transport-health`,
      );
      if (!transportResponse.ok) {
        throw new Error(`Failed to fetch shard transport health: HTTP ${transportResponse.status}`);
      }
      const transportPayload: unknown = await transportResponse.json();
      const transport = parseTransportHealthFromStatusResponse(transportPayload);
      if (transport.status !== "healthy") {
        return;
      }
      if (shardEntry.katanaUrl === null || shardEntry.toriiUrl === null) {
        return;
      }

      stopPolling();
      setShardUrls({
        katanaUrl: shardEntry.katanaUrl,
        toriiUrl: shardEntry.toriiUrl,
        toriiGrpcUrl: shardEntry.toriiGrpcUrl,
        gameContractAddress: shardEntry.gameContractAddress,
        shardId: shardEntry.shardId,
      });
      setErrorCode(null);
      setError(null);
      setPhase("ready");
      setMainShardRequestState({
        phase: "ready",
        targetShardId: shardEntry.shardId,
      });
    } catch (pollError) {
      const message = pollError instanceof Error ? pollError.message : "Failed to poll shard status";
      failRequest("POLL_FAILED", message);
    } finally {
      pollLockRef.current = false;
    }
  }, [failRequest, operatorUrl, stopPolling]);

  const beginTrackingRequestedShard = useCallback(
    (requestedContext: RequestedShardContext) => {
      stopPolling();
      setShardUrls(null);
      setTargetShardId(requestedContext.shardId);
      setErrorCode(null);
      setError(null);
      setPhase("waiting");
      setMainShardRequestState({
        phase: "waiting",
        targetShardId: requestedContext.shardId,
      });
      pollTargetRef.current = requestedContext;
      pollStartedAtRef.current = Date.now();
      pollRef.current = setInterval(() => {
        void pollShardStatus();
      }, SHARD_REQUEST_POLL_INTERVAL_MS);
      void pollShardStatus();
    },
    [pollShardStatus, setMainShardRequestState, stopPolling],
  );

  const recoverShard = useCallback(async () => {
    if (account === null) {
      failRequest("MISSING_ACCOUNT", "Wallet account is required to recover an existing shard");
      return;
    }
    if (operatorUrl.trim().length === 0) {
      failRequest("MISSING_OPERATOR_URL", "Missing shard operator URL");
      return;
    }

    const persistedTargetShardId = useShardStore.getState().mainShardTargetShardId;
    const candidateShardId = targetShardId ?? persistedTargetShardId;
    if (candidateShardId !== null) {
      try {
        beginTrackingRequestedShard(buildRequestedShardContextFromShardId(candidateShardId));
        return;
      } catch {
        // Fall through to an on-chain lookup when the cached shard id is malformed.
      }
    }

    try {
      const operatorConfig = await fetchOperatorConfig(operatorUrl);
      const worldAddress = options?.worldAddress?.trim() || dojoConfig.manifest.world.address;
      const normalizedWorldAddress = normalizeFeltToHex(worldAddress, "world_address");
      const normalizedShardContractAddress = normalizeFeltToHex(
        operatorConfig.shardContractAddress,
        "shard_contract_address",
      );
      const requestedContext = await resolveRequestedShardContextFromChain({
        txHash: "0x0",
        account,
        expectedGameContractAddress: normalizedWorldAddress,
        expectedShardContractAddress: normalizedShardContractAddress,
      });
      beginTrackingRequestedShard(requestedContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to recover existing shard";
      if (message.startsWith("Failed to fetch operator config: HTTP")) {
        failRequest("OPERATOR_CONFIG_FAILED", message);
        return;
      }
      failRequest("SHARD_ID_RESOLUTION_FAILED", message);
    }
  }, [
    account,
    beginTrackingRequestedShard,
    failRequest,
    operatorUrl,
    options?.worldAddress,
    targetShardId,
  ]);

  const requestShard = useCallback(
    async (entityIds: number[]) => {
      if (phase !== "idle") {
        return;
      }
      if (account === null) {
        failRequest("MISSING_ACCOUNT", "Wallet account is required to request a shard");
        return;
      }
      if (entityIds.length === 0) {
        failRequest("INVALID_ENTITY_IDS", "entityIds must not be empty");
        return;
      }
      if (operatorUrl.trim().length === 0) {
        failRequest("MISSING_OPERATOR_URL", "Missing shard operator URL");
        return;
      }

      setPhase("requesting");
      setErrorCode(null);
      setError(null);
      setShardUrls(null);
      setTargetShardId(null);
      setMainShardRequestState({
        phase: "requesting",
        targetShardId: null,
      });

      try {
        const operatorConfig = await fetchOperatorConfig(operatorUrl);

        const shardingContract = getContractByName(dojoConfig.manifest, "s1_eternum", "sharding_systems");
        const shardingContractAddress = options?.shardingContractAddress?.trim() || shardingContract.address;
        const worldAddress = options?.worldAddress?.trim() || dojoConfig.manifest.world.address;
        const normalizedWorldAddress = normalizeFeltToHex(worldAddress, "world_address");
        const normalizedShardContractAddress = normalizeFeltToHex(
          operatorConfig.shardContractAddress,
          "shard_contract_address",
        );

        const requestShardCall: Call = {
          contractAddress: shardingContractAddress,
          entrypoint: "request_shard_all",
          calldata: [
            operatorConfig.shardContractAddress,
            entityIds.length.toString(),
            ...entityIds.map((entityId) => entityId.toString()),
          ],
        };
        let executeResult: unknown;
        try {
          executeResult = await account.execute([requestShardCall]);
        } catch (error) {
          const message = error instanceof Error ? error.message : "request_shard_all transaction failed";
          if (isShardAlreadyLockedError(message)) {
            try {
              const requestedContext = await resolveRequestedShardContextFromChain({
                txHash: "0x0",
                account,
                expectedGameContractAddress: normalizedWorldAddress,
                expectedShardContractAddress: normalizedShardContractAddress,
              });
              beginTrackingRequestedShard(requestedContext);
              return;
            } catch (recoveryError) {
              const recoveryMessage =
                recoveryError instanceof Error ? recoveryError.message : "Failed to recover existing shard";
              failRequest("EXECUTE_FAILED", `${message}; recovery via get_shard_id failed: ${recoveryMessage}`);
              return;
            }
          }
          failRequest("EXECUTE_FAILED", message);
          return;
        }

        let txHash: string;
        try {
          txHash = parseTxHashFromExecuteResult(executeResult);
        } catch (error) {
          const message = error instanceof Error ? error.message : "execute() returned invalid transaction hash";
          failRequest("TX_HASH_MISSING", message);
          return;
        }

        let receipt: unknown;
        try {
          receipt = await resolveReceiptFromAccount(account, txHash);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to resolve transaction receipt";
          if (message.includes("does not support transaction receipt lookup")) {
            failRequest("RECEIPT_UNSUPPORTED", message);
            return;
          }
          failRequest("RECEIPT_FAILED", message);
          return;
        }

        let requestedContext: RequestedShardContext;
        try {
          requestedContext = resolveRequestedShardContextFromReceipt({
            txHash,
            receipt,
            expectedGameContractAddress: normalizedWorldAddress,
            expectedShardContractAddress: normalizedShardContractAddress,
          });
        } catch (error) {
          const receiptResolutionMessage =
            error instanceof Error ? error.message : "Failed to resolve shard ID from receipt";

          try {
            requestedContext = await resolveRequestedShardContextFromChain({
              txHash,
              account,
              expectedGameContractAddress: normalizedWorldAddress,
              expectedShardContractAddress: normalizedShardContractAddress,
            });
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error
                ? fallbackError.message
                : "Failed to resolve shard ID from on-chain fallback";
            failRequest(
              "SHARD_ID_RESOLUTION_FAILED",
              `${receiptResolutionMessage}; fallback get_shard_id failed: ${fallbackMessage}`,
            );
            return;
          }
        }

        beginTrackingRequestedShard(requestedContext);
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : "Shard request failed";
        failRequest("OPERATOR_CONFIG_FAILED", message);
      }
    },
    [
      account,
      failRequest,
      operatorUrl,
      options?.shardingContractAddress,
      options?.worldAddress,
      phase,
      beginTrackingRequestedShard,
    ],
  );

  const openShardTab = useCallback(() => {
    if (phase !== "ready" || shardUrls === null) {
      return;
    }

    const runtimeContext = resolveRuntimeContextFromWindow();
    const shardUrl = buildShardPlayUrl(window.location.origin, {
      rpcUrl: shardUrls.katanaUrl,
      toriiUrl: shardUrls.toriiUrl,
      toriiGrpcUrl: shardUrls.toriiGrpcUrl ?? shardUrls.toriiUrl,
      shardId: shardUrls.shardId,
      operatorUrl,
      mainUrl: resolveMainGameReturnUrl(runtimeContext),
    });
    window.location.assign(shardUrl);
  }, [operatorUrl, phase, shardUrls]);

  const reset = useCallback(() => {
    stopPolling();
    setPhase("idle");
    setErrorCode(null);
    setError(null);
    setShardUrls(null);
    setTargetShardId(null);
    clearMainShardRequestState();
  }, [clearMainShardRequestState, stopPolling]);

  return {
    phase,
    errorCode,
    error,
    shardUrls,
    targetShardId,
    requestShard,
    recoverShard,
    openShardTab,
    reset,
  };
};
