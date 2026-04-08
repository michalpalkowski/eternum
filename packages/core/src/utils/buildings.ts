import { BuildingType, ClientComponents, ID, ResourceCost, ResourcesIds } from "@bibliothecadao/types";
import { getComponentValue } from "@dojoengine/recs";
import { configManager, getBuildingCount, getEntityIdFromKeys } from "..";
import { resolveComponentByNumericEntityAndIndex, resolveComponentByNumericEntityId } from "./component-resolution";

export const getBuildingQuantity = (entityId: ID, buildingType: BuildingType, components: ClientComponents) => {
  const structureBuildings = resolveComponentByNumericEntityId(components.StructureBuildings, entityId)?.value;

  const buildingCount = getBuildingCount(buildingType, [
    structureBuildings?.packed_counts_1 || 0n,
    structureBuildings?.packed_counts_2 || 0n,
    structureBuildings?.packed_counts_3 || 0n,
  ]);
  return buildingCount;
};

export const getConsumedBy = (resourceProduced: ResourcesIds) => {
  return Object.entries(configManager.complexSystemResourceInputs)
    .map(([resourceId, inputs]) => {
      const resource = inputs.find(
        (input: { resource: number; amount: number }) => input.resource === resourceProduced,
      );
      if (resource) {
        return Number(resourceId);
      }
    })
    .filter(Boolean);
};

const resolveBuildingCostsFromComponents = (
  components: ClientComponents,
  buildingCategory: BuildingType,
  useSimpleCost: boolean,
): ResourceCost[] | undefined => {
  const categoryConfig = getComponentValue(
    components.BuildingCategoryConfig,
    getEntityIdFromKeys([BigInt(buildingCategory)]),
  );

  if (!categoryConfig) {
    return undefined;
  }

  const costListIdRaw = useSimpleCost
    ? categoryConfig.simple_erection_cost_id
    : categoryConfig.complex_erection_cost_id;
  const costListId = BigInt(costListIdRaw ?? 0);
  const costListCount = useSimpleCost
    ? Number(categoryConfig.simple_erection_cost_count ?? 0)
    : Number(categoryConfig.complex_erection_cost_count ?? 0);

  if (!Number.isFinite(costListCount) || costListCount <= 0) {
    // Zero-cost buildings are valid and should stay buildable.
    return [];
  }

  const costs: ResourceCost[] = [];
  for (let index = 0; index < costListCount; index++) {
    const resource = resolveComponentByNumericEntityAndIndex(components.ResourceList, Number(costListId), index)?.value;

    if (!resource) {
      continue;
    }

    costs.push({
      resource: resource.resource_type as ResourcesIds,
      amount: configManager.divideByPrecision(Number(resource.amount)),
    });
  }

  return costs;
};

export const getBuildingCosts = (
  realmEntityId: ID,
  components: ClientComponents,
  buildingCategory: BuildingType,
  useSimpleCost: boolean,
) => {
  const buildingBaseCostPercentIncrease = configManager.getBuildingBaseCostPercentIncrease() / 10000;

  const buildingQuantity = getBuildingQuantity(realmEntityId, buildingCategory, components);

  let updatedCosts: ResourceCost[] = [];

  let costs = useSimpleCost
    ? configManager.simpleBuildingCosts[Number(buildingCategory)]
    : configManager.complexBuildingCosts[Number(buildingCategory)];

  if (!costs) {
    const hydratedCosts = resolveBuildingCostsFromComponents(components, buildingCategory, useSimpleCost);
    if (hydratedCosts === undefined) {
      return undefined;
    }

    // Keep the cache warm for subsequent calls once data has been hydrated.
    if (useSimpleCost) {
      configManager.simpleBuildingCosts[Number(buildingCategory)] = hydratedCosts;
    } else {
      configManager.complexBuildingCosts[Number(buildingCategory)] = hydratedCosts;
    }

    costs = hydratedCosts;
  }

  costs.forEach((cost) => {
    const baseCost = cost.amount;
    const percentageAdditionalCost = baseCost * buildingBaseCostPercentIncrease;
    const scaleFactor = Math.max(0, buildingQuantity ?? 0 - 1);
    const totalCost = baseCost + scaleFactor * scaleFactor * percentageAdditionalCost;
    updatedCosts.push({ resource: cost.resource, amount: totalCost });
  });
  return updatedCosts;
};
