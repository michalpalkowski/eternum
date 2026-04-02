/**
 * Minimal interface for entities that can be checked for deletion.
 * Works with both ToriiEntity (main thread) and ToriiPayload (worker).
 */
interface EntityWithModels {
  models: Record<string, unknown>;
}

export type SyncUpdateOrigin = "entity" | "event";

/**
 * Determines if a Torii entity update represents a deletion notification.
 * Deletion is indicated by either:
 * - Empty or missing models object
 * - All model values being empty objects
 */
export const isDeletionPayload = (entity: EntityWithModels): boolean => {
  if (!entity.models || Object.keys(entity.models).length === 0) {
    return true;
  }
  // Deletion if every top-level model has empty object as its value.
  return Object.values(entity.models).every(
    (model) => model && typeof model === "object" && Object.keys(model).length === 0,
  );
};

/**
 * Protocol guard for deletion semantics.
 * We only accept deletion payloads from the entity stream. Event stream updates
 * can legitimately arrive without entity models and must not delete state.
 */
export const isDeletablePayloadForOrigin = (entity: EntityWithModels, origin: SyncUpdateOrigin): boolean => {
  if (origin !== "entity") {
    return false;
  }
  return isDeletionPayload(entity);
};
