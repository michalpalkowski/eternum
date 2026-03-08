import { useDojo } from "@bibliothecadao/react";
import { useCallback, useEffect } from "react";
import { useShardSettlement } from "@/hooks/use-shard-settlement";
import { useShardStore } from "@/hooks/store/use-shard-store";
import type { ExecutableAccount } from "@/sharding/types";

export const ShardBanner = () => {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const shardId = useShardStore((state) => state.shardId);
  const operatorUrl = useShardStore((state) => state.operatorUrl);
  const mainUrl = useShardStore((state) => state.mainUrl);
  const clearShardMode = useShardStore((state) => state.clearShardMode);
  const {
    account: { account },
  } = useDojo();
  const { phase, stepLabel, error, startSettlement, reset } = useShardSettlement({
    account: account as ExecutableAccount | null,
    shardId,
    operatorUrl,
  });

  useEffect(() => {
    if (phase !== "complete") {
      return;
    }

    clearShardMode();
    window.location.assign(mainUrl ?? "/play");
  }, [clearShardMode, mainUrl, phase]);

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

  if (!isShardMode) {
    return null;
  }

  if (phase === "complete") {
    return (
      <Banner color="green">
        <span className="font-bold text-sm tracking-wider">SETTLEMENT COMPLETE</span>
        <span className="text-xs opacity-80">Returning to main instance...</span>
      </Banner>
    );
  }

  return (
    <Banner color="amber">
      <span className="font-bold text-sm tracking-wider">SHARD MODE</span>
      <span className="text-xs opacity-60">Shard {shardId?.slice(0, 10)}</span>
      {error !== null && <span className="text-red-300 text-xs">{error}</span>}
      <button
        onClick={() => {
          void handleSettle();
        }}
        disabled={phase !== "idle" && phase !== "error"}
        className="bg-amber-600 hover:bg-amber-500 disabled:bg-amber-800 text-white text-sm font-semibold px-4 py-1 rounded transition-colors"
      >
        {phase === "calling"
          ? "Sending..."
          : phase === "waiting"
            ? stepLabel ?? "Settling..."
            : phase === "error"
              ? "Retry"
              : "Settle"}
      </button>
    </Banner>
  );
};

const bannerStyles = {
  amber: "bg-amber-900/90 border-amber-500/50 text-amber-200",
  green: "bg-green-900/90 border-green-500/50 text-green-200",
} as const;

const Banner = ({ color, children }: { color: "amber" | "green"; children: React.ReactNode }) => (
  <div className="fixed top-14 left-1/2 -translate-x-1/2 z-40 pointer-events-auto">
    <div className={`${bannerStyles[color]} border rounded-b-lg px-6 py-2 flex items-center gap-4 shadow-lg`}>
      {children}
    </div>
  </div>
);
