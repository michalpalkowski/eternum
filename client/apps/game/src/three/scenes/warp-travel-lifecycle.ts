export interface WarpTravelLifecycleState {
  hasInitialized: boolean;
  initialSetupPromise: Promise<void> | null;
  isSwitchedOff: boolean;
}

export interface WarpTravelLifecycleAdapter {
  onSetupStart?: () => void;
  onInitialSetupStart?: () => void;
  onResumeStart?: () => void;
  moveCameraToSceneLocation: () => void;
  attachLabelGroupsToScene: () => void;
  attachManagerLabels: () => void;
  registerStoreSubscriptions: () => void;
  setupCameraZoomHandler: () => void;
  refreshScene: () => Promise<void>;
  onInitialSetupComplete?: () => void | Promise<void>;
  onResumeComplete?: () => void | Promise<void>;
  reportSetupError?: (error: unknown, phase: "initial" | "resume") => void;
  onSwitchOffStart?: () => void;
  disposeStoreSubscriptions: () => void;
  onAfterDisposeSubscriptions?: () => void;
  detachLabelGroupsFromScene: () => void;
  detachManagerLabels: () => void;
  onSwitchOffComplete?: () => void;
}

async function activateWarpTravelLifecycle(
  adapter: WarpTravelLifecycleAdapter,
  phase: "initial" | "resume",
): Promise<void> {
  console.log(`[WarpTravel] activateLifecycle START phase=${phase}`);
  adapter.moveCameraToSceneLocation();
  adapter.attachLabelGroupsToScene();
  adapter.attachManagerLabels();
  adapter.registerStoreSubscriptions();
  adapter.setupCameraZoomHandler();
  console.log(`[WarpTravel] sync setup done, calling refreshScene...`);

  try {
    await adapter.refreshScene();
    console.log(`[WarpTravel] refreshScene resolved`);
  } catch (error) {
    console.log(`[WarpTravel] refreshScene THREW:`, error);
    adapter.reportSetupError?.(error, phase);
  }

  if (phase === "initial") {
    console.log(`[WarpTravel] calling onInitialSetupComplete...`);
    await adapter.onInitialSetupComplete?.();
    console.log(`[WarpTravel] activateLifecycle DONE (initial)`);
    return;
  }

  console.log(`[WarpTravel] calling onResumeComplete...`);
  await adapter.onResumeComplete?.();
  console.log(`[WarpTravel] activateLifecycle DONE (resume)`);
}

export async function runWarpTravelSetupLifecycle(
  state: WarpTravelLifecycleState,
  adapter: WarpTravelLifecycleAdapter,
): Promise<WarpTravelLifecycleState> {
  const nextState: WarpTravelLifecycleState = {
    ...state,
    isSwitchedOff: false,
  };

  adapter.onSetupStart?.();

  if (!nextState.hasInitialized) {
    adapter.onInitialSetupStart?.();
    const reusingPromise = Boolean(nextState.initialSetupPromise);
    if (!nextState.initialSetupPromise) {
      nextState.initialSetupPromise = activateWarpTravelLifecycle(adapter, "initial");
    }
    console.log(`[WarpTravel] awaiting initialSetupPromise (reused=${reusingPromise})`);

    try {
      await nextState.initialSetupPromise;
      nextState.hasInitialized = true;
      console.log(`[WarpTravel] initialSetupPromise resolved`);
    } finally {
      nextState.initialSetupPromise = null;
    }

    return nextState;
  }

  console.log(`[WarpTravel] already initialized, running resume`);
  adapter.onResumeStart?.();
  await activateWarpTravelLifecycle(adapter, "resume");
  return nextState;
}

export function runWarpTravelSwitchOffLifecycle(
  state: WarpTravelLifecycleState,
  adapter: WarpTravelLifecycleAdapter,
): WarpTravelLifecycleState {
  const nextState: WarpTravelLifecycleState = {
    ...state,
    isSwitchedOff: true,
  };

  adapter.onSwitchOffStart?.();
  adapter.disposeStoreSubscriptions();
  adapter.onAfterDisposeSubscriptions?.();
  adapter.detachLabelGroupsFromScene();
  adapter.detachManagerLabels();
  adapter.onSwitchOffComplete?.();

  return nextState;
}
