import { create } from "zustand";

import { SHARD_SESSION_STORAGE_KEY, type ShardSessionParams, serializeShardSession } from "@/sharding/protocol";
import {
  resolveMainGameReturnUrl,
  resolveRuntimeContextFromWindow,
  type RuntimeContext,
} from "@/sharding/runtime-context";

export type MainShardRequestPhase = "idle" | "requesting" | "waiting" | "ready" | "error";

const resolveCanonicalMainGameReturnUrl = (
  params: Pick<ShardSessionParams, "mainUrl">,
  runtimeContext?: RuntimeContext | null,
): string | null => {
  if (runtimeContext?.kind === "shard") {
    return resolveMainGameReturnUrl(runtimeContext);
  }

  if (params.mainUrl !== null) {
    return params.mainUrl;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    return resolveMainGameReturnUrl(resolveRuntimeContextFromWindow());
  } catch {
    return null;
  }
};

interface ShardState {
  runtimeContext: RuntimeContext | null;
  isShardMode: boolean;
  shardId: string | null;
  operatorUrl: string | null;
  shardRpcUrl: string | null;
  shardToriiUrl: string | null;
  shardToriiGrpcUrl: string | null;
  mainUrl: string | null;
  mainGameReturnUrl: string | null;
  mainShardRequestPhase: MainShardRequestPhase;
  mainShardTargetShardId: string | null;
  mainShardRequestErrorCode: string | null;
  mainShardRequestError: string | null;
  setRuntimeContext: (context: RuntimeContext) => void;
  enterShardMode: (params: ShardSessionParams, runtimeContext?: RuntimeContext | null) => void;
  clearShardMode: () => void;
  setMainShardRequestState: (state: {
    phase: MainShardRequestPhase;
    targetShardId?: string | null;
    errorCode?: string | null;
    error?: string | null;
  }) => void;
  clearMainShardRequestState: () => void;
}

export const useShardStore = create<ShardState>()((set) => ({
  runtimeContext: null,
  isShardMode: false,
  shardId: null,
  operatorUrl: null,
  shardRpcUrl: null,
  shardToriiUrl: null,
  shardToriiGrpcUrl: null,
  mainUrl: null,
  mainGameReturnUrl: null,
  mainShardRequestPhase: "idle",
  mainShardTargetShardId: null,
  mainShardRequestErrorCode: null,
  mainShardRequestError: null,
  setRuntimeContext: (context: RuntimeContext) => {
    if (context.kind !== "shard") {
      set({
        runtimeContext: context,
        isShardMode: false,
        shardId: null,
        operatorUrl: null,
        shardRpcUrl: null,
        shardToriiUrl: null,
        shardToriiGrpcUrl: null,
        mainUrl: null,
        mainGameReturnUrl: null,
        mainShardRequestPhase: "idle",
        mainShardTargetShardId: null,
        mainShardRequestErrorCode: null,
        mainShardRequestError: null,
      });
      return;
    }

    const canonicalMainGameReturnUrl = resolveMainGameReturnUrl(context);
    set({
      runtimeContext: context,
      isShardMode: true,
      shardId: context.shard.shardId,
      operatorUrl: context.shard.operatorUrl,
      shardRpcUrl: context.shard.rpcUrl,
      shardToriiUrl: context.shard.toriiUrl,
      shardToriiGrpcUrl: context.shard.toriiGrpcUrl,
      mainUrl: canonicalMainGameReturnUrl,
      mainGameReturnUrl: canonicalMainGameReturnUrl,
      mainShardRequestPhase: "idle",
      mainShardTargetShardId: null,
      mainShardRequestErrorCode: null,
      mainShardRequestError: null,
    });
  },
  enterShardMode: (
    { shardId, operatorUrl, rpcUrl, toriiUrl, toriiGrpcUrl, mainUrl },
    runtimeContext?: RuntimeContext | null,
  ) => {
    const canonicalMainGameReturnUrl = resolveCanonicalMainGameReturnUrl({ mainUrl }, runtimeContext);

    sessionStorage.setItem(
      SHARD_SESSION_STORAGE_KEY,
      serializeShardSession({
        shardId,
        operatorUrl,
        rpcUrl,
        toriiUrl,
        toriiGrpcUrl,
        mainUrl: canonicalMainGameReturnUrl,
      }),
    );

    set({
      runtimeContext: runtimeContext ?? null,
      isShardMode: true,
      shardId,
      operatorUrl,
      shardRpcUrl: rpcUrl,
      shardToriiUrl: toriiUrl,
      shardToriiGrpcUrl: toriiGrpcUrl,
      mainUrl: canonicalMainGameReturnUrl,
      mainGameReturnUrl: canonicalMainGameReturnUrl,
      mainShardRequestPhase: "idle",
      mainShardTargetShardId: null,
      mainShardRequestErrorCode: null,
      mainShardRequestError: null,
    });
  },
  clearShardMode: () => {
    sessionStorage.removeItem(SHARD_SESSION_STORAGE_KEY);
    set((state) => ({
      runtimeContext: state.runtimeContext?.kind === "main" ? state.runtimeContext : null,
      isShardMode: false,
      shardId: null,
      operatorUrl: null,
      shardRpcUrl: null,
      shardToriiUrl: null,
      shardToriiGrpcUrl: null,
      mainUrl: null,
      mainGameReturnUrl: null,
      mainShardRequestPhase: "idle",
      mainShardTargetShardId: null,
      mainShardRequestErrorCode: null,
      mainShardRequestError: null,
    }));
  },
  setMainShardRequestState: ({ phase, targetShardId = null, errorCode = null, error = null }) => {
    set({
      mainShardRequestPhase: phase,
      mainShardTargetShardId: targetShardId,
      mainShardRequestErrorCode: errorCode,
      mainShardRequestError: error,
    });
  },
  clearMainShardRequestState: () => {
    set({
      mainShardRequestPhase: "idle",
      mainShardTargetShardId: null,
      mainShardRequestErrorCode: null,
      mainShardRequestError: null,
    });
  },
}));
