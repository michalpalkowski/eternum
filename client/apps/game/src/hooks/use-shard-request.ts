import { getContractByName } from "@dojoengine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { hash, type Call } from "starknet";
import { dojoConfig } from "../../dojo-config";
import { useShardStore } from "./store/use-shard-store";
import {
  captureShardRequestDiagnostic,
  clearCapturedShardRequestDiagnostic,
  createShardRequestDiagnostic,
  logShardRequestDiagnostic,
  rethrowShardRequestDiagnostic,
  throwShardRequestDiagnostic,
  toShardRequestDiagnostic,
  type ShardRequestDiagnostic,
  type ShardRequestErrorCode,
} from "@/sharding/request-diagnostics";
import {
  buildShardPlayUrl,
  isRecoverableProtocolPhase,
  type OperatorConfig,
  parseShardIdParts,
  type RequestedShardContext,
  parseOperatorConfigResponse,
  parseShardStatusEntriesFromStatusResponse,
  parseTransportHealthFromStatusResponse,
  type ShardStatusEntry,
  type ShardTransportHealth,
} from "@/sharding/protocol";
import { resolveMainGameReturnUrl, resolveRuntimeContextFromWindow } from "@/sharding/runtime-context";
import type { ExecutableAccount } from "@/sharding/types";

export type ShardRequestPhase = "idle" | "requesting" | "waiting" | "ready" | "error";
export type { ShardRequestDiagnostic, ShardRequestErrorCode } from "@/sharding/request-diagnostics";

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

export interface ShardRequestRelatedIds {
  explorerIds?: number[];
  tradeIds?: number[];
  hyperstructureIds?: number[];
}

const SHARDING_REQUESTED_SELECTOR = hash.getSelectorFromName("ShardingRequested").toLowerCase();
const SHARD_REQUEST_POLL_INTERVAL_MS = 2000;
const SHARD_REQUEST_TIMEOUT_MS = 120_000;
const SHARD_REQUEST_RECEIPT_CAPTURE_KEY = "__eternum_last_shard_request_receipt__";
const RECEIPT_RECOVERY_TIMEOUT_MS = 10_000;
const RECEIPT_RECOVERY_POLL_INTERVAL_MS = 500;
const MAX_RELATED_IDS_PER_LIST = 512;

type ShardRequestPollObservation =
  | { type: "status_not_found" }
  | { type: "status_missing_target"; availableShardIds: string[] }
  | {
      type: "transport_pending";
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
    };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const normalizePositiveIdList = (values: number[] | undefined, fieldName: string): number[] => {
  if (values === undefined || values.length === 0) {
    return [];
  }

  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${fieldName} must contain positive integer IDs`);
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  if (normalized.length > MAX_RELATED_IDS_PER_LIST) {
    throw new Error(`${fieldName} exceeds max ${MAX_RELATED_IDS_PER_LIST} ids`);
  }

  return normalized;
};

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
  diagnostic: ShardRequestDiagnostic;
  expectedGameContractAddress: string;
  expectedShardContractAddress: string;
}) => {
  const payload = {
    capturedAt: new Date().toISOString(),
    txHash: params.txHash,
    reason: params.diagnostic.summary,
    hint: params.diagnostic.hint,
    stage: params.diagnostic.stage,
    kind: params.diagnostic.kind,
    details: params.diagnostic.details,
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

const clearCapturedReceipt = () => {
  if (typeof window !== "undefined") {
    delete (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown })
      .__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__;
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(SHARD_REQUEST_RECEIPT_CAPTURE_KEY);
    } catch {
      // Ignore best-effort cleanup failure.
    }
  }
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
  const candidates: Array<{ gameContractAddress: string | null; onchainShardId: string }> = [];

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
      // Proxy event layout: ShardingRequested { #[key] game_contract, shard_id, entities }
      // keys[1] = game_contract (world address), data[0] = shard_id
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

    if (
      !candidates.some(
        (candidate) =>
          candidate.gameContractAddress === gameAddressFromEvent && candidate.onchainShardId === onchainShardId,
      )
    ) {
      candidates.push({
        gameContractAddress: gameAddressFromEvent,
        onchainShardId,
      });
    }

    if (gameAddressFromEvent !== null && gameAddressFromEvent === params.expectedGameContractAddress) {
      return {
        txHash: params.txHash,
        gameContractAddress: gameAddressFromEvent,
        onchainShardId,
        shardId: `${gameAddressFromEvent}@${onchainShardId}`,
      };
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    const resolvedGameContractAddress = candidate.gameContractAddress ?? params.expectedGameContractAddress;
    if (
      candidate.gameContractAddress !== null &&
      candidate.gameContractAddress !== params.expectedGameContractAddress
    ) {
      logShardRequestDiagnostic(
        createShardRequestDiagnostic({
          code: "SHARD_ID_RESOLUTION_FAILED",
          stage: "receipt_parse",
          kind: "receipt_event_world_mismatch",
          summary: "Receipt world address differs from the frontend's expected world",
          hint: "Frontend manifest or selected world is stale; continuing with the on-chain event world.",
          context: {
            txHash: params.txHash,
            expectedGameContractAddress: params.expectedGameContractAddress,
            receiptGameContractAddress: candidate.gameContractAddress,
            expectedShardContractAddress: params.expectedShardContractAddress,
          },
        }),
        "warn",
      );
    }
    return {
      txHash: params.txHash,
      gameContractAddress: resolvedGameContractAddress,
      onchainShardId: candidate.onchainShardId,
      shardId: `${resolvedGameContractAddress}@${candidate.onchainShardId}`,
    };
  }

  if (candidates.length > 1) {
    return throwShardRequestDiagnostic({
      code: "SHARD_ID_RESOLUTION_FAILED",
      stage: "receipt_parse",
      kind: "receipt_event_ambiguous",
      summary: "Transaction receipt contains multiple shard request events",
      hint: "Inspect the captured receipt and confirm only one shard request is emitted per transaction.",
      context: {
        txHash: params.txHash,
        expectedGameContractAddress: params.expectedGameContractAddress,
        expectedShardContractAddress: params.expectedShardContractAddress,
        candidates,
      },
    });
  }

  return throwShardRequestDiagnostic({
    code: "SHARD_ID_RESOLUTION_FAILED",
    stage: "receipt_parse",
    kind: "receipt_event_missing",
    summary: "Transaction receipt does not contain a ShardingRequested event",
    hint: "Check whether the transaction emitted ShardRequested on the expected world contract.",
    context: {
      txHash: params.txHash,
      expectedGameContractAddress: params.expectedGameContractAddress,
      expectedShardContractAddress: params.expectedShardContractAddress,
      extractedEventCount: events.length,
    },
  });
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

const fetchOperatorConfig = async (operatorUrl: string): Promise<OperatorConfig> => {
  const configResponse = await fetch(`${operatorUrl}/config`).catch((error: unknown) => {
    return rethrowShardRequestDiagnostic(error, {
      code: "OPERATOR_CONFIG_FAILED",
      stage: "operator_config",
      kind: "operator_http_error",
      summary: "Failed to fetch shard operator configuration",
      hint: "Check whether the operator status API is reachable at /config.",
      context: {
        operatorUrl,
      },
    });
  });
  if (!configResponse.ok) {
    return throwShardRequestDiagnostic({
      code: "OPERATOR_CONFIG_FAILED",
      stage: "operator_config",
      kind: "operator_http_error",
      summary: `Operator config endpoint returned HTTP ${configResponse.status}`,
      hint: "Check the operator status server and verify /config returns a success response.",
      context: {
        operatorUrl,
        statusCode: configResponse.status,
      },
    });
  }
  const configPayload: unknown = await configResponse.json().catch((error: unknown) => {
    return rethrowShardRequestDiagnostic(error, {
      code: "OPERATOR_CONFIG_FAILED",
      stage: "operator_config",
      kind: "operator_response_invalid",
      summary: "Operator config response is not valid JSON",
      hint: "Check the /config response body returned by the operator.",
      context: {
        operatorUrl,
      },
    });
  });
  try {
    return parseOperatorConfigResponse(configPayload);
  } catch (error) {
    return rethrowShardRequestDiagnostic(error, {
      code: "OPERATOR_CONFIG_FAILED",
      stage: "operator_config",
      kind: "operator_response_invalid",
      summary: "Operator config response has an invalid shape",
      hint: "Frontend and operator disagree on the /config payload schema.",
      context: {
        operatorUrl,
      },
    });
  }
};

const fetchShardStatusEntries = async (
  operatorUrl: string,
  gameContractAddress: string,
): Promise<ShardStatusEntry[]> => {
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

const resolveRequestedShardContextFromOperatorStatus = async (params: {
  operatorUrl: string;
  expectedGameContractAddress: string;
}): Promise<RequestedShardContext> => {
  const shardEntries = await fetchShardStatusEntries(params.operatorUrl, params.expectedGameContractAddress);
  const candidates = shardEntries.filter(
    (entry) =>
      entry.gameContractAddress === params.expectedGameContractAddress && isRecoverableProtocolPhase(entry.protocol),
  );

  if (candidates.length === 0) {
    throw new Error("Operator does not report a recoverable shard for this world");
  }

  if (candidates.length > 1) {
    const availableShardIds = candidates.map((entry) => entry.shardId).join(", ");
    throw new Error(
      `Operator reports multiple recoverable shards for this world (${availableShardIds}). ` +
        "Recovery requires an explicit shard id.",
    );
  }

  return buildRequestedShardContextFromShardId(candidates[0].shardId);
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

const buildRequestTimeoutDiagnostic = (params: {
  target: RequestedShardContext;
  operatorUrl: string;
  observation: ShardRequestPollObservation | null;
}) => {
  if (params.observation?.type === "status_not_found") {
    return createShardRequestDiagnostic({
      code: "REQUEST_TIMEOUT",
      stage: "timeout",
      kind: "request_timeout",
      summary: "Operator never reported the requested world before the shard request timed out",
      hint: "Check that the frontend world address matches the operator world and that the operator watches the same sharding proxy.",
      context: {
        targetShardId: params.target.shardId,
        gameContractAddress: params.target.gameContractAddress,
        operatorUrl: params.operatorUrl,
        observation: params.observation.type,
      },
    });
  }

  if (params.observation?.type === "status_missing_target") {
    return createShardRequestDiagnostic({
      code: "REQUEST_TIMEOUT",
      stage: "timeout",
      kind: "request_timeout",
      summary: "Operator reported shards for the world, but not the requested shard id before timeout",
      hint: "Check whether the frontend tracked the correct shard id and whether a newer shard replaced the current request.",
      context: {
        targetShardId: params.target.shardId,
        gameContractAddress: params.target.gameContractAddress,
        operatorUrl: params.operatorUrl,
        availableShardIds: params.observation.availableShardIds,
      },
    });
  }

  if (params.observation?.type === "transport_pending") {
    return createShardRequestDiagnostic({
      code: "REQUEST_TIMEOUT",
      stage: "timeout",
      kind: "transport_unhealthy",
      summary: "Shard was created, but transport never became healthy before timeout",
      hint: "Check Torii/bootstrap readiness and inspect the operator transport-health response for the shard.",
      context: {
        targetShardId: params.target.shardId,
        gameContractAddress: params.target.gameContractAddress,
        operatorUrl: params.operatorUrl,
        transportStatus: params.observation.status,
        transportErrorCode: params.observation.errorCode,
        transportErrorMessage: params.observation.errorMessage,
      },
    });
  }

  return createShardRequestDiagnostic({
    code: "REQUEST_TIMEOUT",
    stage: "timeout",
    kind: "request_timeout",
    summary: `Shard request timed out after ${Math.round(SHARD_REQUEST_TIMEOUT_MS / 1000)}s`,
    hint: "Check the operator logs and verify the shard request transaction was picked up by the status API.",
    context: {
      targetShardId: params.target.shardId,
      gameContractAddress: params.target.gameContractAddress,
      operatorUrl: params.operatorUrl,
    },
  });
};

export const useShardRequest = (
  account: ExecutableAccount | null,
  operatorUrl: string,
  options?: UseShardRequestOptions,
) => {
  const [phase, setPhase] = useState<ShardRequestPhase>("idle");
  const [errorDiagnostic, setErrorDiagnostic] = useState<ShardRequestDiagnostic | null>(null);
  const [shardUrls, setShardUrls] = useState<ShardUrls | null>(null);
  const [targetShardId, setTargetShardId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollLockRef = useRef(false);
  const pollStartedAtRef = useRef<number | null>(null);
  const pollTargetRef = useRef<RequestedShardContext | null>(null);
  const lastPollObservationRef = useRef<ShardRequestPollObservation | null>(null);
  const setMainShardRequestState = useShardStore((state) => state.setMainShardRequestState);
  const clearMainShardRequestState = useShardStore((state) => state.clearMainShardRequestState);
  const error = errorDiagnostic?.summary ?? null;
  const errorCode: ShardRequestErrorCode | null = errorDiagnostic?.code ?? null;

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
    (diagnostic: ShardRequestDiagnostic) => {
      const currentTargetShardId = pollTargetRef.current?.shardId ?? targetShardId;
      const finalDiagnostic =
        currentTargetShardId !== null &&
        (diagnostic.context?.targetShardId === undefined || diagnostic.context?.targetShardId === null)
          ? {
              ...diagnostic,
              context: {
                ...(diagnostic.context ?? {}),
                targetShardId: currentTargetShardId,
              },
            }
          : diagnostic;

      captureShardRequestDiagnostic(finalDiagnostic);
      logShardRequestDiagnostic(finalDiagnostic);
      stopPolling();
      setErrorDiagnostic(finalDiagnostic);
      setPhase("error");
      setMainShardRequestState({
        phase: "error",
        targetShardId: currentTargetShardId,
        errorCode: finalDiagnostic.code,
        error: finalDiagnostic.summary,
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
        buildRequestTimeoutDiagnostic({
          target,
          operatorUrl,
          observation: lastPollObservationRef.current,
        }),
      );
      return;
    }

    pollLockRef.current = true;
    try {
      const statusResponse = await fetch(`${operatorUrl}/shard/${target.gameContractAddress}`).catch(
        (error: unknown) => {
          return rethrowShardRequestDiagnostic(error, {
            code: "POLL_FAILED",
            stage: "poll_status",
            kind: "operator_http_error",
            summary: "Failed to query shard status from the operator",
            hint: "Check whether the operator status API is reachable and still running.",
            context: {
              operatorUrl,
              gameContractAddress: target.gameContractAddress,
              targetShardId: target.shardId,
            },
          });
        },
      );

      if (statusResponse.status === 404) {
        lastPollObservationRef.current = { type: "status_not_found" };
        return;
      }
      if (statusResponse.status === 409) {
        const payload: unknown = await statusResponse.json().catch(() => null);
        const rejection = parseOperatorRejection(payload);
        failRequest(
          createShardRequestDiagnostic({
            code: "OPERATOR_REJECTED",
            stage: "poll_status",
            kind: "operator_rejected",
            summary: rejection ?? `Operator rejected shard request: HTTP ${statusResponse.status}`,
            hint: "Check operator capacity/config limits and inspect the rejection error_code in the status response.",
            context: {
              operatorUrl,
              gameContractAddress: target.gameContractAddress,
              targetShardId: target.shardId,
              statusCode: statusResponse.status,
              payload: isRecord(payload) ? payload : null,
            },
          }),
        );
        return;
      }
      if (!statusResponse.ok) {
        return throwShardRequestDiagnostic({
          code: "POLL_FAILED",
          stage: "poll_status",
          kind: "operator_http_error",
          summary: `Shard status endpoint returned HTTP ${statusResponse.status}`,
          hint: "Check the operator status server logs and confirm the shard discovery endpoint is healthy.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
            statusCode: statusResponse.status,
          },
        });
      }

      const statusPayload: unknown = await statusResponse.json().catch((error: unknown) => {
        return rethrowShardRequestDiagnostic(error, {
          code: "POLL_FAILED",
          stage: "poll_status",
          kind: "operator_response_invalid",
          summary: "Shard status response is not valid JSON",
          hint: "Check the operator response body for /shard/{game_contract}.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
          },
        });
      });
      const shardEntries: ShardStatusEntry[] = (() => {
        try {
          return parseShardStatusEntriesFromStatusResponse(statusPayload);
        } catch (error) {
          return rethrowShardRequestDiagnostic(error, {
            code: "POLL_FAILED",
            stage: "poll_status",
            kind: "operator_response_invalid",
            summary: "Shard status response has an invalid shape",
            hint: "Frontend and operator disagree on the /shard payload schema.",
            context: {
              operatorUrl,
              gameContractAddress: target.gameContractAddress,
              targetShardId: target.shardId,
            },
          });
        }
      })();
      const normalizedTargetOnchainId = normalizeOnchainShardId(target.onchainShardId);
      const shardEntry = shardEntries.find((entry) => {
        if (entry.gameContractAddress !== target.gameContractAddress) {
          return false;
        }
        const entryShardIdParts = parseShardIdParts(entry.shardId);
        return normalizeOnchainShardId(entryShardIdParts.onchainShardId) === normalizedTargetOnchainId;
      });
      if (shardEntry === undefined) {
        lastPollObservationRef.current = {
          type: "status_missing_target",
          availableShardIds: shardEntries.map((entry) => entry.shardId),
        };
        return;
      }

      const entryShardIdParts = parseShardIdParts(shardEntry.shardId);

      const transportResponse = await fetch(
        `${operatorUrl}/shard/${target.gameContractAddress}/${entryShardIdParts.onchainShardId}/transport-health`,
      ).catch((error: unknown) => {
        return rethrowShardRequestDiagnostic(error, {
          code: "POLL_FAILED",
          stage: "transport_health",
          kind: "transport_http_error",
          summary: "Failed to query shard transport health from the operator",
          hint: "Check whether the operator transport-health endpoint is reachable for this shard.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
            onchainShardId: entryShardIdParts.onchainShardId,
          },
        });
      });
      if (!transportResponse.ok) {
        return throwShardRequestDiagnostic({
          code: "POLL_FAILED",
          stage: "transport_health",
          kind: "transport_http_error",
          summary: `Shard transport-health endpoint returned HTTP ${transportResponse.status}`,
          hint: "Check the operator transport-health handler and shard lifecycle state.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
            onchainShardId: entryShardIdParts.onchainShardId,
            statusCode: transportResponse.status,
          },
        });
      }
      const transportPayload: unknown = await transportResponse.json().catch((error: unknown) => {
        return rethrowShardRequestDiagnostic(error, {
          code: "POLL_FAILED",
          stage: "transport_health",
          kind: "operator_response_invalid",
          summary: "Shard transport-health response is not valid JSON",
          hint: "Check the operator transport-health payload for this shard.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
            onchainShardId: entryShardIdParts.onchainShardId,
          },
        });
      });
      const transport: ShardTransportHealth = (() => {
        try {
          return parseTransportHealthFromStatusResponse(transportPayload);
        } catch (error) {
          return rethrowShardRequestDiagnostic(error, {
            code: "POLL_FAILED",
            stage: "transport_health",
            kind: "operator_response_invalid",
            summary: "Shard transport-health response has an invalid shape",
            hint: "Frontend and operator disagree on the transport-health schema.",
            context: {
              operatorUrl,
              gameContractAddress: target.gameContractAddress,
              targetShardId: target.shardId,
              onchainShardId: entryShardIdParts.onchainShardId,
            },
          });
        }
      })();
      if (transport.status !== "healthy") {
        lastPollObservationRef.current = {
          type: "transport_pending",
          status: transport.status,
          errorCode: transport.errorCode,
          errorMessage: transport.errorMessage,
        };
        return;
      }
      if (shardEntry.katanaUrl === null || shardEntry.toriiUrl === null) {
        lastPollObservationRef.current = {
          type: "transport_pending",
          status: transport.status,
          errorCode: "missing_runtime_urls",
          errorMessage: "Operator reported healthy transport without katana_url or torii_url",
        };
        return;
      }

      stopPolling();
      clearCapturedShardRequestDiagnostic();
      lastPollObservationRef.current = null;
      setShardUrls({
        katanaUrl: shardEntry.katanaUrl,
        toriiUrl: shardEntry.toriiUrl,
        toriiGrpcUrl: shardEntry.toriiGrpcUrl,
        gameContractAddress: shardEntry.gameContractAddress,
        shardId: shardEntry.shardId,
      });
      setErrorDiagnostic(null);
      setPhase("ready");
      setMainShardRequestState({
        phase: "ready",
        targetShardId: shardEntry.shardId,
      });
    } catch (pollError) {
      failRequest(
        toShardRequestDiagnostic(pollError, {
          code: "POLL_FAILED",
          stage: "poll_status",
          kind: "unknown",
          summary: "Failed to poll shard status",
          hint: "Inspect the captured shard request diagnostic for the failing stage and payload.",
          context: {
            operatorUrl,
            gameContractAddress: target.gameContractAddress,
            targetShardId: target.shardId,
          },
        }),
      );
    } finally {
      pollLockRef.current = false;
    }
  }, [failRequest, operatorUrl, stopPolling]);

  const beginTrackingRequestedShard = useCallback(
    (requestedContext: RequestedShardContext) => {
      stopPolling();
      clearCapturedShardRequestDiagnostic();
      lastPollObservationRef.current = null;
      setShardUrls(null);
      setTargetShardId(requestedContext.shardId);
      setErrorDiagnostic(null);
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
      failRequest(
        createShardRequestDiagnostic({
          code: "MISSING_ACCOUNT",
          stage: "recovery",
          kind: "missing_account",
          summary: "Wallet account is required to recover an existing shard",
          hint: "Reconnect the wallet before trying to recover the shard session.",
          context: {
            operatorUrl,
            targetShardId,
          },
        }),
      );
      return;
    }
    if (operatorUrl.trim().length === 0) {
      failRequest(
        createShardRequestDiagnostic({
          code: "MISSING_OPERATOR_URL",
          stage: "recovery",
          kind: "missing_operator_url",
          summary: "Missing shard operator URL",
          hint: "Set VITE_PUBLIC_SHARD_OPERATOR_URL so the frontend can query shard recovery status.",
          context: {
            targetShardId,
          },
        }),
      );
      return;
    }

    clearCapturedShardRequestDiagnostic();

    const persistedTargetShardId = useShardStore.getState().mainShardTargetShardId;
    const candidateShardId = targetShardId ?? persistedTargetShardId;
    if (candidateShardId !== null) {
      try {
        beginTrackingRequestedShard(buildRequestedShardContextFromShardId(candidateShardId));
        return;
      } catch (error) {
        logShardRequestDiagnostic(
          toShardRequestDiagnostic(error, {
            code: "SHARD_ID_RESOLUTION_FAILED",
            stage: "recovery",
            kind: "cached_shard_invalid",
            summary: "Persisted shard id is malformed and cannot be reused directly",
            hint: "Falling back to operator-side shard recovery for the current world.",
            context: {
              candidateShardId,
            },
          }),
          "warn",
        );
        // Fall through to operator-status recovery when the cached shard id is malformed.
      }
    }

    try {
      const worldAddress = options?.worldAddress?.trim() || dojoConfig.manifest.world.address;
      const normalizedWorldAddress = normalizeFeltToHex(worldAddress, "world_address");
      const requestedContext = await resolveRequestedShardContextFromOperatorStatus({
        operatorUrl,
        expectedGameContractAddress: normalizedWorldAddress,
      });
      beginTrackingRequestedShard(requestedContext);
      return;
    } catch (error) {
      failRequest(
        toShardRequestDiagnostic(error, {
          code: "SHARD_ID_RESOLUTION_FAILED",
          stage: "recovery",
          kind: "recovery_failed",
          summary: "Failed to recover an active shard for the current world",
          hint: "Check the world address, operator /shard response, and whether the shard is still active.",
          context: {
            operatorUrl,
            worldAddress: options?.worldAddress?.trim() || dojoConfig.manifest.world.address,
            candidateShardId,
          },
        }),
      );
    }
  }, [account, beginTrackingRequestedShard, failRequest, operatorUrl, options?.worldAddress, targetShardId]);

  const requestShard = useCallback(
    async (entityIds: number[], relatedIds?: ShardRequestRelatedIds) => {
      if (phase !== "idle") {
        return;
      }
      if (account === null) {
        failRequest(
          createShardRequestDiagnostic({
            code: "MISSING_ACCOUNT",
            stage: "validation",
            kind: "missing_account",
            summary: "Wallet account is required to request a shard",
            hint: "Reconnect the wallet before trying to create a shard.",
            context: {
              operatorUrl,
            },
          }),
        );
        return;
      }
      if (entityIds.length === 0) {
        failRequest(
          createShardRequestDiagnostic({
            code: "INVALID_ENTITY_IDS",
            stage: "validation",
            kind: "invalid_entity_ids",
            summary: "entityIds must not be empty",
            hint: "Select at least one valid realm/entity before requesting a shard.",
            context: {
              operatorUrl,
            },
          }),
        );
        return;
      }
      if (operatorUrl.trim().length === 0) {
        failRequest(
          createShardRequestDiagnostic({
            code: "MISSING_OPERATOR_URL",
            stage: "validation",
            kind: "missing_operator_url",
            summary: "Missing shard operator URL",
            hint: "Set VITE_PUBLIC_SHARD_OPERATOR_URL so the frontend can query operator state.",
          }),
        );
        return;
      }

      clearCapturedShardRequestDiagnostic();
      clearCapturedReceipt();
      lastPollObservationRef.current = null;
      setPhase("requesting");
      setErrorDiagnostic(null);
      setShardUrls(null);
      setTargetShardId(null);
      setMainShardRequestState({
        phase: "requesting",
        targetShardId: null,
      });

      let operatorConfig: Awaited<ReturnType<typeof fetchOperatorConfig>>;
      try {
        operatorConfig = await fetchOperatorConfig(operatorUrl);
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "OPERATOR_CONFIG_FAILED",
            stage: "operator_config",
            kind: "operator_http_error",
            summary: "Failed to fetch shard operator configuration",
            hint: "Check whether the operator is running and reachable at /config.",
            context: {
              operatorUrl,
            },
          }),
        );
        return;
      }

      let shardingContractAddress: string;
      try {
        const shardingContract = getContractByName(dojoConfig.manifest, "s1_eternum", "sharding_systems");
        shardingContractAddress = options?.shardingContractAddress?.trim() || shardingContract.address;
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "OPERATOR_CONFIG_FAILED",
            stage: "validation",
            kind: "manifest_contract_missing",
            summary: "Frontend manifest does not expose the sharding_systems contract address",
            hint: "Check the patched manifest and selected world before requesting a shard.",
            context: {
              worldAddress: options?.worldAddress?.trim() || dojoConfig.manifest.world.address,
            },
          }),
        );
        return;
      }

      const worldAddress = options?.worldAddress?.trim() || dojoConfig.manifest.world.address;
      let normalizedWorldAddress: string;
      try {
        normalizedWorldAddress = normalizeFeltToHex(worldAddress, "world_address");
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "OPERATOR_CONFIG_FAILED",
            stage: "validation",
            kind: "invalid_world_address",
            summary: "Frontend world address is invalid and cannot be used for shard discovery",
            hint: "Check the selected world and patched manifest before requesting a shard.",
            context: {
              worldAddress,
            },
          }),
        );
        return;
      }

      let normalizedShardContractAddress: string;
      try {
        normalizedShardContractAddress = normalizeFeltToHex(
          operatorConfig.shardContractAddress,
          "shard_contract_address",
        );
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "OPERATOR_CONFIG_FAILED",
            stage: "operator_config",
            kind: "invalid_sharding_contract_address",
            summary: "Operator config returned an invalid shard contract address",
            hint: "Check the operator /config response and the proxy address it exposes.",
            context: {
              operatorUrl,
              shardContractAddress: operatorConfig.shardContractAddress,
            },
          }),
        );
        return;
      }

      let explorerIds: number[];
      let tradeIds: number[];
      let hyperstructureIds: number[];
      try {
        explorerIds = normalizePositiveIdList(relatedIds?.explorerIds, "explorerIds");
        tradeIds = normalizePositiveIdList(relatedIds?.tradeIds, "tradeIds");
        hyperstructureIds = normalizePositiveIdList(relatedIds?.hyperstructureIds, "hyperstructureIds");
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "INVALID_ENTITY_IDS",
            stage: "validation",
            kind: "invalid_entity_ids",
            summary: "Related entity IDs are invalid",
            hint: "Check explorer/trade/hyperstructure IDs are positive integers and within the on-chain limits.",
            context: {
              entityIds,
            },
          }),
        );
        return;
      }

      // Use request_shard_realm for single realm entity — it pre-allocates
      // building hex grid positions and includes them in the shard scope.
      // Falls back to request_shard for multi-entity requests.
      const isSingleRealm = entityIds.length === 1;
      const entrypoint = isSingleRealm ? "request_shard_realm" : "request_shard";
      const calldata = isSingleRealm
        ? [entityIds[0].toString()]
        : [entityIds.length.toString(), ...entityIds.map((entityId) => entityId.toString())];

      const requestShardCall: Call = {
        contractAddress: shardingContractAddress,
        entrypoint,
        calldata,
      };

      let executeResult: unknown;
      try {
        executeResult = await account.execute([requestShardCall]);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${entrypoint} transaction failed`;
        if (isShardAlreadyLockedError(message)) {
          try {
            const requestedContext = await resolveRequestedShardContextFromOperatorStatus({
              operatorUrl,
              expectedGameContractAddress: normalizedWorldAddress,
            });
            logShardRequestDiagnostic(
              createShardRequestDiagnostic({
                code: "EXECUTE_FAILED",
                stage: "execute",
                kind: "contract_slot_locked",
                summary: "Shard request hit an existing shard lock; reusing the operator-reported shard",
                hint: "This usually means the shard was already requested earlier and is still active.",
                details: message,
                context: {
                  operatorUrl,
                  gameContractAddress: normalizedWorldAddress,
                  recoveredShardId: requestedContext.shardId,
                },
              }),
              "warn",
            );
            beginTrackingRequestedShard(requestedContext);
            return;
          } catch (recoveryError) {
            failRequest(
              toShardRequestDiagnostic(recoveryError, {
                code: "EXECUTE_FAILED",
                stage: "operator_recovery",
                kind: "contract_slot_locked",
                summary: "Shard request hit an existing shard lock and operator recovery failed",
                hint: "Check whether the previous shard is still active and whether the operator reports it for this world.",
                details: message,
                context: {
                  operatorUrl,
                  gameContractAddress: normalizedWorldAddress,
                },
              }),
            );
            return;
          }
        }

        failRequest(
          createShardRequestDiagnostic({
            code: "EXECUTE_FAILED",
            stage: "execute",
            kind: "execute_failed",
            summary: message,
            hint: "Inspect the wallet error and on-chain revert reason returned by request_shard_all.",
            context: {
              operatorUrl,
              gameContractAddress: normalizedWorldAddress,
              contractAddress: shardingContractAddress,
              entrypoint,
            },
          }),
        );
        return;
      }

      let txHash: string;
      try {
        txHash = parseTxHashFromExecuteResult(executeResult);
      } catch (error) {
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "TX_HASH_MISSING",
            stage: "execute",
            kind: "tx_hash_missing",
            summary: "Wallet execute() result does not include a transaction hash",
            hint: "Check the account adapter returns transaction_hash or transactionHash after execute().",
            context: {
              operatorUrl,
              gameContractAddress: normalizedWorldAddress,
              entrypoint,
            },
          }),
        );
        return;
      }

      let receipt: unknown;
      try {
        receipt = await resolveReceiptFromAccount(account, txHash);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to resolve transaction receipt";
        if (message.includes("does not support transaction receipt lookup")) {
          failRequest(
            createShardRequestDiagnostic({
              code: "RECEIPT_UNSUPPORTED",
              stage: "receipt_lookup",
              kind: "receipt_lookup_unsupported",
              summary: message,
              hint: "Use an account/provider adapter that supports getTransactionReceipt or waitForTransaction.",
              context: {
                txHash,
              },
            }),
          );
          return;
        }
        failRequest(
          toShardRequestDiagnostic(error, {
            code: "RECEIPT_FAILED",
            stage: "receipt_lookup",
            kind: "receipt_lookup_failed",
            summary: "Failed to load transaction receipt for the shard request",
            hint: "Check the connected RPC/provider can return transaction receipts for the submitted tx hash.",
            context: {
              txHash,
            },
          }),
        );
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
        const receiptDiagnostic = toShardRequestDiagnostic(error, {
          code: "SHARD_ID_RESOLUTION_FAILED",
          stage: "receipt_parse",
          kind: "unknown",
          summary: "Failed to resolve shard ID from transaction receipt",
          hint: "Inspect the captured receipt payload and emitted event schema for the shard request.",
          context: {
            txHash,
            expectedGameContractAddress: normalizedWorldAddress,
            expectedShardContractAddress: normalizedShardContractAddress,
          },
        });
        captureUnresolvedReceipt({
          txHash,
          receipt,
          diagnostic: receiptDiagnostic,
          expectedGameContractAddress: normalizedWorldAddress,
          expectedShardContractAddress: normalizedShardContractAddress,
        });

        try {
          requestedContext = await resolveRequestedShardContextFromOperatorStatusWithRetry({
            operatorUrl,
            expectedGameContractAddress: normalizedWorldAddress,
          });
        } catch (fallbackError) {
          failRequest(
            toShardRequestDiagnostic(fallbackError, {
              code: "SHARD_ID_RESOLUTION_FAILED",
              stage: "operator_recovery",
              kind: "operator_shard_not_found",
              summary: "Could not recover shard ID from the operator after receipt parsing failed",
              hint: "Check that the operator reports the same world and sharding proxy as the frontend, then inspect /shard/{game_contract}.",
              details: receiptDiagnostic.summary,
              context: {
                operatorUrl,
                txHash,
                expectedGameContractAddress: normalizedWorldAddress,
                expectedShardContractAddress: normalizedShardContractAddress,
              },
            }),
          );
          return;
        }
      }

      beginTrackingRequestedShard(requestedContext);
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
    clearCapturedShardRequestDiagnostic();
    clearCapturedReceipt();
    setPhase("idle");
    setErrorDiagnostic(null);
    setShardUrls(null);
    setTargetShardId(null);
    clearMainShardRequestState();
  }, [clearMainShardRequestState, stopPolling]);

  return {
    phase,
    errorCode,
    error,
    errorDiagnostic,
    shardUrls,
    targetShardId,
    requestShard,
    recoverShard,
    openShardTab,
    reset,
  };
};
