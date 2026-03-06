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
  readonly shardId: string;
  readonly operatorUrl: string;
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

export type SettlementStreamEvent =
  | { readonly type: "settling"; readonly stepLabel: string | null }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly reason: string };

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

  return parsed.toString();
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

export const parseShardUrlParams = (search: string): ShardSessionParams | null => {
  const params = new URLSearchParams(search);
  const rawRpcUrl = params.get("shard_rpc");
  const rawToriiUrl = params.get("shard_torii");
  const rawShardId = params.get("shard_id");
  const rawOperatorUrl = params.get("shard_operator");

  const hasAnyShardParam =
    rawRpcUrl !== null || rawToriiUrl !== null || rawShardId !== null || rawOperatorUrl !== null;
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

  return {
    rpcUrl: parseHttpUrl(rpcUrl, "shard_rpc", "INVALID_SHARD_QUERY"),
    toriiUrl: parseHttpUrl(toriiUrl, "shard_torii", "INVALID_SHARD_QUERY"),
    shardId: parseNonEmptyString(shardId, "shard_id", "INVALID_SHARD_QUERY"),
    operatorUrl: parseHttpUrl(operatorUrl, "shard_operator", "INVALID_SHARD_QUERY"),
  };
};

export const serializeShardSession = (params: ShardSessionParams): string =>
  JSON.stringify({
    shardId: params.shardId,
    operatorUrl: params.operatorUrl,
    rpcUrl: params.rpcUrl,
    toriiUrl: params.toriiUrl,
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
    toriiUrl: parseHttpUrl(
      parseNonEmptyString(parsed.toriiUrl, "toriiUrl", "INVALID_SHARD_SESSION"),
      "toriiUrl",
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

export const parseActiveShardFromStatusResponse = (payload: unknown): ActiveShard | null => {
  if (!isRecord(payload)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator status response must be an object");
  }

  const rawShards = payload.shards;
  if (!Array.isArray(rawShards)) {
    throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Operator status response must contain shards array");
  }

  for (const shard of rawShards) {
    if (!isRecord(shard)) {
      throw new ShardProtocolError("INVALID_OPERATOR_STATUS", "Each shard entry must be an object");
    }

    const phase = parseNonEmptyString(shard.phase, "phase", "INVALID_OPERATOR_STATUS");
    if (phase !== "gameplay_active") {
      continue;
    }

    return {
      katanaUrl: parseHttpUrl(
        parseNonEmptyString(shard.katana_url, "katana_url", "INVALID_OPERATOR_STATUS"),
        "katana_url",
        "INVALID_OPERATOR_STATUS",
      ),
      toriiUrl: parseHttpUrl(
        parseNonEmptyString(shard.torii_url, "torii_url", "INVALID_OPERATOR_STATUS"),
        "torii_url",
        "INVALID_OPERATOR_STATUS",
      ),
      toriiGrpcUrl:
        shard.torii_grpc_url === undefined || shard.torii_grpc_url === null
          ? null
          : parseNonEmptyString(shard.torii_grpc_url, "torii_grpc_url", "INVALID_OPERATOR_STATUS"),
      gameContractAddress: parseHexAddress(
        shard.game_contract_address,
        "game_contract_address",
        "INVALID_OPERATOR_STATUS",
      ),
      shardId: parseNonEmptyString(shard.shard_id, "shard_id", "INVALID_OPERATOR_STATUS"),
    };
  }

  return null;
};

export const parseSettlementStreamEvent = (eventType: string, rawData: string): SettlementStreamEvent => {
  if (eventType === "completed") {
    return { type: "completed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `${eventType} event payload must be valid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `${eventType} event payload must be an object`);
  }

  if (eventType === "settling") {
    const stepLabel =
      parsed.step_label === undefined || parsed.step_label === null
        ? null
        : parseNonEmptyString(parsed.step_label, "step_label", "INVALID_SETTLEMENT_EVENT");
    return { type: "settling", stepLabel };
  }

  if (eventType === "failed") {
    const reason =
      parsed.reason === undefined || parsed.reason === null
        ? "Settlement failed"
        : parseNonEmptyString(parsed.reason, "reason", "INVALID_SETTLEMENT_EVENT");
    return { type: "failed", reason };
  }

  throw new ShardProtocolError("INVALID_SETTLEMENT_EVENT", `Unsupported settlement event type: ${eventType}`);
};

export const extractGameContractFromShardId = (shardId: string): string => {
  const normalizedShardId = parseNonEmptyString(shardId, "shardId", "INVALID_SHARD_ID");
  const [gameContractAddress] = normalizedShardId.split("@");
  if (!HEX_ADDRESS_PATTERN.test(gameContractAddress)) {
    throw new ShardProtocolError("INVALID_SHARD_ID", "shardId must begin with a hex game contract address");
  }
  return gameContractAddress.toLowerCase();
};

export const buildShardPlayUrl = (origin: string, params: ShardSessionParams): string => {
  const query = new URLSearchParams({
    shard_rpc: params.rpcUrl,
    shard_torii: params.toriiUrl,
    shard_id: params.shardId,
    shard_operator: params.operatorUrl,
  });
  return `${origin}/play?${query.toString()}`;
};
