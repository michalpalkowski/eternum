import { useDojo } from "@bibliothecadao/react";
import { useCallback } from "react";
import { env } from "../../../../env";
import { useShardSettlement } from "@/hooks/use-shard-settlement";
import { useShardRequest } from "@/hooks/use-shard-request";
import { useShardStore } from "@/hooks/store/use-shard-store";
import type { ExecutableAccount } from "@/sharding/types";

export const ShardRequestButton = ({ entityId }: { entityId: number }) => {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const {
    account: { account },
  } = useDojo();

  if (isShardMode) {
    return <SettleButton account={account} />;
  }

  return <ShardButton entityId={entityId} account={account} />;
};

const ShardButton = ({ entityId, account }: { entityId: number; account: ExecutableAccount | null }) => {
  const operatorUrl = env.VITE_PUBLIC_SHARD_OPERATOR_URL;
  const { phase, error, requestShard, openShardTab, reset } = useShardRequest(account, operatorUrl ?? "");

  const handleClick = () => {
    if (operatorUrl === undefined) {
      return;
    }
    if (phase === "idle") {
      void requestShard([entityId]);
      return;
    }
    if (phase === "ready") {
      openShardTab();
      return;
    }
    if (phase === "error") {
      reset();
    }
  };

  const label = (() => {
    switch (phase) {
      case "requesting":
        return "Requesting...";
      case "waiting":
        return "Preparing shard...";
      case "ready":
        return "Open Shard";
      case "error":
        return "Retry";
      default:
        return "Shard";
    }
  })();

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={operatorUrl === undefined || phase === "requesting" || phase === "waiting"}
        className="bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 text-white text-xs font-semibold px-3 py-1 rounded transition-colors"
      >
        {label}
      </button>
      {operatorUrl === undefined && <span className="text-red-400 text-xs">Missing VITE_PUBLIC_SHARD_OPERATOR_URL</span>}
      {error !== null && <span className="text-red-400 text-xs">{error}</span>}
      {phase === "waiting" && <span className="text-amber-300 text-xs animate-pulse">Waiting for operator...</span>}
    </div>
  );
};

const SettleButton = ({ account }: { account: ExecutableAccount | null }) => {
  const shardId = useShardStore((state) => state.shardId);
  const operatorUrl = useShardStore((state) => state.operatorUrl);
  const { phase, stepLabel, error, startSettlement, reset } = useShardSettlement({
    account,
    shardId,
    operatorUrl,
  });

  const handleSettle = useCallback(async () => {
    if (phase === "error") {
      reset();
      return;
    }
    if (phase !== "idle") {
      return;
    }

    const confirmed = window.confirm("Settle this shard back to the main chain? This will merge all your changes.");
    if (!confirmed) {
      return;
    }

    await startSettlement();
  }, [phase, reset, startSettlement]);

  if (phase === "complete") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-green-400 text-xs font-semibold">Settlement complete — you can close this tab</span>
      </div>
    );
  }

  const label = (() => {
    switch (phase) {
      case "calling":
        return "Sending...";
      case "waiting":
        return stepLabel ?? "Settling...";
      case "error":
        return "Retry";
      default:
        return "Settle";
    }
  })();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            void handleSettle();
          }}
          disabled={phase === "calling" || phase === "waiting"}
          className="bg-amber-600 hover:bg-amber-500 disabled:bg-amber-800 text-white text-xs font-semibold px-3 py-1 rounded transition-colors"
        >
          {label}
        </button>
        {error !== null && <span className="text-red-400 text-xs">{error}</span>}
      </div>
      {phase === "waiting" && stepLabel !== null && <span className="text-amber-300 text-xs animate-pulse">{stepLabel}</span>}
    </div>
  );
};
