import { useDojo } from "@bibliothecadao/react";
import { WORLD_CONFIG_ID } from "@bibliothecadao/types";
import { useComponentValue, useEntityQuery } from "@dojoengine/react";
import { Entity, getComponentValue, Has } from "@dojoengine/recs";
import { getEntityIdFromKeys } from "@dojoengine/utils";
import { useMemo } from "react";

export const useResolvedWorldConfigEntityKey = (): Entity | undefined => {
  const {
    setup: { components },
  } = useDojo();
  const worldConfigEntities = useEntityQuery([Has(components.WorldConfig)]);

  return useMemo(() => {
    const directEntityKey = getEntityIdFromKeys([WORLD_CONFIG_ID]) as Entity;
    const directWorldConfig = getComponentValue(components.WorldConfig, directEntityKey);
    if (directWorldConfig) {
      return directEntityKey;
    }

    return worldConfigEntities[0];
  }, [components.WorldConfig, worldConfigEntities]);
};

export const useWorldConfigValue = () => {
  const {
    setup: { components },
  } = useDojo();
  const worldConfigEntity = useResolvedWorldConfigEntityKey();

  return useComponentValue(components.WorldConfig, worldConfigEntity);
};
