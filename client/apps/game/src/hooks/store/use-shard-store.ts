import { create } from "zustand";
import { SHARD_SESSION_STORAGE_KEY, type ShardSessionParams, serializeShardSession } from "@/sharding/protocol";

interface ShardState {
  isShardMode: boolean;
  shardId: string | null;
  operatorUrl: string | null;
  shardRpcUrl: string | null;
  shardToriiUrl: string | null;
  enterShardMode: (params: ShardSessionParams) => void;
  clearShardMode: () => void;
}

export const useShardStore = create<ShardState>()((set) => ({
  isShardMode: false,
  shardId: null,
  operatorUrl: null,
  shardRpcUrl: null,
  shardToriiUrl: null,
  enterShardMode: ({ shardId, operatorUrl, rpcUrl, toriiUrl }) => {
    sessionStorage.setItem(
      SHARD_SESSION_STORAGE_KEY,
      serializeShardSession({ shardId, operatorUrl, rpcUrl, toriiUrl }),
    );
    set({
      isShardMode: true,
      shardId,
      operatorUrl,
      shardRpcUrl: rpcUrl,
      shardToriiUrl: toriiUrl,
    });
  },
  clearShardMode: () => {
    sessionStorage.removeItem(SHARD_SESSION_STORAGE_KEY);
    set({
      isShardMode: false,
      shardId: null,
      operatorUrl: null,
      shardRpcUrl: null,
      shardToriiUrl: null,
    });
  },
}));
