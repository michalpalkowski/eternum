import { useDojo } from "@bibliothecadao/react";
import { useEntityQuery } from "@dojoengine/react";
import { getComponentValue, Has } from "@dojoengine/recs";
import { useCallback, useEffect, useRef } from "react";
import { env } from "../../../../env";
import { useShardSettlement } from "@/hooks/use-shard-settlement";
import { useShardRequest } from "@/hooks/use-shard-request";
import { useWorldConfigValue } from "@/hooks/helpers/use-world-config";
import { useShardStore } from "@/hooks/store/use-shard-store";
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

export const ShardRequestButton = ({ entityId }: { entityId: number }) => {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const {
    setup: { components },
    account: { account },
  } = useDojo();
  const worldConfig = useWorldConfigValue();
  const adminAddress = normalizeAddress(worldConfig?.admin_address);
  const accountAddress = normalizeAddress(account?.address);
  const canManageShards = adminAddress !== null && accountAddress !== null && adminAddress === accountAddress;
  const shouldCheckAdmin = env.VITE_PUBLIC_SHARD_ADMIN_CHECK;

  if (shouldCheckAdmin && !canManageShards) {
    return null;
  }

  const executableAccount = account as ExecutableAccount | null;

  if (isShardMode) {
    return <SettleButton account={executableAccount} />;
  }

  return <ShardButton entityId={entityId} account={executableAccount} components={components} />;
};

const toPositiveId = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const ShardButton = ({
  entityId,
  account,
  components,
}: {
  entityId: number;
  account: ExecutableAccount | null;
  components: any;
}) => {
  const operatorUrl = env.VITE_PUBLIC_SHARD_OPERATOR_URL;
  const { phase, error, errorCode, errorDiagnostic, targetShardId, initStepLabel, requestShard, recoverShard, openShardTab, reset } =
    useShardRequest(account, operatorUrl ?? "");
  const explorerEntities = useEntityQuery([Has(components.ExplorerTroops)]);
  const tradeEntities = useEntityQuery([Has(components.Trade)]);
  const autoOpenRecoveredShardRef = useRef(false);
  const collectRelatedIds = useCallback(() => {
    const explorerIds = new Set<number>();
    const tradeIds = new Set<number>();

    for (const explorerEntity of explorerEntities) {
      const explorer = getComponentValue(components.ExplorerTroops, explorerEntity);
      if (!explorer || toPositiveId(explorer.owner) !== entityId) {
        continue;
      }
      const explorerId = toPositiveId(explorer.explorer_id);
      if (explorerId !== null) {
        explorerIds.add(explorerId);
      }
    }

    for (const tradeEntity of tradeEntities) {
      const trade = getComponentValue(components.Trade, tradeEntity);
      if (!trade) {
        continue;
      }
      const isRelated = toPositiveId(trade.maker_id) === entityId || toPositiveId(trade.taker_id) === entityId;
      if (!isRelated) {
        continue;
      }
      const tradeId = toPositiveId(trade.trade_id);
      if (tradeId !== null) {
        tradeIds.add(tradeId);
      }
    }

    return {
      explorerIds: Array.from(explorerIds),
      tradeIds: Array.from(tradeIds),
      hyperstructureIds: [] as number[],
    };
  }, [components, entityId, explorerEntities, tradeEntities]);

  useEffect(() => {
    if (phase !== "ready" || !autoOpenRecoveredShardRef.current) {
      return;
    }
    autoOpenRecoveredShardRef.current = false;
    openShardTab();
  }, [openShardTab, phase]);

  const handleClick = () => {
    if (operatorUrl === undefined) {
      return;
    }
    if (phase === "idle") {
      autoOpenRecoveredShardRef.current = false;
      void requestShard([entityId], collectRelatedIds());
      return;
    }
    if (phase === "ready") {
      autoOpenRecoveredShardRef.current = false;
      openShardTab();
      return;
    }
    if (phase === "error") {
      autoOpenRecoveredShardRef.current = true;
      void recoverShard();
    }
  };

  const isRecoverableError = phase === "error" && (targetShardId !== null || error?.toLowerCase().includes("locked by shard"));

  const label = (() => {
    switch (phase) {
      case "requesting":
        return "Requesting...";
      case "waiting":
        return "Preparing shard...";
      case "ready":
        return "Open Shard";
      case "error":
        return isRecoverableError ? "Recover Shard" : "Retry";
      default:
        return "Shard";
    }
  })();

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={operatorUrl === undefined || phase === "requesting" || phase === "waiting"}
        className="bg-gold/20 hover:bg-gold/30 disabled:bg-gold/10 text-gold text-xs font-semibold px-3 py-1 rounded transition-colors"
      >
        {label}
      </button>
      {operatorUrl === undefined && <span className="text-red-400 text-xs">Missing VITE_PUBLIC_SHARD_OPERATOR_URL</span>}
      {error !== null && (
        <div className="text-red-400 text-xs leading-relaxed">
          <div>
            {errorCode !== null ? `[${errorCode}] ` : ""}
            {error}
          </div>
          {errorDiagnostic !== null && (
            <>
              <div className="text-red-300/80">
                Stage: <span className="font-mono">{errorDiagnostic.stage}</span> | Kind:{" "}
                <span className="font-mono">{errorDiagnostic.kind}</span>
              </div>
              {errorDiagnostic.details !== null && (
                <div className="text-red-200/80">Details: {errorDiagnostic.details}</div>
              )}
              <div className="text-amber-300/80">Hint: {errorDiagnostic.hint}</div>
            </>
          )}
        </div>
      )}
      {phase === "error" && (
        <button
          onClick={() => {
            autoOpenRecoveredShardRef.current = false;
            reset();
          }}
          className="bg-black/20 hover:bg-black/30 text-gold/80 text-xs font-semibold px-2 py-1 rounded transition-colors"
        >
          Reset
        </button>
      )}
      {phase === "waiting" && <span className="text-amber-300 text-xs animate-pulse">{initStepLabel ?? "Waiting for operator..."}</span>}
    </div>
  );
};

const SettleButton = ({ account }: { account: ExecutableAccount | null }) => {
  const shardId = useShardStore((state) => state.shardId);
  const operatorUrl = useShardStore((state) => state.operatorUrl);
  const mainGameReturnUrl = useShardStore((state) => state.mainGameReturnUrl);
  const clearShardMode = useShardStore((state) => state.clearShardMode);
  const { phase, stepLabel, error, errorCode, startSettlement, reset } = useShardSettlement({
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
        {error !== null && (
          <span className="text-red-400 text-xs">
            {errorCode !== null ? `[${errorCode}] ` : ""}
            {error}
          </span>
        )}
      </div>
      {phase === "waiting" && stepLabel !== null && <span className="text-amber-300 text-xs animate-pulse">{stepLabel}</span>}
    </div>
  );
};
