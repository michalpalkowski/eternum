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

export type ShardRequestErrorStage =
  | "validation"
  | "operator_config"
  | "execute"
  | "receipt_lookup"
  | "receipt_parse"
  | "operator_recovery"
  | "poll_status"
  | "transport_health"
  | "timeout"
  | "recovery";

export type ShardRequestErrorKind =
  | "missing_account"
  | "missing_operator_url"
  | "invalid_entity_ids"
  | "invalid_world_address"
  | "invalid_sharding_contract_address"
  | "manifest_contract_missing"
  | "operator_http_error"
  | "operator_response_invalid"
  | "operator_rejected"
  | "contract_slot_locked"
  | "execute_failed"
  | "tx_hash_missing"
  | "receipt_lookup_unsupported"
  | "receipt_lookup_failed"
  | "receipt_event_missing"
  | "receipt_event_ambiguous"
  | "receipt_event_world_mismatch"
  | "operator_shard_not_found"
  | "cached_shard_invalid"
  | "transport_unhealthy"
  | "transport_http_error"
  | "request_timeout"
  | "recovery_failed"
  | "nonce_resolution_failed"
  | "unknown";

export interface ShardRequestDiagnostic {
  readonly code: ShardRequestErrorCode;
  readonly stage: ShardRequestErrorStage;
  readonly kind: ShardRequestErrorKind;
  readonly summary: string;
  readonly hint: string;
  readonly details: string | null;
  readonly context: Record<string, unknown> | null;
  readonly capturedAt: string;
}

export interface ShardRequestDiagnosticInput {
  readonly code: ShardRequestErrorCode;
  readonly stage: ShardRequestErrorStage;
  readonly kind: ShardRequestErrorKind;
  readonly summary: string;
  readonly hint: string;
  readonly details?: string | null;
  readonly context?: Record<string, unknown>;
}

export const SHARD_REQUEST_DIAGNOSTIC_CAPTURE_KEY = "__eternum_last_shard_request_diagnostic__";

const WINDOW_CAPTURE_KEY = "__ETERNUM_LAST_SHARD_REQUEST_DIAGNOSTIC__";

export class ShardRequestDiagnosticError extends Error {
  public readonly diagnostic: ShardRequestDiagnostic;

  public constructor(diagnostic: ShardRequestDiagnostic) {
    super(diagnostic.summary);
    this.name = "ShardRequestDiagnosticError";
    this.diagnostic = diagnostic;
  }
}

export const createShardRequestDiagnostic = (input: ShardRequestDiagnosticInput): ShardRequestDiagnostic => ({
  code: input.code,
  stage: input.stage,
  kind: input.kind,
  summary: input.summary,
  hint: input.hint,
  details: input.details ?? null,
  context: input.context !== undefined && Object.keys(input.context).length > 0 ? { ...input.context } : null,
  capturedAt: new Date().toISOString(),
});

export const throwShardRequestDiagnostic = (input: ShardRequestDiagnosticInput): never => {
  throw new ShardRequestDiagnosticError(createShardRequestDiagnostic(input));
};

export const rethrowShardRequestDiagnostic = (error: unknown, fallback: ShardRequestDiagnosticInput): never => {
  throw new ShardRequestDiagnosticError(toShardRequestDiagnostic(error, fallback));
};

export const toShardRequestDiagnostic = (
  error: unknown,
  fallback: ShardRequestDiagnosticInput,
): ShardRequestDiagnostic => {
  if (error instanceof ShardRequestDiagnosticError) {
    return error.diagnostic;
  }

  const details =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();

  return createShardRequestDiagnostic({
    ...fallback,
    details: fallback.details !== undefined ? fallback.details : details !== fallback.summary ? details : null,
  });
};

export const captureShardRequestDiagnostic = (diagnostic: ShardRequestDiagnostic) => {
  if (typeof window !== "undefined") {
    (
      window as Window & {
        __ETERNUM_LAST_SHARD_REQUEST_DIAGNOSTIC__?: ShardRequestDiagnostic;
      }
    )[WINDOW_CAPTURE_KEY] = diagnostic;
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(SHARD_REQUEST_DIAGNOSTIC_CAPTURE_KEY, JSON.stringify(diagnostic));
    } catch {
      // Best-effort debug capture only.
    }
  }
};

export const clearCapturedShardRequestDiagnostic = () => {
  if (typeof window !== "undefined") {
    delete (
      window as Window & {
        __ETERNUM_LAST_SHARD_REQUEST_DIAGNOSTIC__?: ShardRequestDiagnostic;
      }
    )[WINDOW_CAPTURE_KEY];
  }

  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(SHARD_REQUEST_DIAGNOSTIC_CAPTURE_KEY);
    } catch {
      // Ignore best-effort cleanup failure.
    }
  }
};

export const logShardRequestDiagnostic = (diagnostic: ShardRequestDiagnostic, level: "warn" | "error" = "error") => {
  const label = `[ShardRequest:${diagnostic.stage}/${diagnostic.kind}]`;
  if (level === "warn") {
    console.warn(label, diagnostic.summary, diagnostic);
    return;
  }
  console.error(label, diagnostic.summary, diagnostic);
};
