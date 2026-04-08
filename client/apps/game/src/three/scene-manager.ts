import { TransitionManager } from "@/three/managers/transition-manager";
import { HexagonScene } from "@/three/scenes/hexagon-scene";
import {
  resolvePendingTransitionStart,
  resolveSceneSwitchRequest,
  resolveTransitionFinalizePlan,
} from "./scene-manager-transition-policy";
import { SceneName } from "./types";

export class SceneManager {
  private currentScene: SceneName | undefined = undefined;
  private scenes = new Map<SceneName, HexagonScene>();
  private transitionInProgress = false;
  private transitionRequestToken = 0;
  private pendingSceneName: SceneName | undefined = undefined;
  private readonly initialFailureFallbackScene = SceneName.WorldMap;
  constructor(private transitionManager: TransitionManager) {}

  getCurrentScene() {
    return this.currentScene;
  }

  getSceneByName(name: SceneName) {
    return this.scenes.get(name);
  }

  _updateCurrentScene(name: SceneName) {
    this.currentScene = name;
  }

  addScene(newScene: SceneName, scene: HexagonScene) {
    this.scenes.set(newScene, scene);
  }

  switchScene(sceneName: SceneName) {
    const scene = this.scenes.get(sceneName);
    const decision = resolveSceneSwitchRequest({
      requestedSceneName: sceneName,
      hasRequestedScene: Boolean(scene),
      transitionRequestToken: this.transitionRequestToken,
      transitionInProgress: this.transitionInProgress,
      pendingSceneName: this.pendingSceneName,
    });

    console.log(`[SceneManager] switchScene(${sceneName}) inProgress=${this.transitionInProgress} pending=${this.pendingSceneName} shouldStart=${decision.shouldStartPendingTransition} token=${decision.nextTransitionRequestToken}`);

    this.transitionRequestToken = decision.nextTransitionRequestToken;
    this.pendingSceneName = decision.nextPendingSceneName;

    if (!decision.shouldStartPendingTransition) return;
    if (this.startPendingTransition()) return;
    this.transitionManager.fadeIn();
  }

  private startPendingTransition(): boolean {
    const pendingSceneName = this.pendingSceneName;
    const pendingScene = pendingSceneName ? this.scenes.get(pendingSceneName) : undefined;
    const decision = resolvePendingTransitionStart({
      pendingSceneName,
      hasPendingScene: Boolean(pendingScene),
      transitionRequestToken: this.transitionRequestToken,
    });

    this.pendingSceneName = decision.nextPendingSceneName;
    const sceneNameToTransition = decision.sceneNameToTransition;
    const transitionToken = decision.transitionToken;
    if (!decision.shouldStartTransition) return false;
    if (!pendingScene || !sceneNameToTransition || transitionToken === undefined) {
      return false;
    }

    try {
      const previousScene = this.currentScene ? this.scenes.get(this.currentScene) : undefined;
      previousScene?.deactivateInputSurface?.();
      previousScene?.onSwitchOff(sceneNameToTransition);

      this.transitionInProgress = true;
      this.transitionManager.fadeOut(async () => {
        await this.completeTransition(sceneNameToTransition, pendingScene, transitionToken);
      });
      return true;
    } catch (error) {
      this.transitionInProgress = false;
      console.error("[SceneManager] Failed to start pending scene transition", error);
      return false;
    }
  }

  private async completeTransition(sceneName: SceneName, scene: HexagonScene, transitionToken: number) {
    const previousSceneName = this.currentScene;
    let setupSucceeded = false;
    const resolveFinalizePlan = () =>
      resolveTransitionFinalizePlan({
        transitionToken,
        latestTransitionRequestToken: this.transitionRequestToken,
        hasPendingScene: Boolean(this.pendingSceneName),
      });

    try {
      if (resolveFinalizePlan().isSuperseded) {
        console.log(`[SceneManager] completeTransition(${sceneName}) SUPERSEDED before setup`);
        return;
      }

      if (scene.setup) {
        console.log(`[SceneManager] completeTransition(${sceneName}) calling setup()...`);
        await scene.setup();
        console.log(`[SceneManager] completeTransition(${sceneName}) setup() resolved`);
      }
      if (resolveFinalizePlan().isSuperseded) {
        console.log(`[SceneManager] completeTransition(${sceneName}) SUPERSEDED after setup`);
        return;
      }

      this._updateCurrentScene(sceneName);
      scene.activateInputSurface?.();
      setupSucceeded = true;
    } catch (error) {
      console.error(`[SceneManager] Failed to set up scene ${sceneName}`, error);
      if (!previousSceneName) {
        this.queueInitialFailureFallback(sceneName);
      }
    } finally {
      const finalizePlan = resolveFinalizePlan();
      this.transitionInProgress = false;
      this.runPostSetupEffectsSafely({
        shouldRunPostSetupEffects: finalizePlan.shouldRunPostSetupEffects,
        setupSucceeded,
        hadPreviousScene: previousSceneName !== undefined,
      });

      if (finalizePlan.shouldStartPendingTransition) {
        console.log(`[SceneManager] completeTransition(${sceneName}) chaining to pending transition`);
        if (this.startPendingTransition()) {
          return;
        }
      }

      // Transition protocol invariant: every started fade-out must eventually release
      // the transition overlay once the transition chain reaches a terminal state.
      console.log(`[SceneManager] completeTransition(${sceneName}) calling fadeIn()`);
      this.transitionManager.fadeIn();
    }
  }

  private runPostSetupEffectsSafely(input: {
    shouldRunPostSetupEffects: boolean;
    setupSucceeded: boolean;
    hadPreviousScene: boolean;
  }) {
    if (!input.shouldRunPostSetupEffects) return;
    if (!input.setupSucceeded && !input.hadPreviousScene) return;

    try {
      this.moveCameraForScene();
    } catch (error) {
      console.error("[SceneManager] Failed to apply post-setup scene effects", error);
    }
  }

  private queueInitialFailureFallback(failedSceneName: SceneName): boolean {
    if (this.pendingSceneName) return false;
    if (failedSceneName === this.initialFailureFallbackScene) return false;
    if (!this.scenes.has(this.initialFailureFallbackScene)) return false;

    this.transitionRequestToken += 1;
    this.pendingSceneName = this.initialFailureFallbackScene;
    return true;
  }

  moveCameraForScene() {
    const scene = this.scenes.get(this.currentScene!);
    if (scene) {
      scene.moveCameraToURLLocation();
    }
  }
}
