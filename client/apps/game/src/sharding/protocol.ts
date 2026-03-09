export const SHARD_SESSION_STORAGE_KEY = "shard_mode";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]+$/;

export type ShardProtocolErrorCode =
  | "INVALID_SHARD_QUERY"
  | "INVALID_SHARD_SESSION"
  | "INVALID_OPERATOR_CONFIG"
  | "INVALID_OPERATOR_STATUS"
  | "INVALID_SETTLEMENT_EVENT"
  | "INVALID_SHARD_ID";

export class ShardProtocolError extends Error {
  public readonly code: ShardProtocolErrorCode;

  public constructor(code: ShardProtocolErrorCode, message: string) {
    super(message);
    this.name = "ShardProtocolError";
    this.code = code;
  }
}

export interface ShardSessionParams {
  readonly rpcUrl: string;
  readonly toriiUrl: string;
  readonly toriiGrpcUrl: string;
  readonly shardId: string;
  readonly operatorUrl: string;
  readonly mainUrl: string | null;
}

export interface OperatorConfig {
  readonly shardContractAddress: string;
}

export interface ActiveShard {
  readonly katanaUrl: string;
  readonly toriiUrl: string;
  readonly toriiGrpcUrl: string | null;
  readonly gameContractAddress: string;
  readonly shardId: string;
}

export interface ShardStatusEntry {
  readonly phase: string;
  readonly shardId: string;
  readonly gameContractAddress: string;
  readonly katanaUrl: string | null;
  readonly toriiUrl: string | null;
  readonly toriiGrpcUrl: string | null;
}

export interface RequestedShardContext {
  readonly txHash: string;
  readonly gameContractAddress: string;
  readonly onchainShardId: string;
  readonly shardId: string;
}

export type TransportHealthStatus = "healthy" | "degraded" | "unavailable";

export interface ShardTransportHealth {
  readonly status: TransportHealthStatus;
  readonly toriiHttpReachable: boolean;
  readonly toriiSqlReachable: boolean;
  readonly toriiGrpcReachable: boolean;
  readonly bootstrapSnapshotPresent: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type SettlementStreamEvent =
  | { readonly type: "settling"; readonly shardId: string; readonly stepLabel: string | null }
  | { readonly type: "completed"; readonly shardId: string }
  | { readonly type: "failed"; readonly shardId: string; readonly reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseHttpUrl = (rawUrl: string, fieldName: string, errorCode: ShardProtocolErrorCode): string => {
  const value = rawUrl.trim();
  if (value.length === 0) {
    throw new ShardProtocolError(errorCode, `${fieldName} must not be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ShardProtocolError(errorCode, `${fieldName} must be a valid URL`);
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new ShardProtocolError(errorCode, `${fieldName} must use http or https`);
  }

  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
};

const parseNonEmptyString = (value: unknown, fieldName: string, errorCode: ShardProtocolErrorCode): string => {
  if (typeof value !== "string") {
    throw new ShardProtocolError(errorCode, `${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ShardProtocolError(errorCode, `${fieldName} must not be empty`);
  }
  return trimmed;
};

const parseHexAddress = (value: unknown, fieldName: string, errorCode: ShardProtocolErrorCode): string => {
  const address = parseNonEmptyString(value, fieldName, errorCode);
  if (!HEX_ADDRESS_PATTERN.test(address)) {
    throw new ShardProtocolError(errorCode, `${fieldName} must be a hex address`);
  }
  return address.toLowerCase();
};

const parseBoolean = (value: unknown, fieldName: string, errorCode: ShardProtocolErrorCode): boolean => {
  if (typeof value !== "boolean") {
    throw new ShardProtocolError(errorCode, `${fieldName} must be a boolean`);
  }
  return value;
};

const parseOptionalString = (
  value: unknown,
  fieldName: string,
  errorCode: ShardProtocolErrorCode,
): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return parseNonEmptyString(value, fieldName, errorCode);
};

const parseOptionalHttpUrl = (
  value: unknown,
  fieldName: string,
  errorCode: ShardProtocolErrorCode,
): string | null => {
  const parsed = parseOptionalString(value, fieldName, errorCode);
  return parsed === null ? null : parseHttpUrl(parsed, fieldName, errorCode);
};

const preferBrowserSafeToriiGrpcUrl = (toriiUrl: string, toriiGrpcUrl: string): string => {
  try {
    const torii = new URL(toriiUrl);
    const grpc = new URL(toriiGrpcUrl);
    if (torii.protocol === "https:" && grpc.protocol === "http:") {
      return toriiUrl;
    }
  } catch {
    return toriiGrpcUrl;
  }
  return toriiGrpcUrl;
};

export const parseShardUrlParams = (search: string): ShardSessionParams | null => {
  const params = new URLSearchParams(search);
  const rawRpcUrl = params.get("shard_rpc");
  const rawToriiUrl = params.get("shard_torii");
  const rawToriiGrpcUrl = params.get("shard_torii_grpc");
  const rawShardId = params.get("shard_id");
  const rawOperatorUrl = params.get("shard_operator");
  const rawMainUrl = params.get("shard_main");

  const hasAnyShardParam =
    rawRpcUrl !== null ||
    rawToriiUrl !== null ||
    rawToriiGrpcUrl !== null ||
    rawShardId !== null ||
    rawOperatorUrl !== null ||
    rawMainUrl !== null;
  if (!hasAnyShardParam) {
    return null;
  }

  const missingFields: string[] = [];
  if (rawRpcUrl === null) missingFields.push("shard_rpc");
  if (rawToriiUrl === null) missingFields.push("shard_torii");
  if (rawShardId === null) missingFields.push("shard_id");
  if (rawOperatorUrl === null) missingFields.push("shard_operator");

  if (missingFields.length > 0) {
    throw new ShardProtocolError(
      "INVALID_SHARD_QUERY",
      `Missing shard query params: ${missingFields.join(", ")}`,
    );
  }

  const rpcUrl = rawRpcUrl;
  const toriiUrl = rawToriiUrl;
  const shardId = rawShardId;
  const operatorUrl = rawOperatorUrl;
  if (rpcUrl === null || toriiUrl === null || shardId === null || operatorUrl === null) {
    throw new ShardProtocolError("INVALID_SHARD_QUERY", "Shard query params are incomplete");
  }

  const parsedToriiUrl = parseHttpUrl(toriiUrl, "shard_torii", "INVALID_SHARD_QUERY");
  const parsedToriiGrpcUrlRaw =
    rawToriiGrpcUrl === null
      ? parsedToriiUrl
      : parseHttpUrl(rawToriiGrpcUrl, "shard_torii_grpc", "INVALID_SHARD_QUERY");
  const parsedToriiGrpcUrl = preferBrowserSafeToriiGrpcUrl(parsedToriiUrl, parsedToriiGrpcUrlRaw);

  return {
    rpcUrl: parseHttpUrl(rpcUrl, "shard_rpc", "INVALID_SHARD_QUERY"),
    toriiUrl: parsedToriiUrl,
    toriiGrpcUrl: parsedToriiGrpcUrl,
    shardId: parseNonEmptyString(shardId, "shard_id", "INVALID_SHARD_QUERY"),
    operatorUrl: parseHttpUrl(operatorUrl, "shard_operator", "INVALID_SHARD_QUERY"),
    mainUrl:
      rawMainUrl === null ? null : parseHttpUrl(rawMainUrl, "shard_main", "INVALID_SHARD_QUERY"),
  };
};

export const serializeShardSession = (params: ShardSessionParams): string =>
  JSON.stringify({
    shardId: params.shardId,
    operatorUrl: params.operatorUrl,
    rpcUrl: params.rpcUrl,
    toriiUrl: params.toriiUrl,
    toriiGrpcUrl: params.toriiGrpcUrl,
    mainUrl: params.mainUrl,
  });

export const parseStoredShardSession = (raw: string): ShardSessionParams => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShardProtocolError("INVALID_SHARD_SESSION", "Shard session storage contains invalid JSON");
  }

  if (!isRecord(parsed)) {
    throw new ShardProtocolError("INVALID_SHARD_SESSION", "Shard session storage must contain an object");
  }

  const toriiUrl = parseHttpUrl(
    parseNonEmptyString(parsed.toriiUrl, "toriiUrl", "INVALID_SHARD_SESSION"),
    "toriiUrl",
    "INVALID_SHARD_SESSION",
  );
  const rawToriiGrpcUrl =
    parsed.toriiGrpcUrl === undefined || parsed.toriiGrpcUrl === null
      ? toriiUrl
      : parseHttpUrl(
          parseNonEmptyString(parsed.toriiGrpcUrl, "toriiGrpcUrl", "INVALID_SHARD_SESSION"),
          "toriiGrpcUrl",
          "INVALID_SHARD_SESSION",
        );
  const toriiGrpcUrl = preferBrowserSafeToriiGrpcUrl(toriiUrl, rawToriiGrpcUrl);

  return {
    shardId: parseNonEmptyString(parsed.shardId, "shardId", "INVALID_SHARD_SESSION"),
    operatorUrl: parseHttpUrl(
      parseNonEmptyString(parsed.operatorUrl, "operatorUrl", "INVALID_SHARD_SESSION"),
      "operatorUrl",
      "INVALID_SHARD_SESSION",
    ),
    rpcUrl: parseHttpUrl(
      parseNonEmptyString(parsed.rpcUrl, "rpcUrl", "INVALID_SHARD_SESSION"),
      "rpcUrl",
      "INVALID_SHARD_SESSION",
    ),
    toriiUrl,
    toriiGrpcUrl,
    mainUrl:
      parsed.mainUrl === undefined || parsed.mainUrl === null
        ? null
        : parseHttpUrl(
            parseNonEmptyString(parsed.mainUrl, "mainUrl", "INVALID_SHARD_SESSION"),
            "mainUrl",
            "INVALID_SHARD_SESSION",
          ),
  };
};

export const resolveShardSession = (search: string, storedSessionRaw: string | null): ShardSessionParams | null => {
  const sessionFromUrl = parseShardUrlParams(search);
  if (sessionFromUrl !== null) {
    return sessionFromUrl;
  }

  if (storedSessionRaw === null) {
    return null;
  }

  return parseStoredShardSession(storedSessionRaw);
};

export const parseOperatorConfigResponse = (payload: unknown): OperatorConfig => {
  if (!isRecord(payload)) {
    throw new ShardProtocolError("INVALID_OPERATOR_CONFIG", "Operator config response must be an object");
  }

  return {
    shardContractAddress: parseHexAddress(
      payload.shard_contract_address,
      "shard_contract_address",
      "INVALID_OPERATOR_CONFIG",
    ),
  };
};

export const parseShardStatusEntriesFromStatusResponse = (payload: unknown): ShardStatusEntry[] => {
  if (!isRecord(payload)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator status response must be an object");
  }

  const rawShards = payload.shards;
  if (!Array.isArray(rawShards)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator status response must contain shards array");
  }

  return rawShards.map((rawShard, index) => {
    if (!isRecord(rawShard)) {
      throw new ShardProtocolError("INVALID_OPERATOR_STATUS", `Shard entry at index ${index} must be an object`);
    }

    return {
      phase: parseNonEmptyString(rawShard.phase, "phase", "INVALID_OPERATOR_STATUS"),
      shardId: parseNonEmptyString(rawShard.shard_id, "shard_id", "INVALID_OPERATOR_STATUS"),
      gameContractAddress: parseHexAddress(
        rawShard.game_contract_address,
        "game_contract_address",
        "INVALID_OPERATOR_STATUS",
      ),
      katanaUrl: parseOptionalHttpUrl(rawShard.katana_url, "katana_url", "INVALID_OPERATOR_STATUS"),
      toriiUrl: parseOptionalHttpUrl(rawShard.torii_url, "torii_url", "INVALID_OPERATOR_STATUS"),
      toriiGrpcUrl: parseOptionalHttpUrl(rawShard.torii_grpc_url, "torii_grpc_url", "INVALID_OPERATOR_STATUS"),
    };
  });
};

export const parseActiveShardFromStatusResponse = (payload: unknown): ActiveShard | null => {
  const entries = parseShardStatusEntriesFromStatusResponse(payload);
  for (const entry of entries) {
    const phase = parseNonEmptyString(entry.phase, "phase", "INVALID_OPERATOR_STATUS");
    if (phase !== "gameplay_active") {
      continue;
    }

    if (entry.katanaUrl === null || entry.toriiUrl === null) {
      throw new ShardProtocolError(
        "INVALID_OPERATOR_STATUS",
        "gameplay_active shard entry must include katana_url and torii_url",
      );
    }

    return {
      katanaUrl: entry.katanaUrl,
      toriiUrl: entry.toriiUrl,
      toriiGrpcUrl: entry.toriiGrpcUrl,
      gameContractAddress: entry.gameContractAddress,
      shardId: entry.shardId,
    };
  }

  return null;
};

export const parseTransportHealthFromStatusResponse = (payload: unknown): ShardTransportHealth => {
  if (!isRecord(payload)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator transport response must be an object");
  }

  const transport = payload.transport;
  if (!isRecord(transport)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator transport response must contain transport object");
  }

  const rawStatus = parseNonEmptyString(transport.status, "transport.status", "INVALID_OPERATOR_STATUS");
  if (rawStatus !== "healthy" && rawStatus !== "degraded" && rawStatus !== "unavailable") {
    throw new ShardProtocolError(
      "INVALID_OPERATOR_STATUS",
      "transport.status must be one of healthy, degraded, unavailable",
    );
  }

  return {
    status: rawStatus,
    toriiHttpReachable: parseBoolean(
      transport.torii_http_reachable,
      "transport.torii_http_reachable",
      "INVALID_OPERATOR_STATUS",
    ),
    toriiSqlReachable: parseBoolean(
      transport.torii_sql_reachable,
      "transport.torii_sql_reachable",
      "INVALID_OPERATOR_STATUS",
    ),
    toriiGrpcReachable: parseBoolean(
      transport.torii_grpc_reachable,
      "transport.torii_grpc_reachable",
      "INVALID_OPERATOR_STATUS",
    ),
    bootstrapSnapshotPresent: parseBoolean(
      transport.bootstrap_snapshot_present,
      "transport.bootstrap_snapshot_present",
      "INVALID_OPERATOR_STATUS",
    ),
    errorCode: parseOptionalString(transport.error_code, "transport.error_code", "INVALID_OPERATOR_STATUS"),
    errorMessage: parseOptionalString(transport.error_message, "transport.error_message", "INVALID_OPERATOR_STATUS"),
  };
};

export interface ShardIdParts {
  readonly gameContractAddress: string;
  readonly onchainShardId: string;
}

export const parseShardIdParts = (shardId: string): ShardIdParts => {
  const normalizedShardId = parseNonEmptyString(shardId, "shardId", "INVALID_SHARD_ID");
  const split = normalizedShardId.split("@");
  if (split.length !== 2) {
    throw new ShardProtocolError("INVALID_SHARD_ID", "shardId must contain exactly one @ separator");
  }

  const [gameContractAddress, onchainShardId] = split;
  if (!HEX_ADDRESS_PATTERN.test(gameContractAddress)) {
    throw new ShardProtocolError("INVALID_SHARD_ID", "shardId must begin with a hex game contract address");
  }
  if (onchainShardId.trim().length === 0) {
    throw new ShardProtocolError("INVALID_SHARD_ID", "shardId must contain non-empty onchain shard id");
  }

  return {
    gameContractAddress: gameContractAddress.toLowerCase(),
    onchainShardId,
  };
};

export const parseSettlementStreamEvent = (eventType: string, rawData: string): SettlementStreamEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `${eventType} event payload must be valid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `${eventType} event payload must be an object`);
  }

  const shardId = parseNonEmptyString(parsed.shard_id, "shard_id", "INVALID_SETTLEMENT_EVENT");

  if (eventType === "settling") {
    const stepLabel =
      parsed.step_label === undefined || parsed.step_label === null
        ? null
        : parseNonEmptyString(parsed.step_label, "step_label", "INVALID_SETTLEMENT_EVENT");
    return { type: "settling", shardId, stepLabel };
  }

  if (eventType === "completed") {
    return { type: "completed", shardId };
  }

  if (eventType === "failed") {
    const reason =
      parsed.reason === undefined || parsed.reason === null
        ? "Settlement failed"
        : parseNonEmptyString(parsed.reason, "reason", "INVALID_SETTLEMENT_EVENT");
    return { type: "failed", shardId, reason };
  }

  throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `Unsupported settlement event type: ${eventType}`);
};

export const extractGameContractFromShardId = (shardId: string): string => {
  return parseShardIdParts(shardId).gameContractAddress;
};

export const buildShardPlayUrl = (origin: string, params: ShardSessionParams): string => {
  const query = new URLSearchParams({
    shard_rpc: params.rpcUrl,
    shard_torii: params.toriiUrl,
    shard_torii_grpc: params.toriiGrpcUrl,
    shard_id: params.shardId,
    shard_operator: params.operatorUrl,
  });
  if (params.mainUrl !== null) {
    query.set("shard_main", params.mainUrl);
  }
  return `${origin}/play?${query.toString()}`;
};
