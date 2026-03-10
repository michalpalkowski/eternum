import { type ID } from "@bibliothecadao/types";
import { ComponentValue, Entity, getComponentValue, Has, runQuery } from "@dojoengine/recs";
import { getEntityIdFromKeys } from "@dojoengine/utils";

type ComponentLike = { schema: any };

type ResolvedComponentEntry<T extends ComponentLike> = {
  entity: Entity;
  value: ComponentValue<T["schema"]>;
};

const entityHandleCache = new WeakMap<object, Map<number, Entity>>();
const indexedEntityHandleCache = new WeakMap<object, Map<string, Entity>>();

const normalizeNumericKey = (value: unknown): number | undefined => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
};

const getEntityCache = (component: object): Map<number, Entity> => {
  let cache: Map<number, Entity> | undefined = entityHandleCache.get(component);
  if (!cache) {
    cache = new Map<number, Entity>();
    entityHandleCache.set(component, cache);
  }
  return cache;
};

const getIndexedEntityCache = (component: object): Map<string, Entity> => {
  let cache: Map<string, Entity> | undefined = indexedEntityHandleCache.get(component);
  if (!cache) {
    cache = new Map<string, Entity>();
    indexedEntityHandleCache.set(component, cache);
  }
  return cache;
};

const getIndexedCacheKey = (entityId: number, index: number) => `${entityId}:${index}`;

export const resolveComponentByNumericEntityId = <T extends ComponentLike>(
  component: T,
  entityId: ID,
): ResolvedComponentEntry<T> | undefined => {
  const numericEntityId = normalizeNumericKey(entityId);
  if (numericEntityId === undefined) {
    return undefined;
  }

  const directEntity = getEntityIdFromKeys([BigInt(numericEntityId)]);
  const directValue = getComponentValue(component as any, directEntity as any);
  if (normalizeNumericKey((directValue as { entity_id?: unknown } | null)?.entity_id) === numericEntityId) {
    getEntityCache(component as object).set(numericEntityId, directEntity as Entity);
    return { entity: directEntity as Entity, value: directValue as ComponentValue<T["schema"]> };
  }

  const cache = getEntityCache(component as object);
  const cachedEntity = cache.get(numericEntityId);
  if (cachedEntity !== undefined) {
    const cachedValue = getComponentValue(component as any, cachedEntity as any);
    if (normalizeNumericKey((cachedValue as { entity_id?: unknown } | null)?.entity_id) === numericEntityId) {
      return { entity: cachedEntity, value: cachedValue as ComponentValue<T["schema"]> };
    }
    cache.delete(numericEntityId);
  }

  for (const entity of runQuery([Has(component as any)])) {
    const value = getComponentValue(component as any, entity as any);
    if (normalizeNumericKey((value as { entity_id?: unknown } | null)?.entity_id) === numericEntityId) {
      cache.set(numericEntityId, entity as Entity);
      return { entity: entity as Entity, value: value as ComponentValue<T["schema"]> };
    }
  }

  return undefined;
};

export const resolveComponentByNumericEntityAndIndex = <T extends ComponentLike>(
  component: T,
  entityId: ID,
  index: number,
): ResolvedComponentEntry<T> | undefined => {
  const numericEntityId = normalizeNumericKey(entityId);
  const numericIndex = normalizeNumericKey(index);
  if (numericEntityId === undefined || numericIndex === undefined) {
    return undefined;
  }

  const directEntity = getEntityIdFromKeys([BigInt(numericEntityId), BigInt(numericIndex)]);
  const directValue = getComponentValue(component as any, directEntity as any);
  const directEntityId = normalizeNumericKey((directValue as { entity_id?: unknown } | null)?.entity_id);
  const directIndex = normalizeNumericKey((directValue as { index?: unknown } | null)?.index);
  if (directEntityId === numericEntityId && directIndex === numericIndex) {
    getIndexedEntityCache(component as object).set(
      getIndexedCacheKey(numericEntityId, numericIndex),
      directEntity as Entity,
    );
    return { entity: directEntity as Entity, value: directValue as ComponentValue<T["schema"]> };
  }

  const cache = getIndexedEntityCache(component as object);
  const cacheKey = getIndexedCacheKey(numericEntityId, numericIndex);
  const cachedEntity = cache.get(cacheKey);
  if (cachedEntity !== undefined) {
    const cachedValue = getComponentValue(component as any, cachedEntity as any);
    const cachedEntityId = normalizeNumericKey((cachedValue as { entity_id?: unknown } | null)?.entity_id);
    const cachedIndex = normalizeNumericKey((cachedValue as { index?: unknown } | null)?.index);
    if (cachedEntityId === numericEntityId && cachedIndex === numericIndex) {
      return { entity: cachedEntity, value: cachedValue as ComponentValue<T["schema"]> };
    }
    cache.delete(cacheKey);
  }

  for (const entity of runQuery([Has(component as any)])) {
    const value = getComponentValue(component as any, entity as any);
    const scannedEntityId = normalizeNumericKey((value as { entity_id?: unknown } | null)?.entity_id);
    const scannedIndex = normalizeNumericKey((value as { index?: unknown } | null)?.index);
    if (scannedEntityId === numericEntityId && scannedIndex === numericIndex) {
      cache.set(cacheKey, entity as Entity);
      return { entity: entity as Entity, value: value as ComponentValue<T["schema"]> };
    }
  }

  return undefined;
};
