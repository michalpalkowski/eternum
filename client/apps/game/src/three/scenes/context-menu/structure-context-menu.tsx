import { ensureStructureSynced } from "@/dojo/queries";
import { useAccountStore } from "@/hooks/store/use-account-store";
import { useUIStore } from "@/hooks/store/use-ui-store";
import { playResourceSound } from "@/three/sound/utils";
import { isAddressEqualToAccount } from "@/three/utils";
import { LeftView } from "@/types";
import { SetupResult } from "@bibliothecadao/dojo";
import { Position } from "@bibliothecadao/eternum";
import { BuildingType, HexEntityInfo, HexPosition, ResourcesIds } from "@bibliothecadao/types";
import { getComponentValue } from "@dojoengine/recs";
import { getEntityIdFromKeys } from "@dojoengine/utils";
import { SceneName } from "../../types/common";
import { navigateToStructure } from "../../utils/navigation";
import { createConstructionMenu } from "./structure-construction-menu";

type Components = SetupResult["components"];

type OpenStructureContextMenuNetwork = {
  toriiClient?: SetupResult["network"]["toriiClient"];
  contractComponents?: SetupResult["network"]["contractComponents"];
};

interface OpenStructureContextMenuParams extends OpenStructureContextMenuNetwork {
  event: MouseEvent;
  structure: HexEntityInfo;
  hexCoords: HexPosition;
  components: Components;
}

const logContextMenuDiagnostics = (event: string, details: Record<string, unknown>) => {
  if (!import.meta.env.DEV) {
    return;
  }

  console.log("[StructureContextMenu]", event, details);
};

const resolveWorldMapPosition = (hexCoords: HexPosition): { col: number; row: number } | undefined => {
  const contractPosition = new Position({ x: hexCoords.col, y: hexCoords.row }).getContract();
  const col = Number(contractPosition?.x);
  const row = Number(contractPosition?.y);

  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    return undefined;
  }

  return { col, row };
};

const hasHydratedStructure = (components: Components, structureId: bigint): boolean => {
  if (!components.Structure) {
    return false;
  }

  try {
    return Boolean(getComponentValue(components.Structure, getEntityIdFromKeys([structureId])));
  } catch {
    return false;
  }
};

const hydrateOwnedStructureIfNeeded = async ({
  structure,
  hexCoords,
  components,
  toriiClient,
  contractComponents,
  isOwner,
}: OpenStructureContextMenuParams & { isOwner: boolean }): Promise<void> => {
  if (!isOwner || !toriiClient || !contractComponents) {
    return;
  }

  const worldMapPosition = resolveWorldMapPosition(hexCoords);
  if (!worldMapPosition) {
    return;
  }

  const accountAddress = useAccountStore.getState().account?.address;

  await ensureStructureSynced(
    components,
    toriiClient,
    contractComponents as any,
    Number(structure.id),
    worldMapPosition,
    accountAddress,
  );
};

const openStructureContextMenuInternal = async (params: OpenStructureContextMenuParams): Promise<void> => {
  const { event, structure, hexCoords, components } = params;
  const uiStore = useUIStore.getState();
  const idString = structure.id.toString();
  const isOwner = isAddressEqualToAccount(structure.owner);
  logContextMenuDiagnostics("open", {
    structureId: idString,
    owner: String(structure.owner),
    isOwner,
    hexCoords,
  });

  try {
    await hydrateOwnedStructureIfNeeded({ ...params, isOwner });
  } catch (error) {
    console.error("[StructureContextMenu] Failed to hydrate structure before opening context menu", {
      error,
      structureId: structure.id,
      position: hexCoords,
    });
  }

  const openArmyCreationModal = (isExplorer: boolean) => {
    if (!isOwner) {
      return;
    }
    uiStore.setStructureEntityId(structure.id, { spectator: false });
    uiStore.openArmyCreationPopup({
      structureId: Number(structure.id),
      isExplorer,
    });
  };

  const selectConstructionBuilding = (building: BuildingType, view: LeftView, resource?: ResourcesIds) => {
    const worldMapPosition = resolveWorldMapPosition(hexCoords);

    if (!isOwner) {
      console.warn("[StructureContextMenu] Construction requested on non-owned structure", {
        structureId: idString,
        owner: String(structure.owner),
        worldMapPosition,
        building,
        resource: resource ?? null,
      });
      uiStore.setStructureEntityId(structure.id, {
        spectator: true,
        worldMapPosition,
      });
      navigateToStructure(hexCoords.col, hexCoords.row, "hex");
      return;
    }

    const structureId = BigInt(structure.id);
    if (!hasHydratedStructure(components, structureId)) {
      console.warn("[StructureContextMenu] Skipping construction flow for non-hydrated structure", {
        structureId: structure.id,
        worldMapPosition,
        building,
        resource: resource ?? null,
      });
      return;
    }

    logContextMenuDiagnostics("construction-selected", {
      structureId: idString,
      worldMapPosition,
      building,
      resource: resource ?? null,
    });
    uiStore.setStructureEntityId(structure.id, { spectator: false, worldMapPosition });
    navigateToStructure(hexCoords.col, hexCoords.row, "hex");
    uiStore.setSelectedBuilding(building);
    uiStore.setPreviewBuilding(resource !== undefined ? { type: building, resource } : { type: building });
    uiStore.setLeftNavigationView(view);

    if (resource !== undefined) {
      // AudioManager handles muted state internally
      playResourceSound(resource);
    }
  };

  const { constructionAction, radialOptions } = createConstructionMenu({
    structure,
    components,
    simpleCostEnabled: uiStore.useSimpleCost,
    selectConstructionBuilding,
  });

  uiStore.openContextMenu({
    id: `structure-${idString}`,
    title: `Realm ${idString}`,
    subtitle: `(${hexCoords.col}, ${hexCoords.row})`,
    position: { x: event.clientX, y: event.clientY },
    scene: SceneName.WorldMap,
    layout: "radial",
    radialOptions,
    metadata: {
      entityId: structure.id,
      entityType: "structure",
      hex: hexCoords,
    },
    actions: [
      {
        id: `structure-${idString}-attack`,
        label: "Create Attack Army",
        icon: "/image-icons/military.png",
        onSelect: () => {
          openArmyCreationModal(true);
        },
      },
      {
        id: `structure-${idString}-defense`,
        label: "Create Defense Army",
        icon: "/image-icons/shield.png",
        onSelect: () => {
          openArmyCreationModal(false);
        },
      },
      constructionAction,
    ],
  });
};

export const openStructureContextMenu = (params: OpenStructureContextMenuParams) => {
  void openStructureContextMenuInternal(params).catch((error) => {
    console.error("[StructureContextMenu] Failed to open structure context menu", {
      error,
      structureId: params.structure.id,
      position: params.hexCoords,
    });
  });
};
