import { parseShardUrlParams, type ShardSessionParams } from "./protocol";

export type PlayScene = "hex" | "map";

const PLAY_PATH_MATCHER = /^\/play(?:\/([^/?#]+))?/;
const SHARD_QUERY_KEYS = ["shard_rpc", "shard_torii", "shard_torii_grpc", "shard_id", "shard_operator", "shard_main"];

export interface MainRuntimeContext {
  readonly kind: "main";
  readonly playBasePath: string;
  readonly currentUrl: URL;
}

export interface ShardRuntimeContext {
  readonly kind: "shard";
  readonly playBasePath: string;
  readonly currentUrl: URL;
  readonly shard: ShardSessionParams;
  readonly mainGameReturnUrl: string;
}

export type RuntimeContext = MainRuntimeContext | ShardRuntimeContext;

export interface RuntimeNavigationState {
  readonly scene?: PlayScene;
  readonly col?: number;
  readonly row?: number;
  readonly spectate?: boolean;
}

const toSafeCoordinate = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return Math.trunc(value).toString();
};

const resolveSceneFromPath = (pathname: string): PlayScene | null => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const sceneSegment = segments[segments.length - 1];

  if (sceneSegment === "hex" || sceneSegment === "map") {
    return sceneSegment;
  }

  return null;
};

const parseSafeInt = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
};

const parseAbsoluteUrl = (rawUrl: string | null | undefined, origin: string): URL | null => {
  if (!rawUrl) {
    return null;
  }

  try {
    return new URL(rawUrl, origin);
  } catch {
    return null;
  }
};

export const resolvePlayBasePath = (pathname: string): string => {
  const match = pathname.match(PLAY_PATH_MATCHER);
  if (!match) {
    return "/play";
  }

  const worldSegment = match[1];
  if (!worldSegment || worldSegment === "hex" || worldSegment === "map") {
    return "/play";
  }

  return `/play/${worldSegment}`;
};

const removeShardQueryKeys = (searchParams: URLSearchParams): URLSearchParams => {
  const next = new URLSearchParams(searchParams);
  for (const key of SHARD_QUERY_KEYS) {
    next.delete(key);
  }
  return next;
};

const getFallbackCoordinates = (fallbackUrl: URL): { col: number; row: number } => {
  const fallbackCol = parseSafeInt(fallbackUrl.searchParams.get("col")) ?? 0;
  const fallbackRow = parseSafeInt(fallbackUrl.searchParams.get("row")) ?? 0;

  return {
    col: fallbackCol,
    row: fallbackRow,
  };
};

const canonicalizeMainGameUrl = (
  candidate: string | null | undefined,
  fallbackUrl: URL,
  overrideState?: RuntimeNavigationState,
): string => {
  const parsedCandidate = parseAbsoluteUrl(candidate, fallbackUrl.origin);
  const sourceUrl = parsedCandidate ?? fallbackUrl;

  const scene =
    overrideState?.scene ??
    resolveSceneFromPath(sourceUrl.pathname) ??
    resolveSceneFromPath(fallbackUrl.pathname) ??
    "map";

  const fallbackCoordinates = getFallbackCoordinates(fallbackUrl);
  const sourceCoordinates = {
    col: parseSafeInt(sourceUrl.searchParams.get("col")),
    row: parseSafeInt(sourceUrl.searchParams.get("row")),
  };

  const col = overrideState?.col ?? sourceCoordinates.col ?? fallbackCoordinates.col;
  const row = overrideState?.row ?? sourceCoordinates.row ?? fallbackCoordinates.row;

  const query = removeShardQueryKeys(sourceUrl.searchParams);
  query.set("col", toSafeCoordinate(col));
  query.set("row", toSafeCoordinate(row));

  if (overrideState?.spectate === true) {
    query.set("spectate", "true");
  } else if (overrideState?.spectate === false) {
    query.delete("spectate");
  }

  const basePath = resolvePlayBasePath(sourceUrl.pathname);
  const queryString = query.toString();
  const relativePath = `${basePath}/${scene}${queryString.length > 0 ? `?${queryString}` : ""}`;

  return `${fallbackUrl.origin}${relativePath}`;
};

export const resolveRuntimeContext = (href: string, shardSession?: ShardSessionParams | null): RuntimeContext => {
  const currentUrl = new URL(href);
  const playBasePath = resolvePlayBasePath(currentUrl.pathname);

  const effectiveShardSession = shardSession ?? parseShardUrlParams(currentUrl.search);
  if (effectiveShardSession === null) {
    return {
      kind: "main",
      playBasePath,
      currentUrl,
    };
  }

  return {
    kind: "shard",
    playBasePath,
    currentUrl,
    shard: effectiveShardSession,
    mainGameReturnUrl: canonicalizeMainGameUrl(effectiveShardSession.mainUrl, currentUrl),
  };
};

export const resolveRuntimeContextFromWindow = (): RuntimeContext => {
  return resolveRuntimeContext(window.location.href);
};

export const resolveMainGameReturnUrl = (context: RuntimeContext, overrideState?: RuntimeNavigationState): string => {
  if (context.kind === "shard") {
    return canonicalizeMainGameUrl(context.mainGameReturnUrl, context.currentUrl, overrideState);
  }

  return canonicalizeMainGameUrl(context.currentUrl.toString(), context.currentUrl, overrideState);
};

export const buildSceneUrl = (
  context: RuntimeContext,
  scene: PlayScene,
  col: number,
  row: number,
  options?: { spectate?: boolean },
): string => {
  const query = new URLSearchParams(context.currentUrl.search);

  if (context.kind === "shard") {
    query.set("shard_rpc", context.shard.rpcUrl);
    query.set("shard_torii", context.shard.toriiUrl);
    query.set("shard_torii_grpc", context.shard.toriiGrpcUrl);
    query.set("shard_id", context.shard.shardId);
    query.set("shard_operator", context.shard.operatorUrl);
    query.set("shard_main", resolveMainGameReturnUrl(context));
  } else {
    for (const key of SHARD_QUERY_KEYS) {
      query.delete(key);
    }
  }

  query.set("col", toSafeCoordinate(col));
  query.set("row", toSafeCoordinate(row));

  if (options?.spectate === true) {
    query.set("spectate", "true");
  } else if (options?.spectate === false) {
    query.delete("spectate");
  }

  return `${context.playBasePath}/${scene}?${query.toString()}`;
};
