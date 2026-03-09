import { Position } from "@bibliothecadao/eternum";
import { Structure } from "@bibliothecadao/types";

import { buildPlaySceneUrl } from "@/sharding/location-url";

const dispatchPopState = () => {
  const popStateEvent =
    typeof PopStateEvent === "function" ? new PopStateEvent("popstate") : new Event("popstate");
  window.dispatchEvent(popStateEvent);
};

const applyNavigationUrl = (url: string) => {
  window.history.pushState({}, "", url);
  dispatchPopState();
  window.dispatchEvent(new Event("urlChanged"));
};

/**
 * Navigate to a structure by updating the URL and dispatching a URL change event
 * This can be used from any scene (Hexception, WorldMap, etc.) to navigate to a structure
 *
 * @param structure - The structure to navigate to
 * @param scene - Optional scene to navigate to ('hex' or 'map'). Defaults to current scene.
 */
export function navigateToStructure(col: number, row: number, scene?: "hex" | "map") {
  navigateToPosition(col, row, scene);
}

/**
 * Navigate to a position by updating the URL and dispatching a URL change event
 *
 * @param col - Column coordinate
 * @param row - Row coordinate
 * @param scene - Optional scene to navigate to ('hex' or 'map'). Defaults to current scene.
 */
function navigateToPosition(col: number, row: number, scene?: "hex" | "map") {
  const position = new Position({ x: col, y: row });
  const normalized = position.getNormalized();

  // Determine which URL method to use based on scene parameter or current URL
  let navigationUrl: string;
  if (scene === "hex") {
    navigationUrl = buildPlaySceneUrl("hex", normalized.x, normalized.y);
  } else if (scene === "map") {
    navigationUrl = buildPlaySceneUrl("map", normalized.x, normalized.y);
  } else {
    // If no scene specified, stay in the current scene
    const currentPath = window.location.pathname;
    if (currentPath.includes("/hex")) {
      navigationUrl = buildPlaySceneUrl("hex", normalized.x, normalized.y);
    } else {
      navigationUrl = buildPlaySceneUrl("map", normalized.x, normalized.y);
    }
  }

  applyNavigationUrl(navigationUrl);
}

/**
 * Cycle through player structures and navigate to the next one
 *
 * @param playerStructures - Array of player structures
 * @param currentIndex - Current structure index
 * @param scene - Optional scene to navigate to ('hex' or 'map'). Defaults to current scene.
 * @returns Updated index after cycling
 */
export function selectNextStructure(
  playerStructures: Structure[],
  currentIndex: number,
  scene?: "hex" | "map",
): number {
  if (playerStructures.length === 0) return currentIndex;

  const nextIndex = (currentIndex + 1) % playerStructures.length;
  const structure = playerStructures[nextIndex];

  navigateToStructure(structure.position.x, structure.position.y, scene);

  console.log(
    `Selected structure: ${structure.ownerName}'s structure at (${structure.position.x}, ${structure.position.y})`,
  );

  return nextIndex;
}

/**
 * Toggle between map and hex views while preserving the current location
 * Changes /map?col=X&row=Y to /hex?col=X&row=Y and vice versa
 */
export function toggleMapHexView() {
  const currentUrl = new URL(window.location.href);
  const currentPath = currentUrl.pathname;

  // Get current coordinates from URL params
  const col = currentUrl.searchParams.get("col");
  const row = currentUrl.searchParams.get("row");

  if (!col || !row) {
    console.warn("No coordinates found in URL, cannot toggle view");
    return;
  }

  const parsedCol = Number(col);
  const parsedRow = Number(row);
  if (!Number.isFinite(parsedCol) || !Number.isFinite(parsedRow)) {
    console.warn("Invalid coordinates in URL, cannot toggle view");
    return;
  }

  // Determine new scene based on current path
  let nextScene: "hex" | "map";
  if (currentPath.includes("/hex")) {
    nextScene = "map";
  } else if (currentPath.includes("/map")) {
    nextScene = "hex";
  } else {
    console.warn("Current path is neither /hex nor /map, cannot toggle");
    return;
  }

  // Construct new URL with same coordinates and existing shard context
  const newUrl = buildPlaySceneUrl(nextScene, parsedCol, parsedRow);

  applyNavigationUrl(newUrl);

  console.log(`Toggled view from ${currentPath} to ${nextScene}`);
}
