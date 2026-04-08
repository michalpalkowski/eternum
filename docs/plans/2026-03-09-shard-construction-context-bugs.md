# 2026-03-09 - Shard construction context bugs

## Problem summary

Two production blockers appeared during shard gameplay:

1. Construction resources panel stayed unavailable (`realmReady: false`, "Select a realm...") even after selecting own
   realm.
2. Building transactions on shard failed with `missing nonce for contract`.

## Root causes

### 1) RECS entity key mismatch for structures

UI components used `getEntityIdFromKeys([BigInt(entityId)])` as the primary lookup key for
`Structure/Resource/StructureBuildings`. In shard runtime this mapping did not consistently match the actual RECS entity
keys already hydrated from Torii. Result: structure models existed, but UI looked them up under a different key and
treated realm as missing.

### 2) Starknet RPC context drift (main vs shard)

`StarknetProvider` resolved `rpcUrl` at module scope (static initialization). After entering shard mode, tx path could
still use main RPC (`http://localhost:5050`) instead of shard RPC (`shard_rpc`), so nonce lookup happened on wrong
chain. Result: `missing nonce for contract` when sending shard transactions.

## Implemented fixes

### 1) Resolve structure key from hydrated RECS data

- `usePlayerStructures` now carries `recsEntityKey` alongside each structure.
- `ConstructionView` and `RealmInfoPanel` resolve selected structure key from:
  1. `playerStructures[].recsEntityKey`
  2. hydrated `Structure` entities by matching `structure.entity_id`
- `usePlayerStructureSync` hydration check now uses hydrated `Structure` component values (`entity_id`) instead of
  deriving keys from numeric ids.

Files:

- `packages/react/src/hooks/helpers/use-structures.ts`
- `client/apps/game/src/ui/features/settlement/construction/select-preview-building.tsx`
- `client/apps/game/src/ui/modules/entity-details/realm/realm-info-panel.tsx`
- `client/apps/game/src/hooks/helpers/use-player-structure-sync.ts`

### 2) Make Starknet RPC selection reactive to shard context

- Moved RPC resolution into `StarknetProvider` component.
- RPC source now tracks active shard context (`useShardStore`) + URL params.
- Recreate connector/provider config when `rpcUrl` changes.
- Updated callbacks to depend on current `rpcUrl` (no stale closure over old main URL).

File:

- `client/apps/game/src/hooks/context/starknet-provider.tsx`

## Verification

- Type check passed:
  - `pnpm --dir client/apps/game exec tsc -p tsconfig.json --noEmit --pretty false`
