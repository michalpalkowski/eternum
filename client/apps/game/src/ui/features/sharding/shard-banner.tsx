import { useDojo } from "@bibliothecadao/react";
import { useCallback, useEffect } from "react";
import { WORLD_CONFIG_ID } from "@bibliothecadao/types";
import { useComponentValue } from "@dojoengine/react";
import { getEntityIdFromKeys } from "@dojoengine/utils";

import { useShardStore } from "@/hooks/store/use-shard-store";
import { useShardSettlement } from "@/hooks/use-shard-settlement";
import { resolveMainGameReturnUrl, resolveRuntimeContextFromWindow } from "@/sharding/runtime-context";
import type { ExecutableAccount } from "@/sharding/types";

const normalizeAddress = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    try {
      return `0x${BigInt(trimmed).toString(16)}`.toLowerCase();
    } catch {
      return null;
    }
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`.toLowerCase();
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return `0x${BigInt(value).toString(16)}`.toLowerCase();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.value !== undefined) {
      return normalizeAddress(record.value);
    }
    if (record.address !== undefined) {
      return normalizeAddress(record.address);
    }
  }
  return null;
};

export const ShardBanner = () => {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const shardId = useShardStore((state) => state.shardId);
  const operatorUrl = useShardStore((state) => state.operatorUrl);
  const mainGameReturnUrl = useShardStore((state) => state.mainGameReturnUrl);
  const clearShardMode = useShardStore((state) => state.clearShardMode);
  const {
    account: { account },
    setup: { components },
  } = useDojo();
  const worldConfig = useComponentValue(components.WorldConfig, getEntityIdFromKeys([WORLD_CONFIG_ID]));
  const adminAddress = normalizeAddress(worldConfig?.admin_address);
  const accountAddress = normalizeAddress(account?.address);
  const canSettleShard = adminAddress !== null && accountAddress !== null && adminAddress === accountAddress;

  const { phase, stepLabel, error, startSettlement, reset } = useShardSettlement({
    account: account as ExecutableAccount | null,
    shardId,
    operatorUrl,
  });

  useEffect(() => {
    if (phase !== "complete") {
      return;
    }

    const runtimeContext = useShardStore.getState().runtimeContext ?? resolveRuntimeContextFromWindow();
    const returnUrl = mainGameReturnUrl ?? resolveMainGameReturnUrl(runtimeContext);

    let destinationUrl = returnUrl;
    try {
      const url = new URL(returnUrl, window.location.origin);
      url.searchParams.set("shard_return", "1");
      destinationUrl = url.toString();
    } catch {
      destinationUrl = returnUrl;
    }

    clearShardMode();
    window.location.assign(destinationUrl);
  }, [clearShardMode, mainGameReturnUrl, phase]);

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
      {canSettleShard ? (
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
      ) : (
        <span className="text-xs opacity-80">Settlement available for admin only</span>
      )}
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
