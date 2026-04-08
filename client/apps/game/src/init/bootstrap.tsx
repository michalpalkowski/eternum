import { captureSystemError } from "@/posthog";
import { setup } from "@bibliothecadao/dojo";
import { configManager, MapDataStore } from "@bibliothecadao/eternum";
import { world } from "@bibliothecadao/types";
import { inject } from "@vercel/analytics";
import { ReactNode } from "react";

import { useShardStore } from "@/hooks/store/use-shard-store";
import {
  ensureActiveWorldProfileWithUI,
  getActiveWorld,
  isRpcUrlCompatibleForChain,
  normalizeRpcUrl,
  patchManifestWithFactory,
  resolveChain,
  type WorldProfile,
} from "@/runtime/world";
import { buildWorldProfile } from "@/runtime/world/profile-builder";
import { setSqlApiBaseUrl } from "@/services/api";
import { parseShardUrlParams } from "@/sharding/protocol";
import { resolveMainGameReturnUrl, resolveRuntimeContext } from "@/sharding/runtime-context";
import { Chain, getGameManifest } from "@contracts";
import { dojoConfig } from "../../dojo-config";
import { env, hasPublicNodeUrl } from "../../env";
import { clearSubscriptionQueue } from "../dojo/debounced-queries";
import { cancelEntityStreamSubscription, initialSync } from "../dojo/sync";
import { usePlayerStore } from "../hooks/store/use-player-store";
import useSettlementStore from "../hooks/store/use-settlement-store";
import { useSyncStore } from "../hooks/store/use-sync-store";
import { useTransactionStore } from "../hooks/store/use-transaction-store";
import { useUIStore } from "../hooks/store/use-ui-store";
import { markGameEntryMilestone, recordGameEntryDuration } from "../ui/layouts/game-entry-timeline";
import { NoAccountModal } from "../ui/layouts/no-account-modal";
import { ETERNUM_CONFIG } from "../utils/config";
import { createBootstrapSession, type BootstrapSelection } from "./bootstrap-session";
import { initializeGameRenderer } from "./game-renderer";
import { resolveProfileForShardSession } from "./shard-world-profile";

export type SetupResult = Awaited<ReturnType<typeof setup>>;

type BootstrapResult = SetupResult;
const bootstrapSession = createBootstrapSession<BootstrapResult>();

type MutableDojoConfig = typeof dojoConfig & {
  toriiUrl?: string;
  rpcUrl?: string;
  manifest?: unknown;
};

/**
 * Get the cached setup result if bootstrap has already completed.
 * Returns null if bootstrap hasn't run or is still in progress.
 */
export const getCachedSetupResult = (): BootstrapResult | null => {
  return bootstrapSession.getCachedResult();
};

const deriveWorldFromPath = (): string | null => {
  try {
    const match = window.location.pathname.match(/^\/play\/([^/]+)(?:\/|$)/);
    if (!match || !match[1]) return null;
    const candidate = decodeURIComponent(match[1]);
    // "map" and "hex" are view modes, not world names
    if (candidate === "map" || candidate === "hex") return null;
    return candidate;
  } catch {
    return null;
  }
};

const isSpectateModeFromUrl = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("spectate") === "true";
};

const shouldBypassNoAccountModal = (): boolean => {
  const isSpectatingInStore = useUIStore.getState().isSpectating;
  return isSpectateModeFromUrl() || isSpectatingInStore;
};

const handleNoAccount = (modalContent: ReactNode) => {
  if (shouldBypassNoAccountModal()) {
    console.log("[bootstrap] Skipping account modal - spectate mode");
    return;
  }

  const uiStore = useUIStore.getState();
  uiStore.setModal(null, false);
  uiStore.setModal(modalContent, true);
};

const runBootstrap = async (): Promise<BootstrapResult> => {
  console.log("[STARTING DOJO SETUP]");
  const stores = resolveBootstrapStores();
  const worldContext = await resolveBootstrapWorldContext();
  const shardParams = await initializeShardContext(worldContext.chain, worldContext.profile);
  configureDojoRuntime(worldContext, shardParams);
  const setupResult = await runDojoSetup();
  await runInitialWorldSync(setupResult, stores, shardParams, worldContext.chain);
  configureGameSystems(setupResult, worldContext.chain);
  await startGameRenderer(setupResult);
  inject();
  return setupResult;
};
export const resetBootstrap = () => {
  console.log("[BOOTSTRAP] Resetting bootstrap state");
  cancelActiveBootstrapSubscriptions();
  bootstrapSession.reset();
  clearBootstrapWorldData();
  resetBootstrapUiState();
};

export const bootstrapGame = async (): Promise<BootstrapResult> => {
  const selection = resolveBootstrapSelection();
  resetBootstrapForSelectionChange(selection);
  try {
    return await bootstrapSession.run(selection, runBootstrap);
  } catch (error) {
    bootstrapSession.clearFailure();
    captureSystemError(error, {
      error_type: "dojo_setup",
      setup_phase: "bootstrap",
      context: "Unhandled error during Dojo bootstrap",
    });
    throw error;
  }
};

type BootstrapStores = {
  syncingStore: ReturnType<typeof useSyncStore.getState>;
  uiStore: ReturnType<typeof useUIStore.getState>;
};

type BootstrapWorldContext = {
  chain: Chain;
  profile: WorldProfile;
  toriiUrl: string;
};

const resolveBootstrapStores = (): BootstrapStores => ({
  syncingStore: useSyncStore.getState(),
  uiStore: useUIStore.getState(),
});

const resolveBootstrapSelection = (): BootstrapSelection => {
  const currentWorld = getActiveWorld();
  return {
    chain: currentWorld?.chain ?? null,
    worldName: currentWorld?.name ?? null,
  };
};

const resetBootstrapForSelectionChange = (selection: BootstrapSelection) => {
  const resetReason = bootstrapSession.getResetReason(selection);
  if (!resetReason) {
    return;
  }

  const previousSelection = bootstrapSession.getTrackedSelection();

  if (resetReason === "chain-changed") {
    console.log(
      `[BOOTSTRAP] Chain changed from "${previousSelection.chain}" to "${selection.chain}", resetting and re-bootstrapping...`,
    );
  } else {
    console.log(
      `[BOOTSTRAP] World changed from "${previousSelection.worldName}" to "${selection.worldName}", re-bootstrapping...`,
    );
  }

  resetBootstrap();
};

const resolveBootstrapWorldContext = async (): Promise<BootstrapWorldContext> => {
  const chain = resolveChain(env.VITE_PUBLIC_CHAIN! as Chain);
  const profile = await resolveBootstrapWorldProfile(chain);

  return {
    chain,
    profile,
    toriiUrl: resolveBootstrapToriiUrl(chain, profile),
  };
};

const resolveBootstrapWorldProfile = async (chain: Chain): Promise<WorldProfile> => {
  const profileFromPath = await resolveWorldProfileFromPath(chain);
  const activeProfile = profileFromPath ?? getActiveWorld();
  const refreshedProfile = await refreshWorldProfileIfNeeded(chain, activeProfile);

  let profile = refreshedProfile ?? (await ensureActiveWorldProfileWithUI(chain));

  // If entering a shard session, resolve the shard-specific profile.
  const shardSession = parseShardUrlParams(window.location.search);
  if (shardSession !== null) {
    profile = await resolveProfileForShardSession({
      chain,
      profile,
      shardId: shardSession.shardId,
    });
  }

  return profile;
};

const resolveWorldProfileFromPath = async (chain: Chain): Promise<WorldProfile | null> => {
  const pathWorld = deriveWorldFromPath();
  if (!pathWorld) {
    return null;
  }

  try {
    return await buildWorldProfile(chain, pathWorld);
  } catch (error) {
    console.error("[bootstrap] Failed to apply world from URL", error);
    return null;
  }
};

const refreshWorldProfileIfNeeded = async (
  chain: Chain,
  profile: WorldProfile | null,
): Promise<WorldProfile | null> => {
  if (!profile || !shouldRefreshWorldProfile(chain, profile)) {
    return profile;
  }

  try {
    const refreshedProfile = await buildWorldProfile(chain, profile.name);
    if (didWorldProfileRefreshChange(profile, refreshedProfile)) {
      console.log("[bootstrap] World profile refreshed, continuing bootstrap without page reload");
    }
    return refreshedProfile;
  } catch (error) {
    console.error("[bootstrap] Failed to refresh world profile rpcUrl", error);
    return profile;
  }
};

const shouldRefreshWorldProfile = (chain: Chain, candidate: WorldProfile): boolean => {
  if (candidate.chain && candidate.chain !== chain) {
    return true;
  }

  if (!candidate.rpcUrl) {
    return true;
  }

  const canUseEnvRpc = hasPublicNodeUrl && isRpcUrlCompatibleForChain(chain, env.VITE_PUBLIC_NODE_URL);
  if (canUseEnvRpc) {
    const normalizedProfileRpc = normalizeRpcUrl(candidate.rpcUrl);
    const normalizedEnvRpc = normalizeRpcUrl(env.VITE_PUBLIC_NODE_URL);

    if (normalizedProfileRpc !== normalizedEnvRpc && normalizedProfileRpc.includes(`/x/${candidate.name}/katana`)) {
      return true;
    }

    return false;
  }

  if (chain === "slot" || chain === "slottest") {
    return !candidate.rpcUrl.includes(`/x/${candidate.name}/katana`);
  }

  if (chain === "mainnet" || chain === "sepolia") {
    return candidate.rpcUrl.includes("/katana") || !candidate.rpcUrl.includes(`/x/starknet/${chain}`);
  }

  return false;
};

const didWorldProfileRefreshChange = (previousProfile: WorldProfile, refreshedProfile: WorldProfile): boolean => {
  return (
    !previousProfile.rpcUrl ||
    refreshedProfile.rpcUrl !== previousProfile.rpcUrl ||
    (previousProfile.chain !== undefined && refreshedProfile.chain !== previousProfile.chain)
  );
};

const resolveShardSession = () => {
  return parseShardUrlParams(window.location.search);
};

const initializeShardContext = async (chain: Chain, profile: WorldProfile): Promise<ShardSessionParams | null> => {
  const shardSession = resolveShardSession();
  const shardStore = useShardStore.getState();
  const runtimeContext = resolveRuntimeContext(window.location.href, shardSession);
  shardStore.setRuntimeContext(runtimeContext);

  if (runtimeContext.kind !== "shard") {
    shardStore.clearShardMode();
    return null;
  }

  const shardSessionParams = {
    ...runtimeContext.shard,
    mainUrl: resolveMainGameReturnUrl(runtimeContext),
  };

  // Check for stale sessions (shard no longer exists → 404).
  try {
    const shardParts = shardSessionParams.shardId.split("@");
    const staleCheckUrl = `${shardSessionParams.operatorUrl}/shard/${shardParts[0]}/${shardParts[1]}`;
    const staleCheckResponse = await fetch(staleCheckUrl).catch(() => null);
    if (staleCheckResponse?.status === 404) {
      const mainGameReturnUrl = resolveMainGameReturnUrl(runtimeContext);
      shardStore.clearShardMode();
      window.location.assign(mainGameReturnUrl);
      throw new Error("[bootstrap] stale shard session detected; redirecting to main game view: " + mainGameReturnUrl);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("stale shard session")) {
      throw error;
    }
    console.warn("[bootstrap] stale shard check failed, proceeding:", error);
  }

  shardStore.enterShardMode(shardSessionParams, runtimeContext);
  return shardSessionParams;
};

type ShardSessionParams = {
  shardId: string;
  operatorUrl: string;
  rpcUrl: string;
  toriiUrl: string;
  mainUrl: string;
};

const configureDojoRuntime = (
  { chain, profile, toriiUrl }: BootstrapWorldContext,
  shardParams?: ShardSessionParams | null,
) => {
  const mutableDojoConfig = dojoConfig as MutableDojoConfig;

  mutableDojoConfig.toriiUrl = toriiUrl;
  mutableDojoConfig.rpcUrl = resolveBootstrapRpcUrl(chain, profile);
  mutableDojoConfig.manifest = patchManifestWithFactory(
    getGameManifest(chain),
    profile.worldAddress,
    profile.contractsBySelector,
  );

  // Shard mode override: use shard-specific transport URLs.
  if (shardParams) {
    mutableDojoConfig.rpcUrl = normalizeRpcUrl(shardParams.rpcUrl);
    mutableDojoConfig.toriiUrl = shardParams.toriiUrl;
  }

  const effectiveToriiUrl = shardParams ? shardParams.toriiUrl : toriiUrl;
  setSqlApiBaseUrl(`${effectiveToriiUrl}/sql`);
};

const resolveBootstrapToriiUrl = (chain: Chain, profile: WorldProfile): string => {
  return chain === "local" ? env.VITE_PUBLIC_TORII : profile.toriiBaseUrl;
};

const resolveBootstrapRpcUrl = (chain: Chain, profile: WorldProfile): string => {
  if (chain === "local") {
    return env.VITE_PUBLIC_NODE_URL;
  }

  return profile.rpcUrl ?? env.VITE_PUBLIC_NODE_URL;
};

const runDojoSetup = async (): Promise<BootstrapResult> => {
  markGameEntryMilestone("setup-started");
  const setupResult = await setup(
    { ...dojoConfig },
    {
      vrfProviderAddress: env.VITE_PUBLIC_VRF_PROVIDER_ADDRESS,
      useBurner: false,
    },
    {
      onNoAccount: () => {
        handleNoAccount(<NoAccountModal />);
      },
      onError: (error: unknown) => {
        console.error("System call error:", error);

        captureSystemError(error, {
          error_type: "dojo_system_call",
          setup_phase: "post-setup",
          context: "System call error during post-setup phase",
        });
      },
    },
  );
  console.log("[DOJO SETUP COMPLETED]");
  markGameEntryMilestone("setup-completed");
  return setupResult;
};

const runInitialWorldSync = async (
  setupResult: BootstrapResult,
  stores: BootstrapStores,
  shardParams?: ShardSessionParams | null,
  chain?: Chain,
) => {
  const initialSyncStartedAt = performance.now();
  markGameEntryMilestone("initial-sync-started");
  await initialSync(setupResult, stores.uiStore, stores.syncingStore.setInitialSyncProgress, {
    // Shard and local worlds should fail fast on protocol/schema drift to avoid entering
    // a partially hydrated game state (disabled construction, zeroed timers).
    enforceProtocolChecks: shardParams !== null || chain === "local",
  });
  markGameEntryMilestone("initial-sync-completed");
  recordGameEntryDuration("initial-sync", performance.now() - initialSyncStartedAt);
  console.log("[INITIAL SYNC COMPLETED]");
};

const configureGameSystems = (setupResult: BootstrapResult, chain: Chain) => {
  configManager.setDojo(setupResult.components, ETERNUM_CONFIG({ chain, components: setupResult.components }));
};

const startGameRenderer = async (setupResult: BootstrapResult) => {
  bootstrapSession.replaceRendererCleanup(
    await initializeGameRenderer(setupResult, env.VITE_PUBLIC_GRAPHICS_DEV == true),
  );
};

const cancelActiveBootstrapSubscriptions = () => {
  cancelEntityStreamSubscription();
};

const clearBootstrapWorldData = () => {
  const entities = [...world.getEntities()];
  for (const entity of entities) {
    world.deleteEntity(entity);
  }

  // `world.components` is append-only across contract redefinition, so a re-bootstrap
  // must clear it or new writes can target orphaned component instances.
  world.components.length = 0;
  console.log(`[BOOTSTRAP] Cleared ${entities.length} entities and component registry from RECS world`);

  MapDataStore.clearIfExists();
  clearSubscriptionQueue();
  useSyncStore.getState().resetSubscriptions();
};

const resetBootstrapUiState = () => {
  const uiStore = useUIStore.getState();
  uiStore.setStructureEntityId(0, { spectator: false, worldMapPosition: undefined });
  uiStore.setSelectableArmies([]);

  usePlayerStore.getState().clearPlayerData();
  useTransactionStore.getState().clearAllTransactions();

  const settlementState = useSettlementStore.getState();
  if (settlementState.pollingIntervalId) {
    clearInterval(settlementState.pollingIntervalId);
  }
  if (settlementState.pollingTimeoutId) {
    clearTimeout(settlementState.pollingTimeoutId);
  }

  useSettlementStore.setState({
    pollingIntervalId: null,
    pollingTimeoutId: null,
    availableLocations: [],
    settledLocations: [],
    selectedLocation: null,
    selectedCoords: null,
  });
};
