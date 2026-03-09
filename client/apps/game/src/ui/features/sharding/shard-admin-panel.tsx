import { getContractByName } from "@dojoengine/core";
import { useMemo, useState } from "react";

import { useAccountStore } from "@/hooks/store/use-account-store";
import { useShardRequest } from "@/hooks/use-shard-request";
import type { ExecutableAccount } from "@/sharding/types";
import { dojoConfig } from "../../../../dojo-config";
import { env } from "../../../../env";

const parseEntityId = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

export const ShardAdminPanel = () => {
  const account = useAccountStore((state) => state.account);
  const operatorUrl = env.VITE_PUBLIC_SHARD_OPERATOR_URL ?? "";
  const defaultShardingContractAddress = useMemo(
    () => getContractByName(dojoConfig.manifest, "s1_eternum", "sharding_systems").address,
    [],
  );

  const [entityIdInput, setEntityIdInput] = useState("");
  const [worldAddress, setWorldAddress] = useState(dojoConfig.manifest.world.address);
  const [shardingContractAddress, setShardingContractAddress] = useState(defaultShardingContractAddress);

  const { phase, error, errorCode, requestShard, openShardTab, reset, targetShardId } = useShardRequest(
    (account as ExecutableAccount | null) ?? null,
    operatorUrl,
    {
      worldAddress,
      shardingContractAddress,
    },
  );

  const parsedEntityId = parseEntityId(entityIdInput);

  const handleClick = () => {
    if (operatorUrl.length === 0) {
      return;
    }
    if (phase === "idle" && parsedEntityId !== null) {
      void requestShard([parsedEntityId]);
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

  const buttonLabel = (() => {
    switch (phase) {
      case "requesting":
        return "Requesting...";
      case "waiting":
        return "Preparing shard...";
      case "ready":
        return "Open Shard";
      case "error":
        return "Reset";
      default:
        return "Request Shard";
    }
  })();

  const buttonDisabled =
    operatorUrl.length === 0 ||
    phase === "requesting" ||
    phase === "waiting" ||
    (phase === "idle" && parsedEntityId === null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <input
          type="text"
          value={entityIdInput}
          onChange={(event) => setEntityIdInput(event.target.value)}
          placeholder="Entity ID (realm)"
          className="w-full rounded-md border border-gold/20 bg-black/40 px-3 py-2 text-sm font-mono text-gold placeholder-gold/40"
        />
        <input
          type="text"
          value={worldAddress}
          onChange={(event) => setWorldAddress(event.target.value)}
          placeholder="World address"
          className="w-full rounded-md border border-gold/20 bg-black/40 px-3 py-2 text-sm font-mono text-gold placeholder-gold/40"
        />
        <input
          type="text"
          value={shardingContractAddress}
          onChange={(event) => setShardingContractAddress(event.target.value)}
          placeholder="Sharding systems address"
          className="w-full rounded-md border border-gold/20 bg-black/40 px-3 py-2 text-sm font-mono text-gold placeholder-gold/40"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={buttonDisabled}
          className="rounded-md bg-gold/20 px-4 py-2 text-sm font-semibold text-gold transition-colors hover:bg-gold/30 disabled:cursor-not-allowed disabled:bg-gold/10"
        >
          {buttonLabel}
        </button>
        {phase === "waiting" && targetShardId !== null && (
          <span className="text-xs text-amber-300">Tracking shard: {targetShardId}</span>
        )}
      </div>

      {operatorUrl.length === 0 && (
        <p className="text-xs text-red-400">Missing VITE_PUBLIC_SHARD_OPERATOR_URL</p>
      )}
      {error !== null && (
        <p className="text-xs text-red-400">
          {errorCode !== null ? `[${errorCode}] ` : ""}
          {error}
        </p>
      )}
      <p className="text-xs text-gold/60">
        Manual shard request is admin-only on-chain (`request_shard_all` / `finish_shard` enforce admin permissions).
      </p>
    </div>
  );
};
