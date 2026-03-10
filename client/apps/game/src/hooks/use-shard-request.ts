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
const SHARD_REQUEST_RECEIPT_CAPTURE_KEY = "__eternum_last_shard_request_receipt__";
const RECEIPT_RECOVERY_TIMEOUT_MS = 10_000;
const RECEIPT_RECOVERY_POLL_INTERVAL_MS = 500;

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

const serializeDebugValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeDebugValue(item, seen));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  const serialized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    serialized[key] = serializeDebugValue(nestedValue, seen);
  }
  seen.delete(value);
  return serialized;
};

const isEventLikeRecord = (value: Record<string, unknown>): boolean => {
  const hasAddress =
    value.from_address !== undefined ||
    value.fromAddress !== undefined ||
    value.contract_address !== undefined ||
    value.contractAddress !== undefined ||
    value.address !== undefined;
  const hasKeys = Array.isArray(value.keys);
  const hasData = Array.isArray(value.data);
  return hasAddress && hasKeys && hasData;
};

const unwrapEventRecord = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (isEventLikeRecord(value)) {
    return value;
  }

  const wrappedEvent = value.event;
  if (isRecord(wrappedEvent) && isEventLikeRecord(wrappedEvent)) {
    return wrappedEvent;
  }

  const wrappedValue = value.value;
  if (isRecord(wrappedValue) && isEventLikeRecord(wrappedValue)) {
    return wrappedValue;
  }

  return null;
};

const extractReceiptEvents = (receipt: unknown): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [];
  const seenObjects = new WeakSet<object>();

  const visit = (value: unknown, depth: number) => {
    if (depth > 6) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    const unwrappedEvent = unwrapEventRecord(value);
    if (unwrappedEvent !== null) {
      events.push(unwrappedEvent);
    }

    const nestedKeys = ["events", "event", "receipt", "transaction_receipt", "transactionReceipt", "result", "value"];
    for (const key of nestedKeys) {
      if (key in value) {
        visit(value[key], depth + 1);
      }
    }
  };

  visit(receipt, 0);
  return events;
};

const captureUnresolvedReceipt = (params: {
  txHash: string;
  receipt: unknown;
  reason: string;
  expectedGameContractAddress: string;
  expectedShardContractAddress: string;
}) => {
  const payload = {
    capturedAt: new Date().toISOString(),
    txHash: params.txHash,
    reason: params.reason,
    expectedGameContractAddress: params.expectedGameContractAddress,
    expectedShardContractAddress: params.expectedShardContractAddress,
    extractedEventCount: extractReceiptEvents(params.receipt).length,
    receipt: serializeDebugValue(params.receipt),
  };

  if (typeof window !== "undefined") {
    (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown }).__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__ =
      payload;
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(SHARD_REQUEST_RECEIPT_CAPTURE_KEY, JSON.stringify(payload));
    } catch {
      // Best-effort debug capture only.
    }
  }

  console.warn("[ShardRequest] Failed to resolve ShardingRequested event from receipt", payload);
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
    const rawFromAddress =
      event.from_address ?? event.fromAddress ?? event.contract_address ?? event.contractAddress ?? event.address;
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

const fetchShardStatusEntries = async (operatorUrl: string, gameContractAddress: string) => {
  const statusResponse = await fetch(`${operatorUrl}/shard/${gameContractAddress}`);
  if (!statusResponse.ok) {
    throw new Error(`Failed to fetch shard status: HTTP ${statusResponse.status}`);
  }
  const statusPayload: unknown = await statusResponse.json();
  return parseShardStatusEntriesFromStatusResponse(statusPayload);
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

const isRecoverableShardPhase = (phase: string): boolean => {
  const normalizedPhase = phase.trim().toLowerCase();
  return (
    normalizedPhase.length > 0 &&
    !normalizedPhase.startsWith("failed") &&
    !normalizedPhase.startsWith("completed") &&
    !normalizedPhase.startsWith("settled")
  );
};

const getShardPhasePriority = (phase: string): number => {
  const normalizedPhase = phase.trim().toLowerCase();
  if (normalizedPhase === "gameplay_active") return 4;
  if (normalizedPhase === "torii_ready") return 3;
  if (normalizedPhase === "shard_initializing") return 2;
  if (normalizedPhase === "initializing") return 1;
  return 0;
};

const compareShardEntriesForRecovery = (
  left: { phase: string; shardId: string },
  right: { phase: string; shardId: string },
): number => {
  const phaseDelta = getShardPhasePriority(right.phase) - getShardPhasePriority(left.phase);
  if (phaseDelta !== 0) {
    return phaseDelta;
  }

  try {
    const leftShardId = normalizeOnchainShardId(parseShardIdParts(left.shardId).onchainShardId);
    const rightShardId = normalizeOnchainShardId(parseShardIdParts(right.shardId).onchainShardId);
    const leftNumeric = BigInt(leftShardId);
    const rightNumeric = BigInt(rightShardId);
    if (rightNumeric > leftNumeric) {
      return 1;
    }
    if (rightNumeric < leftNumeric) {
      return -1;
    }
  } catch {
    // Ignore parse failures and keep original order.
  }

  return 0;
};

const resolveRequestedShardContextFromOperatorStatus = async (params: {
  operatorUrl: string;
  expectedGameContractAddress: string;
}): Promise<RequestedShardContext> => {
  const shardEntries = await fetchShardStatusEntries(params.operatorUrl, params.expectedGameContractAddress);
  const candidate = shardEntries
    .filter(
      (entry) =>
        entry.gameContractAddress === params.expectedGameContractAddress && isRecoverableShardPhase(entry.phase),
    )
    .sort(compareShardEntriesForRecovery)[0];

  if (candidate === undefined) {
    throw new Error("Operator does not report a recoverable shard for this world");
  }

  return buildRequestedShardContextFromShardId(candidate.shardId);
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const resolveRequestedShardContextFromOperatorStatusWithRetry = async (params: {
  operatorUrl: string;
  expectedGameContractAddress: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<RequestedShardContext> => {
  const timeoutMs = params.timeoutMs ?? RECEIPT_RECOVERY_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? RECEIPT_RECOVERY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() <= deadline) {
    try {
      return await resolveRequestedShardContextFromOperatorStatus({
        operatorUrl: params.operatorUrl,
        expectedGameContractAddress: params.expectedGameContractAddress,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Operator recovery failed");
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  throw lastError ?? new Error("Operator recovery failed");
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
      const worldAddress = options?.worldAddress?.trim() || dojoConfig.manifest.world.address;
      const normalizedWorldAddress = normalizeFeltToHex(worldAddress, "world_address");
      try {
        const requestedContext = await resolveRequestedShardContextFromOperatorStatus({
          operatorUrl,
          expectedGameContractAddress: normalizedWorldAddress,
        });
        beginTrackingRequestedShard(requestedContext);
        return;
      } catch (operatorRecoveryError) {
        const operatorRecoveryMessage =
          operatorRecoveryError instanceof Error ? operatorRecoveryError.message : "Operator recovery failed";
        failRequest("SHARD_ID_RESOLUTION_FAILED", operatorRecoveryMessage);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to recover existing shard";
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
        const normalizedShardContractAddress = normalizeFeltToHex(operatorConfig.shardContractAddress, "shard_contract_address");

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
              const requestedContext = await resolveRequestedShardContextFromOperatorStatus({
                operatorUrl,
                expectedGameContractAddress: normalizedWorldAddress,
              });
              beginTrackingRequestedShard(requestedContext);
              return;
            } catch (operatorRecoveryError) {
              const operatorRecoveryMessage =
                operatorRecoveryError instanceof Error ? operatorRecoveryError.message : "Operator recovery failed";
              failRequest("EXECUTE_FAILED", `${message}; operator recovery failed: ${operatorRecoveryMessage}`);
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
          captureUnresolvedReceipt({
            txHash,
            receipt,
            reason: receiptResolutionMessage,
            expectedGameContractAddress: normalizedWorldAddress,
            expectedShardContractAddress: normalizedShardContractAddress,
          });

          try {
            requestedContext = await resolveRequestedShardContextFromOperatorStatusWithRetry({
              operatorUrl,
              expectedGameContractAddress: normalizedWorldAddress,
            });
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error
                ? fallbackError.message
                : "Failed to resolve shard ID from operator recovery";
            failRequest(
              "SHARD_ID_RESOLUTION_FAILED",
              `${receiptResolutionMessage}; operator recovery failed: ${fallbackMessage}`,
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
