import { ClientComponents, findResourceIdByTrait, ID, orders, RealmInfo, RealmInterface } from "@bibliothecadao/types";
import { Entity, getComponentValue } from "@dojoengine/recs";
import { configManager, getAddressNameFromEntity, ResourceManager, DEFAULT_COORD_ALT } from "..";
import realmsJson from "../data/realms.json";
import { packValues, unpackValue } from "./packed-data";

interface Attribute {
  trait_type: string;
  value: any;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toBigIntSafe = (value: unknown): bigint | null => {
  if (value === undefined || value === null) return null;

  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;

  if ("value" in value) {
    const nested = toBigIntSafe(value.value);
    if (nested !== null) return nested;
  }

  if ("Some" in value) {
    const nested = toBigIntSafe(value.Some);
    if (nested !== null) return nested;
  }

  if ("low" in value || "high" in value) {
    const low = toBigIntSafe(value.low ?? 0) ?? 0n;
    const high = toBigIntSafe(value.high ?? 0) ?? 0n;
    return low + (high << 128n);
  }

  return null;
};

let realms: {
  [key: string]: any;
} = {};

const loadRealms = async () => {
  if (typeof window === "undefined") return;
  const response = await fetch("/jsons/realms.json");
  realms = await response.json();
};

loadRealms();

export const getRealmNameById = (realmId: ID): string => {
  const features = realmsJson["features"][realmId - 1];
  if (!features) return "";
  return features["name"];
};

const resolveRealmEntry = (realmId: ID): any | null => {
  const dynamicRealm = realms[realmId.toString()];
  if (dynamicRealm) {
    return dynamicRealm;
  }

  const staticRealm = realmsJson["features"]?.[realmId - 1];
  return staticRealm ?? null;
};

const resolveProducedResources = (packedValue: unknown, realmId: ID): number[] => {
  const packedResources = toBigIntSafe(packedValue);
  if (packedResources !== null) {
    return unpackValue(packedResources);
  }

  // Fallback for schema/decoder drift where resources_packed can arrive in unexpected shape.
  const offchainRealm = getOffchainRealm(realmId);
  if (offchainRealm) {
    return unpackValue(BigInt(offchainRealm.resourceTypesPacked));
  }

  return [];
};

export function getRealmInfo(entity: Entity, components: ClientComponents): RealmInfo | undefined {
  const structure = getComponentValue(components.Structure, entity);
  const structureBuildings = getComponentValue(components.StructureBuildings, entity);

  if (structure) {
    const realm_id = structure.metadata.realm_id;
    const order = structure.metadata.order;
    const level = structure.base.level;
    const entity_id = structure.entity_id;
    const produced_resources = structure.resources_packed;
    const resources = resolveProducedResources(produced_resources, realm_id);

    const resourceManager = new ResourceManager(components, entity_id);

    return {
      realmId: realm_id,
      entityId: entity_id,
      category: structure.category,
      level,
      resources,
      order,
      storehouses: resourceManager.getStoreCapacityKg(),
      position: { alt: DEFAULT_COORD_ALT, x: structure.base.coord_x, y: structure.base.coord_y },
      population: structureBuildings?.population.current,
      capacity: structureBuildings?.population.max,
      hasCapacity:
        !structureBuildings?.population ||
        structureBuildings.population.max + configManager.getBasePopulationCapacity() >
          structureBuildings.population.current,
      owner: structure?.owner,
      ownerName: getAddressNameFromEntity(entity_id, components) || "",
      hasWonder: structure.metadata.has_wonder,
      structure,
    };
  }
}

export function getOffchainRealm(realmId: ID): RealmInterface | undefined {
  const realm = resolveRealmEntry(realmId);
  if (!realm) return;

  const resourceIds = realm.attributes
    .filter(({ trait_type }: Attribute) => trait_type === "Resource")
    .map(({ value }: Attribute) => findResourceIdByTrait(value))
    .filter((resourceId: unknown): resourceId is number => typeof resourceId === "number");

  const resourceTypesPacked = BigInt(packValues(resourceIds));

  const getAttributeValue = (attributeName: string): number => {
    const attribute = realm.attributes.find(({ trait_type }: Attribute) => trait_type === attributeName);
    return attribute ? attribute.value : 0;
  };

  const cities = getAttributeValue("Cities");
  const harbors = getAttributeValue("Harbors");
  const rivers = getAttributeValue("Rivers");
  const regions = getAttributeValue("Regions");

  const wonder: number = 1;

  const orderAttribute = realm.attributes.find(({ trait_type }: Attribute) => trait_type === "Order");
  const orderName = orderAttribute ? orderAttribute.value.split(" ").pop() || "" : "";
  const order = orders.find(({ orderName: name }) => name === orderName)?.orderId || 0;

  const imageUrl = realm.image;

  return {
    realmId,
    name: getRealmNameById(realmId),
    resourceTypesPacked,
    resourceTypesCount: resourceIds.length,
    cities,
    harbors,
    rivers,
    regions,
    wonder,
    order,
    imageUrl,
  };
}

export const hasEnoughPopulationForBuilding = (realm: any, building: number) => {
  const buildingPopulation = configManager.getBuildingCategoryConfig(building).population_cost;
  const basePopulationCapacity = configManager.getBasePopulationCapacity();

  return (realm?.population || 0) + buildingPopulation <= basePopulationCapacity + (realm?.capacity || 0);
};

export const maxLayer = (realmCount: number): number => {
  // Calculate the maximum layer on the concentric hexagon
  // that can be built on based on realm count

  if (realmCount <= 1500) {
    return 26; // 2105 capacity
  }

  if (realmCount <= 2500) {
    return 32; // 3167 capacity
  }

  if (realmCount <= 3500) {
    return 37; // 4217 capacity
  }

  if (realmCount <= 4500) {
    return 41; // 5165 capacity
  }

  if (realmCount <= 5500) {
    return 45; // 6209 capacity
  }

  if (realmCount <= 6500) {
    return 49; // 7349 capacity
  }

  return 52; // 8267 capacity
};
