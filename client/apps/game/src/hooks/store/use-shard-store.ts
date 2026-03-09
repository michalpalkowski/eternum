import { create } from "zustand";

import { SHARD_SESSION_STORAGE_KEY, type ShardSessionParams, serializeShardSession } from "@/sharding/protocol";
import {
  resolveMainGameReturnUrl,
  resolveRuntimeContextFromWindow,
  type RuntimeContext,
} from "@/sharding/runtime-context";

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
  setRuntimeContext: (context: RuntimeContext) => void;
  enterShardMode: (params: ShardSessionParams, runtimeContext?: RuntimeContext | null) => void;
  clearShardMode: () => void;
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
    });
  },
  enterShardMode: ({ shardId, operatorUrl, rpcUrl, toriiUrl, toriiGrpcUrl, mainUrl }, runtimeContext?: RuntimeContext | null) => {
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
    }));
  },
}));
