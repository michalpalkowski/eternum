import type { AppStore } from "@/hooks/store/use-ui-store";
import { useAccountStore } from "@/hooks/store/use-account-store";
import { type SetupResult } from "@bibliothecadao/dojo";

import { fetchWorldConfigMapCenterOffset, sqlApi } from "@/services/api";
import { configManager, MAP_DATA_REFRESH_INTERVAL, MapDataStore } from "@bibliothecadao/eternum";
import { getComponentValue, Has, runQuery, type Component, Entity, Metadata, Schema } from "@dojoengine/recs";
import { getEntities, setEntities } from "@dojoengine/state";
import type { Clause, ToriiClient, Entity as ToriiEntity } from "@dojoengine/torii-wasm/types";
import {
  getAddressNamesFromTorii,
  getBankStructuresFromTorii,
  getConfigFromTorii,
  getGuildsFromTorii,
  getStructuresDataFromTorii,
} from "./queries";
import { resolveInitialStructureSelection } from "./sync-initial-selection";
import { isDeletionPayload, isDeletablePayloadForOrigin, type SyncUpdateOrigin } from "./sync-utils";
import { ToriiSyncWorkerManager } from "./sync-worker-manager";
import { buildModelKeysClause, type GlobalModelStreamConfig } from "./torii-stream-manager";
import { timedAsync, timedSync, perfEvent } from "./perf-diagnostics";

export const EVENT_QUERY_LIMIT = 40_000;
// 8s was too aggressive for remote deployments (TEE/testnet) where Torii latency
// is 100-500ms and initial subscription setup competes with query traffic.
const TORII_STREAM_SUBSCRIPTION_SETUP_TIMEOUT_MS = 30_000;

let entityStreamSubscription: { cancel: () => void } | null = null;
let entityStreamSubscriptionAttempt = 0;

/**
 * Cancel the global entity stream subscription.
 * Used during game switching to stop the old Torii client from writing
 * stale data into RECS while the new world is being bootstrapped.
 */
export const cancelEntityStreamSubscription = () => {
  entityStreamSubscriptionAttempt += 1;
  if (entityStreamSubscription) {
    entityStreamSubscription.cancel();
    entityStreamSubscription = null;
  }
};

const GLOBAL_NON_SPATIAL_MODELS: string[] = [
  // Events
  "s1_eternum-OpenRelicChestEvent",
  // Guilds
  "s1_eternum-Guild",
  "s1_eternum-GuildMember",
  "s1_eternum-GuildWhitelist",
  // Market
  "s1_eternum-Market",
  "s1_eternum-Liquidity",
  "s1_eternum-Trade",
  // Config + global metadata
  "s1_eternum-WorldConfig",
  "s1_eternum-HyperstrtConstructConfig",
  "s1_eternum-HyperstructureGlobals",
  "s1_eternum-WeightConfig",
  "s1_eternum-ResourceFactoryConfig",
  "s1_eternum-BuildingCategoryConfig",
  "s1_eternum-StructureLevelConfig",
  "s1_eternum-SeasonEnded",
  "s1_eternum-QuestLevels",
  "s1_eternum-AddressName",
  "s1_eternum-PlayerRegisteredPoints",
  "s1_eternum-BlitzRealmPlayerRegister",
  "s1_eternum-BlitzRealmSettleFinish",
  "s1_eternum-PlayersRankTrial",
  "s1_eternum-PlayersRankFinal",
  "s1_eternum-ResourceList",
  "s1_eternum-PlayerRank",
  "s1_eternum-RankPrize",
];

// Models synced per-player via a scoped subscription (see usePlayerStructureSync)
const PLAYER_STRUCTURE_MODELS: string[] = [
  "s1_eternum-ProductionBoostBonus",
  "s1_eternum-Resource",
  "s1_eternum-ResourceArrival",
];

const GLOBAL_STREAM_MODELS: GlobalModelStreamConfig[] = GLOBAL_NON_SPATIAL_MODELS.map((model) => ({ model }));
const GLOBAL_STREAM_CLAUSE = buildModelKeysClause(GLOBAL_STREAM_MODELS);

const MAP_CENTER_FELT = 2_147_483_646;
const SPATIAL_BOOTSTRAP_HYDRATION_BATCH_SIZE = 16;
const REQUIRED_BOOTSTRAP_CONFIG_MODELS = [
  "BuildingCategoryConfig",
  "ResourceFactoryConfig",
  "ResourceList",
  "StructureLevelConfig",
] as const;

const applyMapCenterOffset = (mapCenterOffset: number): void => {
  const manager = configManager as any;
  const expectedMapCenter = MAP_CENTER_FELT - Number(mapCenterOffset ?? 0);
  let method = "none";

  if (typeof manager.setMapCenterFromOffset === "function") {
    manager.setMapCenterFromOffset(mapCenterOffset);
    method = "setMapCenterFromOffset";
  } else if (typeof manager.setMapCenter === "function") {
    manager.setMapCenter(expectedMapCenter);
    method = "setMapCenter";
  } else if (manager && typeof manager === "object") {
    // Some workspace/package-link combinations can expose an older runtime shape
    // without setter methods. Write the canonical value directly as last resort.
    (manager as { mapCenter?: number }).mapCenter = expectedMapCenter;
    method = "direct_mapCenter_field";
  }

  let appliedMapCenter = Number(manager.getMapCenter?.());
  let forcedFallback = false;
  if (
    Number.isFinite(appliedMapCenter) &&
    appliedMapCenter !== expectedMapCenter &&
    typeof manager.setMapCenter === "function"
  ) {
    manager.setMapCenter(expectedMapCenter);
    appliedMapCenter = Number(manager.getMapCenter?.());
    forcedFallback = true;
  }

  console.log("[sync] Applied map center from offset", {
    mapCenterOffset,
    expectedMapCenter,
    appliedMapCenter,
    method,
    forcedFallback,
  });
};

type BatchPayload = { upserts: ToriiEntity[]; deletions: string[] };

interface QueueProcessor {
  queueUpdate: (entityId: string, data: ToriiEntity, origin?: "entity" | "event") => void;
  dispose: () => void;
}

const createMainThreadQueueProcessor = (
  applyBatch: (batch: BatchPayload) => void,
  logging: boolean,
): QueueProcessor => {
  const updateQueue: Array<{ entityId: string; data: ToriiEntity; origin: SyncUpdateOrigin }> = [];
  let isProcessing = false;
  let pendingTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const mergeDeep = (target: ToriiEntity, source: ToriiEntity): ToriiEntity => {
    if (!source) return target;
    const output = { ...target } as ToriiEntity;
    const mutableOutput = output as unknown as Record<string, unknown>;
    const sourceRecord = source as unknown as Record<string, unknown>;

    Object.keys(sourceRecord).forEach((key) => {
      const sourceValue = sourceRecord[key];
      const targetValue = mutableOutput[key];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        mutableOutput[key] = mergeDeep(targetValue as ToriiEntity, sourceValue as ToriiEntity);
      } else {
        mutableOutput[key] = sourceValue;
      }
    });

    return output;
  };

  const processNextInQueue = async () => {
    if (updateQueue.length === 0 || isProcessing) return;

    isProcessing = true;
    const batchSize = 10;
    const batchRecord: Record<string, ToriiEntity> = {};

    const itemsToProcess = updateQueue.splice(0, batchSize);
    if (logging) console.log(`Processing batch of ${itemsToProcess.length} updates`);

    itemsToProcess.forEach(({ entityId, data, origin }) => {
      const isDeletionLikePayload = isDeletionPayload(data);
      if (origin === "event" && isDeletionLikePayload) {
        // Event stream payloads can arrive as metadata-only updates with empty models.
        // Treating those as deletions causes authoritative entities to disappear.
        if (logging) {
          console.warn("[sync] Ignoring deletion-like event payload", { entityId });
        }
        return;
      }

      const isEntityDelete = isDeletablePayloadForOrigin(data, origin);
      if (isEntityDelete) {
        batchRecord[entityId] = data;
        return;
      }

      if (batchRecord[entityId]) {
        const entityHasBeenDeleted = isDeletionPayload(batchRecord[entityId]);
        if (entityHasBeenDeleted) return;
        batchRecord[entityId] = mergeDeep(batchRecord[entityId], data);
      } else {
        batchRecord[entityId] = data;
      }
    });

    const entityIds = Object.keys(batchRecord);
    if (entityIds.length > 0) {
      try {
        if (logging) console.log("Applying batch update", batchRecord);
        const deletions = entityIds.filter((id) => isDeletionPayload(batchRecord[id]));
        const upserts = entityIds.filter((id) => !isDeletionPayload(batchRecord[id])).map((id) => batchRecord[id]);

        applyBatch({ upserts, deletions });
      } catch (error) {
        console.error("Error processing entity batch:", error);
      }
    }

    isProcessing = false;
    if (updateQueue.length > 0) {
      pendingTimeoutId = setTimeout(processNextInQueue, 0);
    }
  };

  return {
    queueUpdate: (entityId: string, data: ToriiEntity, origin: SyncUpdateOrigin = "entity") => {
      updateQueue.push({ entityId, data, origin });
      if (!isProcessing) {
        pendingTimeoutId = setTimeout(processNextInQueue, 200);
      }
    },
    dispose: () => {
      if (pendingTimeoutId !== null) {
        clearTimeout(pendingTimeoutId);
        pendingTimeoutId = null;
      }
      updateQueue.length = 0;
    },
  };
};

const createWorkerQueueProcessor = (
  applyBatch: (batch: BatchPayload) => void,
  logging: boolean,
): QueueProcessor | null => {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }

  try {
    const manager = new ToriiSyncWorkerManager({
      logging,
      onBatch: (batch) => {
        applyBatch({ upserts: batch.upserts, deletions: batch.deletions });
      },
      onError: (message, error) => {
        console.error("[sync-worker] error", message, error);
      },
    });

    if (!manager.isAvailable) {
      manager.dispose();
      return null;
    }

    return {
      queueUpdate: (_entityId: string, data: ToriiEntity, origin?: "entity" | "event") => {
        manager.enqueue(data, origin ?? "entity");
      },
      dispose: () => manager.dispose(),
    };
  } catch (error) {
    console.error("[sync-worker] failed to initialize", error);
    return null;
  }
};

const withSetupTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.finally(() => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`[sync] ${label} setup timed out after ${TORII_STREAM_SUBSCRIPTION_SETUP_TIMEOUT_MS}ms`));
        }, TORII_STREAM_SUBSCRIPTION_SETUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
};

export const syncEntitiesDebounced = async (
  client: ToriiClient,
  setupResult: SetupResult,
  entityKeyClause: Clause | undefined | null,
  logging = true,
) => {
  if (logging) console.log("Starting syncEntities");

  const {
    network: { world },
  } = setupResult;

  const applyBatch = ({ upserts, deletions }: BatchPayload) => {
    timedSync(`applyBatch(del=${deletions.length},ups=${upserts.length})`, () => {
      if (deletions.length > 0) {
        deletions.forEach((entityId) => {
          world.deleteEntity(entityId as Entity);
        });
      }

      if (upserts.length > 0) {
        const modelsArray = upserts.map((value) => {
          return { hashed_keys: value.hashed_keys, models: value.models };
        });
        setEntities(modelsArray, world.components, logging);
      }
    });
  };

  const queueProcessor =
    createWorkerQueueProcessor(applyBatch, logging) ?? createMainThreadQueueProcessor(applyBatch, logging);

  const queueUpdate = (data: ToriiEntity, origin: "entity" | "event") => {
    try {
      queueProcessor.queueUpdate(data.hashed_keys, data, origin);
    } catch (error) {
      console.error("Error queuing entity update:", error);
    }
  };

  const entitySubPromise = timedAsync("subscription:onEntityUpdated", () =>
    client.onEntityUpdated(entityKeyClause, (data: ToriiEntity) => {
      perfEvent("callback:entityUpdated", { keys: data.hashed_keys });
      if (logging) console.log("Entity updated", data);
      queueUpdate(data, "entity");
    }),
  );

  const eventSubPromise = timedAsync("subscription:onEventMessageUpdated", () =>
    client.onEventMessageUpdated(entityKeyClause, (data: ToriiEntity) => {
      perfEvent("callback:eventMessageUpdated", { keys: data.hashed_keys });
      if (logging) console.log("Event message updated", data.hashed_keys);
      queueUpdate(data, "event");
    }),
  );

  // Main entity stream is critical for correctness; do not fail-fast here.
  // It can legitimately take longer on local shards under load.
  const entitySub = await entitySubPromise;

  let eventSub: { cancel: () => void } | null = null;
  let canceled = false;
  void withSetupTimeout(eventSubPromise, "onEventMessageUpdated")
    .then((subscription) => {
      if (canceled) {
        subscription.cancel();
        return;
      }
      eventSub = subscription;
    })
    .catch((error) => {
      console.warn("[sync] Event message stream unavailable, continuing with entity stream only", error);
    });

  return {
    cancel: () => {
      canceled = true;
      entitySub.cancel();
      eventSub?.cancel();
      queueProcessor.dispose();
    },
  };
};

const startGlobalEntityStreamSubscription = (setup: SetupResult, logging: boolean): void => {
  const attempt = entityStreamSubscriptionAttempt;
  void syncEntitiesDebounced(setup.network.toriiClient, setup, GLOBAL_STREAM_CLAUSE, logging)
    .then((subscription) => {
      if (attempt !== entityStreamSubscriptionAttempt) {
        subscription.cancel();
        return;
      }
      entityStreamSubscription = subscription;
      console.log("[sync] Global entity stream subscription ready");
    })
    .catch((error) => {
      console.error("[sync] Failed to subscribe global entity stream", error);
    });
};

const ensureWorldConfigReady = async (
  setup: SetupResult,
  contractComponents: Component<Schema, Metadata, undefined>[],
): Promise<number> => {
  const worldConfigComponent = (setup.network.contractComponents as any).WorldConfig;
  if (!worldConfigComponent) {
    throw new Error("[sync] Protocol violation: WorldConfig component missing in contractComponents");
  }

  await getEntities(
    setup.network.toriiClient,
    {
      Keys: {
        keys: [undefined],
        pattern_matching: "FixedLen",
        models: ["s1_eternum-WorldConfig"],
      },
    },
    contractComponents as any,
    [],
    ["s1_eternum-WorldConfig"],
    EVENT_QUERY_LIMIT,
    false,
  );
  const fetchedCount = runQuery([Has(worldConfigComponent)]).size;

  const maxAttempts = 40;
  const attemptDelayMs = 100;
  let worldConfigEntities: Set<Entity> = new Set();
  let worldConfig: ReturnType<typeof getComponentValue> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    worldConfigEntities = runQuery([Has(worldConfigComponent)]);
    const worldConfigEntity = Array.from(worldConfigEntities)[0];
    worldConfig =
      worldConfigEntity !== undefined ? getComponentValue(worldConfigComponent, worldConfigEntity as Entity) : null;

    if (worldConfig) {
      break;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attemptDelayMs));
    }
  }

  if (!worldConfig) {
    let sqlMapCenterOffset: number | null = null;
    try {
      sqlMapCenterOffset = await fetchWorldConfigMapCenterOffset();
    } catch (sqlError) {
      console.warn("[sync] WorldConfig SQL fallback query failed", sqlError);
    }

    throw new Error(
      `[sync] Protocol violation (error_code=world_config_not_materialized): WorldConfig missing after bootstrap sync (attempts=${maxAttempts}, delay_ms=${attemptDelayMs}, fetched_count=${fetchedCount}, recs_entity_count=${worldConfigEntities.size}, sql_map_center_offset=${String(sqlMapCenterOffset)})`,
    );
  }

  const mapCenterOffset = Number(worldConfig.map_center_offset ?? 0);
  const startMainAt = Number(worldConfig.season_config?.start_main_at ?? 0);
  const endAt = Number(worldConfig.season_config?.end_at ?? 0);

  if (!Number.isFinite(mapCenterOffset)) {
    throw new Error(
      `[sync] Protocol violation (error_code=schema_shape_mismatch): WorldConfig.map_center_offset is not numeric (${String(worldConfig.map_center_offset)})`,
    );
  }
  if (
    !Number.isFinite(startMainAt) ||
    !Number.isFinite(endAt) ||
    startMainAt <= 0 ||
    endAt <= 0 ||
    endAt <= startMainAt
  ) {
    throw new Error(
      `[sync] Protocol violation (error_code=world_config_timer_fields_missing): invalid season timing (start_main_at=${String(worldConfig.season_config?.start_main_at)}, end_at=${String(worldConfig.season_config?.end_at)})`,
    );
  }

  applyMapCenterOffset(mapCenterOffset);
  console.log("[sync] WorldConfig ready", {
    entityCount: worldConfigEntities.size,
    mapCenterOffset,
    startMainAt,
    endAt,
  });
  return mapCenterOffset;
};

const ensureBootstrapConfigModelsReady = async (setup: SetupResult): Promise<void> => {
  const contractComponents = setup.network.contractComponents as any;
  const requiredModels: Array<{
    name: (typeof REQUIRED_BOOTSTRAP_CONFIG_MODELS)[number];
    component: Component<Schema, Metadata, undefined> | undefined;
  }> = REQUIRED_BOOTSTRAP_CONFIG_MODELS.map((name) => ({
    name,
    component: contractComponents[name],
  }));

  const missingComponents = requiredModels.filter((entry) => entry.component === undefined).map((entry) => entry.name);
  if (missingComponents.length > 0) {
    throw new Error(
      `[sync] Protocol violation (error_code=schema_shape_mismatch): missing required config components (${missingComponents.join(", ")})`,
    );
  }

  const maxAttempts = 60;
  const attemptDelayMs = 100;
  let modelCounts: Record<string, number> = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    modelCounts = Object.fromEntries(
      requiredModels.map((entry) => [entry.name, runQuery([Has(entry.component as Component<any, any, any>)]).size]),
    );

    if (Object.values(modelCounts).every((count) => count > 0)) {
      console.log("[sync] Bootstrap config models ready", { attempt, modelCounts });
      return;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attemptDelayMs));
    }
  }

  throw new Error(
    `[sync] Protocol violation (error_code=config_models_not_ready): config models missing after bootstrap sync (attempts=${maxAttempts}, delay_ms=${attemptDelayMs}, counts=${JSON.stringify(modelCounts)})`,
  );
};

const hydrateSpatialStructuresFromSqlSnapshot = async (
  setup: SetupResult,
  contractComponents: Component<Schema, Metadata, undefined>[],
  currentRecsStructureCount: number,
) => {
  let structures: Array<{ entity_id: number; coord_x: number; coord_y: number }> = [];
  try {
    structures = await sqlApi.fetchAllStructuresMapData();
  } catch (error) {
    console.error("[sync] Failed to fetch SQL structure snapshot for spatial hydration", error);
    return { sqlStructureCount: 0, hydratedCount: 0 };
  }

  const structuresToHydrate = structures
    .filter(
      (structure) =>
        Number.isFinite(structure.entity_id) &&
        Number.isFinite(structure.coord_x) &&
        Number.isFinite(structure.coord_y),
    )
    .map((structure) => ({
      entityId: structure.entity_id,
      position: { col: structure.coord_x, row: structure.coord_y },
    }));

  if (currentRecsStructureCount >= structuresToHydrate.length) {
    return {
      sqlStructureCount: structuresToHydrate.length,
      hydratedCount: 0,
      skipped: true,
    };
  }

  for (let i = 0; i < structuresToHydrate.length; i += SPATIAL_BOOTSTRAP_HYDRATION_BATCH_SIZE) {
    const batch = structuresToHydrate.slice(i, i + SPATIAL_BOOTSTRAP_HYDRATION_BATCH_SIZE);
    await getStructuresDataFromTorii(setup.network.toriiClient, contractComponents, batch);
    // Yield to the browser between batches so the UI thread can paint and handle input.
    if (i + SPATIAL_BOOTSTRAP_HYDRATION_BATCH_SIZE < structuresToHydrate.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    sqlStructureCount: structuresToHydrate.length,
    hydratedCount: structuresToHydrate.length,
    skipped: false,
  };
};

// initial sync runs before the game is playable and should sync minimal data
type InitialSyncOptions = {
  logging?: boolean;
  reportProgress?: boolean;
  enforceProtocolChecks?: boolean;
};

export const initialSync = async (
  setup: SetupResult,
  state: AppStore,
  setInitialSyncProgress: (progress: number) => void,
  options: InitialSyncOptions = {},
) => {
  const { logging = false, reportProgress = true, enforceProtocolChecks = false } = options;
  console.log("[STARTING syncEntitiesDebounced]");
  entityStreamSubscriptionAttempt += 1;
  if (entityStreamSubscription) {
    entityStreamSubscription.cancel();
    entityStreamSubscription = null;
  }

  if (reportProgress) {
    setInitialSyncProgress(0);
  }

  startGlobalEntityStreamSubscription(setup, logging);

  const contractComponents = setup.network.contractComponents as unknown as Component<Schema, Metadata, undefined>[];

  let highestProgress = reportProgress ? 0 : -1;
  const updateProgress = (value: number) => {
    if (!reportProgress) {
      return;
    }
    if (value <= highestProgress) {
      return;
    }
    highestProgress = value;
    setInitialSyncProgress(value);
  };

  const runTimedTask = async (label: string, targetProgress: number, task: () => Promise<void>) => {
    const start = performance.now();
    await task();
    const end = performance.now();
    console.log(`[sync] ${label}`, end - start);
    updateProgress(targetProgress);
  };

  const parallelTasks: Promise<void>[] = [];

  perfEvent("initialSync:start");

  // BANKS (kicked off immediately so the request overlaps with other sync work)
  parallelTasks.push(
    runTimedTask("bank structures query", 10, async () => {
      await timedAsync("initialSync:bankStructures", () =>
        getBankStructuresFromTorii(setup.network.toriiClient, contractComponents),
      );
    }),
  );

  // Initial structure selection:
  // 1) connected players: first owned realm (fallback: first owned structure)
  // 2) spectators / no owned structures: first global structure
  const currentStructureEntityId = state.structureEntityId;
  if (!currentStructureEntityId || currentStructureEntityId === 0) {
    const accountAddress = useAccountStore.getState().account?.address;
    const hasConnectedAccount =
      typeof accountAddress === "string" && accountAddress.length > 0 && accountAddress !== "0x0";

    let ownedStructures: Array<{ entity_id: number; coord_x: number; coord_y: number; category?: number | string }> =
      [];

    if (hasConnectedAccount) {
      try {
        ownedStructures = await sqlApi.fetchPlayerStructures(accountAddress);
      } catch (error) {
        console.error("[sync] Failed to fetch player-owned structures for initial selection", error);
      }
    }

    let firstGlobalStructure = null;
    try {
      firstGlobalStructure = await sqlApi.fetchFirstStructure();
    } catch (error) {
      console.error("[sync] Failed to fetch first global structure for initial selection", error);
    }
    const { selectedStructure, spectator: selectAsSpectator } = resolveInitialStructureSelection({
      ownedStructures,
      firstGlobalStructure,
    });

    if (selectedStructure) {
      const start = performance.now();
      state.setStructureEntityId(selectedStructure.entity_id, {
        spectator: selectAsSpectator,
        worldMapPosition: { col: selectedStructure.coord_x, row: selectedStructure.coord_y },
      });
      await getStructuresDataFromTorii(setup.network.toriiClient, contractComponents, [
        {
          entityId: selectedStructure.entity_id,
          position: { col: selectedStructure.coord_x, row: selectedStructure.coord_y },
        },
      ]);
      const end = performance.now();
      console.log("[sync] initial structure query", end - start);
      updateProgress(25);
    }
  } else {
    updateProgress(25);
  }

  await timedAsync("initialSync:getConfig", () =>
    getConfigFromTorii(setup.network.toriiClient, setup.network.contractComponents as any),
  );
  // Yield between heavy sync steps so the browser can paint and stay responsive.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let worldConfigMapCenterOffset: number | null = null;
  try {
    worldConfigMapCenterOffset = await timedAsync("initialSync:ensureWorldConfig", () =>
      ensureWorldConfigReady(setup, contractComponents),
    );
  } catch (error) {
    if (enforceProtocolChecks) {
      throw error;
    }
    console.warn("[sync] Non-fatal protocol check failed on main world", error);
  }

  try {
    await timedAsync("initialSync:ensureBootstrapConfig", () => ensureBootstrapConfigModelsReady(setup));
  } catch (error) {
    if (enforceProtocolChecks) {
      throw error;
    }
    console.warn("[sync] Non-fatal protocol check failed for config model readiness", error);
  }

  updateProgress(50);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await timedAsync("initialSync:addressNames", () =>
    getAddressNamesFromTorii(setup.network.toriiClient, setup.network.contractComponents as any),
  );
  updateProgress(75);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await timedAsync("initialSync:guilds", () =>
    getGuildsFromTorii(setup.network.toriiClient, setup.network.contractComponents as any),
  );
  updateProgress(90);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const structureComponent = (setup.network.contractComponents as any).Structure;
  if (structureComponent) {
    const structureEntityCountBeforeSpatialHydration = runQuery([Has(structureComponent)]).size;
    const hydrationResult = await timedAsync("initialSync:spatialHydration", () =>
      hydrateSpatialStructuresFromSqlSnapshot(setup, contractComponents, structureEntityCountBeforeSpatialHydration),
    );
    const structureEntityCountAfterSpatialHydration = runQuery([Has(structureComponent)]).size;

    if (hydrationResult.sqlStructureCount > 0 && structureEntityCountAfterSpatialHydration === 0) {
      const protocolError = new Error(
        `[sync] Protocol violation: spatial structure snapshot missing after bootstrap (sql_structures=${hydrationResult.sqlStructureCount})`,
      );
      if (enforceProtocolChecks) {
        throw protocolError;
      }
      console.warn(protocolError);
    } else {
      console.log("[sync] Spatial structure snapshot state", {
        sqlStructureCount: hydrationResult.sqlStructureCount,
        recsStructureCountBefore: structureEntityCountBeforeSpatialHydration,
        recsStructureCountAfter: structureEntityCountAfterSpatialHydration,
        hydratedCount: hydrationResult.hydratedCount,
        skipped: hydrationResult.skipped,
      });
    }
  }

  await timedAsync("initialSync:mapDataRefresh", () =>
    MapDataStore.getInstance(MAP_DATA_REFRESH_INTERVAL, sqlApi).refresh(),
  );

  perfEvent("initialSync:complete");
  updateProgress(100);

  return { worldConfigMapCenterOffset };
};

const resubscribeEntityStream = async (
  setup: SetupResult,
  state: AppStore,
  setInitialSyncProgress: (progress: number) => void,
  logging = false,
) => {
  await initialSync(setup, state, setInitialSyncProgress, {
    logging,
    reportProgress: false,
  });
};
