import { useCallback, useEffect, useMemo, useRef } from "react";

import { getStructuresDataFromTorii } from "@/dojo/queries";
import { syncEntitiesDebounced } from "@/dojo/sync";
import { sqlApi } from "@/services/api";
import { padHexAddressTo66 } from "@/ui/utils/utils";
import { useDojo, usePlayerStructures } from "@bibliothecadao/react";
import { MemberClause } from "@dojoengine/sdk";
import { getComponentValue } from "@dojoengine/recs";
import type { PatternMatching } from "@dojoengine/torii-client";
import type { Clause } from "@dojoengine/torii-wasm/types";
import { getEntityIdFromKeys } from "@dojoengine/utils";
import { useAccountStore } from "../store/use-account-store";
import { selectUnsyncedOwnedStructureTargets } from "./player-structure-sync-utils";

// Models synced per-player via a scoped subscription (see usePlayerStructureSync)
const PLAYER_STRUCTURE_MODELS: string[] = [
  "s1_eternum-ProductionBoostBonus",
  "s1_eternum-Resource",
  "s1_eternum-ResourceArrival",
];
const MISSING_STRUCTURE_RETRY_COOLDOWN_MS = 10_000;

const PLAYER_STRUCTURE_SYNC_DEBUG = import.meta.env.DEV;

const syncDiag = (event: string, details?: Record<string, unknown>) => {
  if (!PLAYER_STRUCTURE_SYNC_DEBUG) {
    return;
  }

  if (details) {
    console.log("[usePlayerStructureSync]", event, details);
    return;
  }

  console.log("[usePlayerStructureSync]", event);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unwrapToriiFieldValue = (value: unknown): unknown => {
  let current = value;

  while (isRecord(current) && "value" in current && ("type" in current || "type_name" in current || "key" in current)) {
    current = current.value;
  }

  return current;
};

const readOwnerFromStructureModelUpdate = (update: unknown): string | null => {
  if (!isRecord(update) || !isRecord(update.models)) return null;

  const structureModel = update.models["s1_eternum-Structure"];
  if (!isRecord(structureModel)) return null;

  const directOwner = unwrapToriiFieldValue(structureModel.owner);
  if (typeof directOwner === "string" && directOwner.startsWith("0x")) {
    return directOwner;
  }

  const base = unwrapToriiFieldValue(structureModel.base);
  if (!isRecord(base)) return null;

  const ownerFromBase = unwrapToriiFieldValue(base.owner);
  if (typeof ownerFromBase === "string" && ownerFromBase.startsWith("0x")) {
    return ownerFromBase;
  }

  return null;
};

export const usePlayerStructureSync = () => {
  const {
    setup: {
      network: { toriiClient, contractComponents },
    },
    setup,
  } = useDojo();

  const playerStructures = usePlayerStructures();

  const subscriptionRef = useRef<{ cancel: () => void } | null>(null);
  const ownerStructureSubscriptionRef = useRef<{ cancel: () => void } | null>(null);
  const syncedStructureIds = useRef<Set<number>>(new Set());
  const inFlightStructureIds = useRef<Set<number>>(new Set());
  const backfillOwnedStructuresRef = useRef<(() => Promise<void>) | null>(null);
  const accountSyncEpochRef = useRef(0);
  const missingStructureRetryUntilRef = useRef<Map<number, number>>(new Map());
  const lastMissingLogKeyRef = useRef<string>("");
  const lastSubscriptionSignatureRef = useRef<string>("");
  const lastNewlySeenStartLogKeyRef = useRef<string>("");
  const lastNewlySeenCompleteLogKeyRef = useRef<string>("");
  const structureSyncTargets = useMemo(
    () =>
      playerStructures
        .map((structure) => ({
          entityId: Number(structure.entityId),
          position: { col: Number(structure.position.x), row: Number(structure.position.y) },
        }))
        .filter(
          (target) =>
            Number.isFinite(target.entityId) &&
            Number.isFinite(target.position.col) &&
            Number.isFinite(target.position.row),
        )
        .toSorted((left, right) => left.entityId - right.entityId),
    [playerStructures],
  );
  const structureSyncTargetsKey = useMemo(
    () =>
      structureSyncTargets
        .map((target) => `${target.entityId}:${target.position.col},${target.position.row}`)
        .join("|"),
    [structureSyncTargets],
  );
  const structureEntityIds = useMemo(
    () => structureSyncTargets.map((target) => target.entityId),
    [structureSyncTargetsKey],
  );
  const structurePositions = useMemo(
    () => structureSyncTargets.map((target) => ({ col: target.position.col, row: target.position.row })),
    [structureSyncTargetsKey],
  );

  const accountAddress = useAccountStore().account?.address;
  const toriiComponents = contractComponents as unknown as Parameters<typeof getStructuresDataFromTorii>[1];
  const structureEntityIdsRef = useRef<ReadonlySet<number>>(new Set());
  const isBackfillRunning = useRef(false);
  const resolveHydratedStructureIds = useCallback(
    (structureIds: number[]) => {
      const structureComponent = (setup.components as any).Structure;
      if (!structureComponent) {
        return {
          hydratedIds: [] as number[],
          missingIds: [...structureIds],
        };
      }

      const hydratedIds: number[] = [];
      const missingIds: number[] = [];

      structureIds.forEach((entityId) => {
        try {
          const entityKey = getEntityIdFromKeys([BigInt(entityId)]);
          const structure = getComponentValue(structureComponent, entityKey);
          if (structure) {
            hydratedIds.push(entityId);
          } else {
            missingIds.push(entityId);
          }
        } catch {
          missingIds.push(entityId);
        }
      });

      return { hydratedIds, missingIds };
    },
    [setup.components],
  );
  const applyMissingStructureCooldown = useCallback((structureIds: number[]) => {
    if (structureIds.length === 0) return;
    const retryAt = Date.now() + MISSING_STRUCTURE_RETRY_COOLDOWN_MS;
    structureIds.forEach((structureId) => {
      missingStructureRetryUntilRef.current.set(structureId, retryAt);
    });
  }, []);
  const clearMissingStructureCooldown = useCallback((structureIds: number[]) => {
    if (structureIds.length === 0) return;
    structureIds.forEach((structureId) => {
      missingStructureRetryUntilRef.current.delete(structureId);
    });
  }, []);
  const logMissingMaterialization = useCallback(
    (source: "backfill" | "newly-seen", missingStructureIds: number[]) => {
      if (missingStructureIds.length === 0) {
        return;
      }

      const key = `${source}:${accountAddress ?? "unknown"}:${missingStructureIds.join(",")}`;
      if (lastMissingLogKeyRef.current === key) {
        return;
      }
      lastMissingLogKeyRef.current = key;

      console.warn("[usePlayerStructureSync] Structure models missing after sync", {
        source,
        accountAddress: accountAddress ?? null,
        missingStructureIds,
      });
    },
    [accountAddress],
  );
  const shouldRetryStructureSync = useCallback((structureId: number, now: number) => {
    const retryAt = missingStructureRetryUntilRef.current.get(structureId);
    if (retryAt === undefined) return true;
    if (retryAt <= now) {
      missingStructureRetryUntilRef.current.delete(structureId);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    structureEntityIdsRef.current = new Set(structureEntityIds);
  }, [structureEntityIds]);

  useEffect(() => {
    accountSyncEpochRef.current += 1;
    syncedStructureIds.current.clear();
    inFlightStructureIds.current.clear();
    missingStructureRetryUntilRef.current.clear();
    lastMissingLogKeyRef.current = "";
    lastSubscriptionSignatureRef.current = "";
    lastNewlySeenStartLogKeyRef.current = "";
    lastNewlySeenCompleteLogKeyRef.current = "";
    isBackfillRunning.current = false;
    syncDiag("account-epoch-reset", {
      accountAddress: accountAddress ?? null,
      epoch: accountSyncEpochRef.current,
    });
  }, [accountAddress]);

  // Keep owned structures backfilled into RECS so ownership UI updates even if stream updates are missed.
  useEffect(() => {
    if (!accountAddress || !toriiClient || !toriiComponents) return;
    let cancelled = false;

    const backfillOwnedStructures = async () => {
      if (isBackfillRunning.current) {
        syncDiag("backfill-skip-already-running");
        return;
      }
      isBackfillRunning.current = true;

      let claimedStructureIds: number[] = [];
      try {
        const ownedStructures = await sqlApi.fetchStructuresByOwner(accountAddress);
        const ownedStructureIds = ownedStructures.map((structure) => structure.entity_id);
        syncDiag("backfill-owned-structures-fetched", {
          accountAddress,
          ownedStructureCount: ownedStructures.length,
          ownedStructureIdsCsv: ownedStructureIds.join(","),
        });
        if (cancelled) return;
        if (ownedStructures.length === 0) {
          syncDiag("backfill-no-owned-structures", { accountAddress });
          return;
        }

        const structuresToSync = selectUnsyncedOwnedStructureTargets({
          ownedStructures,
          currentPlayerStructureIds: structureEntityIdsRef.current,
          inFlightStructureIds: inFlightStructureIds.current,
        }).filter(({ entityId }) => shouldRetryStructureSync(entityId, Date.now()));

        if (structuresToSync.length === 0) {
          syncDiag("backfill-nothing-to-sync", {
            accountAddress,
            currentPlayerStructureCount: structureEntityIdsRef.current.size,
            inFlightCount: inFlightStructureIds.current.size,
          });
          return;
        }

        structuresToSync.forEach(({ entityId }) => inFlightStructureIds.current.add(entityId));
        claimedStructureIds = structuresToSync.map(({ entityId }) => entityId);
        syncDiag("backfill-sync-start", {
          accountAddress,
          structureIds: claimedStructureIds,
          structureIdsCsv: claimedStructureIds.join(","),
        });

        await getStructuresDataFromTorii(toriiClient, toriiComponents, structuresToSync);

        if (!cancelled) {
          const { hydratedIds, missingIds } = resolveHydratedStructureIds(claimedStructureIds);
          clearMissingStructureCooldown(hydratedIds);
          applyMissingStructureCooldown(missingIds);
          hydratedIds.forEach((entityId) => syncedStructureIds.current.add(entityId));
          syncDiag("backfill-sync-complete", {
            accountAddress,
            syncedStructureIds: hydratedIds,
            syncedStructureIdsCsv: hydratedIds.join(","),
            missingStructureIds: missingIds,
            missingStructureIdsCsv: missingIds.join(","),
          });
          logMissingMaterialization("backfill", missingIds);
        }
      } catch (error) {
        console.error("[usePlayerStructureSync] Failed to backfill owned structures", error);
      } finally {
        claimedStructureIds.forEach((entityId) => inFlightStructureIds.current.delete(entityId));
        isBackfillRunning.current = false;
      }
    };

    backfillOwnedStructuresRef.current = backfillOwnedStructures;
    void backfillOwnedStructures();

    return () => {
      cancelled = true;
      if (backfillOwnedStructuresRef.current === backfillOwnedStructures) {
        backfillOwnedStructuresRef.current = null;
      }
    };
  }, [
    accountAddress,
    applyMissingStructureCooldown,
    clearMissingStructureCooldown,
    logMissingMaterialization,
    resolveHydratedStructureIds,
    shouldRetryStructureSync,
    toriiClient,
    toriiComponents,
  ]);

  useEffect(() => {
    if (!accountAddress || !toriiClient) return;
    let cancelled = false;

    const ownerStructureClause = MemberClause("s1_eternum-Structure", "owner", "Eq", {
      type: "ContractAddress",
      value: padHexAddressTo66(accountAddress),
    }).build();
    const normalizedAccountAddress = padHexAddressTo66(accountAddress).toLowerCase();

    const subscribeToOwnedStructureUpdates = async () => {
      const ownerSubscription = await toriiClient.onEntityUpdated(ownerStructureClause, (value: unknown) => {
        if (cancelled) return;

        const owner = readOwnerFromStructureModelUpdate(value);
        if (!owner) return;

        const normalizedUpdateOwner = padHexAddressTo66(owner).toLowerCase();
        if (normalizedUpdateOwner !== normalizedAccountAddress) return;
        syncDiag("owner-update-trigger-backfill", {
          accountAddress,
          owner,
        });

        void backfillOwnedStructuresRef.current?.();
      });

      if (cancelled) {
        ownerSubscription.cancel();
        return;
      }

      ownerStructureSubscriptionRef.current = ownerSubscription;
    };

    void subscribeToOwnedStructureUpdates();

    return () => {
      cancelled = true;
      if (ownerStructureSubscriptionRef.current) {
        ownerStructureSubscriptionRef.current.cancel();
        ownerStructureSubscriptionRef.current = null;
      }
    };
  }, [accountAddress, toriiClient]);

  // Sync newly-seen structures into RECS (e.g. first settlement).
  useEffect(() => {
    if (!toriiClient || !toriiComponents || structureSyncTargets.length === 0) return;

    const syncEpochAtRequestStart = accountSyncEpochRef.current;
    const now = Date.now();

    const structuresToSync = structureSyncTargets
      .filter(
        (structure) =>
          !syncedStructureIds.current.has(structure.entityId) &&
          !inFlightStructureIds.current.has(structure.entityId) &&
          shouldRetryStructureSync(structure.entityId, now),
      )
      .map((structure) => ({
        entityId: structure.entityId,
        position: { col: structure.position.col, row: structure.position.row },
      }));

    if (structuresToSync.length === 0) return;

    structuresToSync.forEach(({ entityId }) => inFlightStructureIds.current.add(entityId));
    const structuresToSyncIds = structuresToSync.map(({ entityId }) => entityId);
    const newlySeenStartLogKey = `${accountAddress ?? "unknown"}:${structuresToSyncIds.join(",")}`;
    if (lastNewlySeenStartLogKeyRef.current !== newlySeenStartLogKey) {
      lastNewlySeenStartLogKeyRef.current = newlySeenStartLogKey;
      syncDiag("newly-seen-sync-start", {
        accountAddress: accountAddress ?? null,
        structureIds: structuresToSyncIds,
        structureIdsCsv: structuresToSyncIds.join(","),
      });
    }

    void (async () => {
      try {
        await getStructuresDataFromTorii(toriiClient, toriiComponents, structuresToSync);

        if (syncEpochAtRequestStart === accountSyncEpochRef.current) {
          const { hydratedIds, missingIds } = resolveHydratedStructureIds(structuresToSyncIds);
          clearMissingStructureCooldown(hydratedIds);
          applyMissingStructureCooldown(missingIds);
          hydratedIds.forEach((entityId) => syncedStructureIds.current.add(entityId));
          const newlySeenCompleteLogKey = `${accountAddress ?? "unknown"}:${hydratedIds.join(",")}:${missingIds.join(",")}`;
          if (lastNewlySeenCompleteLogKeyRef.current !== newlySeenCompleteLogKey) {
            lastNewlySeenCompleteLogKeyRef.current = newlySeenCompleteLogKey;
            syncDiag("newly-seen-sync-complete", {
              accountAddress: accountAddress ?? null,
              structureIds: hydratedIds,
              structureIdsCsv: hydratedIds.join(","),
              missingStructureIds: missingIds,
              missingStructureIdsCsv: missingIds.join(","),
            });
          }
          logMissingMaterialization("newly-seen", missingIds);
        }
      } catch (error) {
        console.error("[usePlayerStructureSync] Failed to sync newly seen structures", error);
      } finally {
        structuresToSync.forEach(({ entityId }) => inFlightStructureIds.current.delete(entityId));
      }
    })();
  }, [
    accountAddress,
    applyMissingStructureCooldown,
    clearMissingStructureCooldown,
    logMissingMaterialization,
    resolveHydratedStructureIds,
    shouldRetryStructureSync,
    structureSyncTargetsKey,
    toriiClient,
    toriiComponents,
  ]);

  useEffect(() => {
    const subscribe = async () => {
      // Cancel previous subscription
      if (subscriptionRef.current) {
        subscriptionRef.current.cancel();
        subscriptionRef.current = null;
      }

      if (!accountAddress || !toriiClient) return;

      const structureClauses = structureEntityIds.map((id) => ({
        Keys: {
          keys: [id.toString()],
          pattern_matching: "VariableLen" as PatternMatching,
          models: PLAYER_STRUCTURE_MODELS,
        },
      }));

      const buildingClauses = structurePositions.map((pos) => ({
        Keys: {
          keys: [pos.col.toString(), pos.row.toString()],
          pattern_matching: "VariableLen" as PatternMatching,
          models: ["s1_eternum-Building"],
        },
      }));

      const ownerStructureClause = MemberClause("s1_eternum-Structure", "owner", "Eq", {
        type: "ContractAddress",
        value: padHexAddressTo66(accountAddress),
      }).build();

      const clause: Clause = {
        Composite: {
          operator: "Or",
          clauses: [...structureClauses, ...buildingClauses, ownerStructureClause],
        },
      };

      subscriptionRef.current = await syncEntitiesDebounced(toriiClient, setup, clause, false);
      const subscriptionSignature = `${accountAddress ?? "unknown"}:${structureSyncTargetsKey}`;
      if (lastSubscriptionSignatureRef.current !== subscriptionSignature) {
        lastSubscriptionSignatureRef.current = subscriptionSignature;
        syncDiag("subscription-ready", {
          accountAddress,
          structureClauseCount: structureClauses.length,
          buildingClauseCount: buildingClauses.length,
        });
      }
    };

    subscribe();

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.cancel();
        subscriptionRef.current = null;
      }
    };
  }, [accountAddress, structureEntityIds, structurePositions, structureSyncTargetsKey, toriiClient, setup]);
};
