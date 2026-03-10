import { afterEach, describe, expect, it, vi } from "vitest";
import { WORLD_CONFIG_ID, ResourcesIds, StructureType, RESOURCE_PRECISION } from "@bibliothecadao/types";
import { configManager } from "./config-manager";

vi.mock("@dojoengine/recs", () => ({
  getComponentValue: (component: unknown, entity: unknown) => {
    if (component instanceof Map) {
      return component.get(entity);
    }
    return undefined;
  },
  Has: (component: unknown) => component,
  runQuery: (clauses: unknown[]) => {
    const component = clauses[0];
    if (component instanceof Map) {
      return new Set(component.keys());
    }
    return new Set();
  },
}));

vi.mock("@dojoengine/utils", () => ({
  getEntityIdFromKeys: (keys: Array<bigint | number>) => `direct:${keys.map((key) => BigInt(key).toString()).join(":")}`,
}));

describe("ClientConfigManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates realm upgrade costs from scanned StructureLevelConfig and ResourceList entries when direct keys miss", () => {
    const worldConfigKey = `direct:${WORLD_CONFIG_ID}`;
    const structureLevelEntity = "hydrated:StructureLevelConfig:2";
    const resourceListEntityWood = "hydrated:ResourceList:82:0";
    const resourceListEntityStone = "hydrated:ResourceList:82:1";

    const components = {
      WorldConfig: new Map([
        [
          worldConfigKey,
          {
            config_id: WORLD_CONFIG_ID,
            structure_max_level_config: {
              realm_max: 4,
              village_max: 2,
            },
          },
        ],
      ]),
      StructureLevelConfig: new Map([
        [
          structureLevelEntity,
          {
            level: 2,
            required_resources_id: 82,
            required_resource_count: 2,
          },
        ],
      ]),
      ResourceList: new Map([
        [
          resourceListEntityWood,
          {
            entity_id: 82,
            index: 0,
            resource_type: ResourcesIds.Wood,
            amount: BigInt(500 * RESOURCE_PRECISION),
          },
        ],
        [
          resourceListEntityStone,
          {
            entity_id: 82,
            index: 1,
            resource_type: ResourcesIds.Stone,
            amount: BigInt(900 * RESOURCE_PRECISION),
          },
        ],
      ]),
      ResourceFactoryConfig: new Map(),
      HyperstrtConstructConfig: new Map(),
      BuildingCategoryConfig: new Map(),
      WeightConfig: new Map(),
    } as any;

    configManager.setDojo(components, {} as any);

    expect(configManager.getMaxLevel(StructureType.Realm)).toBe(4);
    expect(configManager.realmUpgradeCosts[2]).toEqual([
      { resource: ResourcesIds.Wood, amount: 500 },
      { resource: ResourcesIds.Stone, amount: 900 },
    ]);
  });
});
