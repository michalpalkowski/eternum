const PLAY_PATH_MATCHER = /^\/play(?:\/([^/?#]+))?/;

const toSafeCoordinate = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return Math.trunc(value).toString();
};

const resolvePlayBasePath = (pathname: string): string => {
  const match = pathname.match(PLAY_PATH_MATCHER);
  if (!match) {
    return "/play";
  }

  const worldSegment = match[1];
  if (!worldSegment || worldSegment === "hex" || worldSegment === "map") {
    return "/play";
  }

  return `/play/${worldSegment}`;
};

export const buildPlaySceneUrl = (
  scene: "hex" | "map",
  col: number,
  row: number,
  options?: { spectate?: boolean },
): string => {
  const currentUrl = new URL(window.location.href);
  const basePath = resolvePlayBasePath(currentUrl.pathname);
  const searchParams = new URLSearchParams(currentUrl.search);

  searchParams.set("col", toSafeCoordinate(col));
  searchParams.set("row", toSafeCoordinate(row));
  if (options?.spectate === true) searchParams.set("spectate", "true");
  if (options?.spectate === false) searchParams.delete("spectate");

  return `${basePath}/${scene}?${searchParams.toString()}`;
};
