import { buildSceneUrl, resolveRuntimeContextFromWindow, type PlayScene } from "./runtime-context";

export const buildPlaySceneUrl = (
  scene: PlayScene,
  col: number,
  row: number,
  options?: { spectate?: boolean },
): string => {
  return buildSceneUrl(resolveRuntimeContextFromWindow(), scene, col, row, options);
};
