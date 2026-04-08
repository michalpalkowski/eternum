import { useDojo } from "@bibliothecadao/react";
import { useEntityQuery } from "@dojoengine/react";
import { Entity, getComponentValue, Has } from "@dojoengine/recs";
import { getEntityIdFromKeys } from "@dojoengine/utils";
import { useMemo } from "react";

import { useUIStore } from "@/hooks/store/use-ui-store";

export type StructureWithRecsEntityKey = {
  entityId: number | string;
  recsEntityKey?: string;
};

export const resolveStructureEntityKey = (
  structureEntityId: number | string | null | undefined,
  structureComponent: any,
  knownStructureEntities: Iterable<Entity>,
  structuresWithKeys: StructureWithRecsEntityKey[],
): Entity | undefined => {
  const numericStructureEntityId = Number(structureEntityId);
  if (!Number.isFinite(numericStructureEntityId)) {
    return undefined;
  }

  const selected = structuresWithKeys.find((item) => Number(item.entityId) === numericStructureEntityId);
  if (selected?.recsEntityKey) {
    const selectedStructure = getComponentValue(structureComponent, selected.recsEntityKey as Entity);
    const selectedStructureEntityId = Number((selectedStructure as { entity_id?: unknown } | null)?.entity_id);
    if (Number.isFinite(selectedStructureEntityId) && selectedStructureEntityId === numericStructureEntityId) {
      return selected.recsEntityKey as Entity;
    }
  }

  try {
    const directEntityKey = getEntityIdFromKeys([BigInt(numericStructureEntityId)]) as Entity;
    const directStructure = getComponentValue(structureComponent, directEntityKey);
    const directStructureEntityId = Number((directStructure as { entity_id?: unknown } | null)?.entity_id);
    if (Number.isFinite(directStructureEntityId) && directStructureEntityId === numericStructureEntityId) {
      return directEntityKey;
    }
  } catch {
    // Fall through to scan hydrated entities.
  }

  for (const candidate of knownStructureEntities) {
    const candidateStructure = getComponentValue(structureComponent, candidate);
    if (!candidateStructure) continue;

    const candidateEntityId = Number((candidateStructure as { entity_id?: unknown }).entity_id);
    if (Number.isFinite(candidateEntityId) && candidateEntityId === numericStructureEntityId) {
      return candidate;
    }
  }

  return undefined;
};

export const useResolvedStructureEntityKey = (
  structureEntityId: number | string | null | undefined,
  structuresWithKeysInput?: StructureWithRecsEntityKey[],
): Entity | undefined => {
  const {
    setup: { components },
  } = useDojo();
  const fallbackPlayerStructures = useUIStore((state) => state.playerStructures) as StructureWithRecsEntityKey[];
  const structuresWithKeys = structuresWithKeysInput ?? fallbackPlayerStructures;
  const knownStructureEntities = useEntityQuery([Has(components.Structure)]);

  return useMemo(
    () =>
      resolveStructureEntityKey(structureEntityId, components.Structure, knownStructureEntities, structuresWithKeys),
    [components.Structure, knownStructureEntities, structureEntityId, structuresWithKeys],
  );
};
