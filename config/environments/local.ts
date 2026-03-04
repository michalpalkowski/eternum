/**
 * Local environment configuration for Eternum.
 * Extends the common configuration with development-specific settings.
 *
 * @module LocalEnvironment
 * @see {@link CommonEternumGlobalConfig} for base configuration
 */

import { RealmLevels, ResourcesIds, type Config } from "@bibliothecadao/types";
import { getSeasonAddresses, type Chain } from "@contracts";
import { EternumGlobalConfig as CommonEternumGlobalConfig } from "./_shared_";

/**
 * Configuration specific to the local development environment.
 * Overrides specific values from the common configuration while inheriting defaults.
 */
export const LocalEternumGlobalConfig: Config = {
  ...CommonEternumGlobalConfig,
  tick: {
    ...CommonEternumGlobalConfig.tick,
  },
  // no stamina cost
  troop: {
    ...CommonEternumGlobalConfig.troop,
    limit: {
      ...CommonEternumGlobalConfig.troop.limit,
      mercenariesTroopLowerBound: 100,
      mercenariesTroopUpperBound: 200,
    },
    stamina: {
      ...CommonEternumGlobalConfig.troop.stamina,
      staminaTravelStaminaCost: 0,
      staminaExploreStaminaCost: 0,
      staminaBonusValue: 0,
    },
  },
  exploration: {
    ...CommonEternumGlobalConfig.exploration,
    hyperstructureWinProbAtCenter: 0,
    hyperstructureFailProbAtCenter: 1,
  },
  // cheap hyperstructures
  hyperstructures: {
    ...CommonEternumGlobalConfig.hyperstructures,
    hyperstructureInitializationShardsCost: {
      resource: CommonEternumGlobalConfig.hyperstructures.hyperstructureInitializationShardsCost.resource,
      amount: 500,
    },
    hyperstructureConstructionCost: CommonEternumGlobalConfig.hyperstructures.hyperstructureConstructionCost.map(
      (cost) => ({
        ...cost,
        min_amount: 120_000,
        max_amount: 120_000,
      }),
    ),
  },
  // no grace period
  battle: {
    ...CommonEternumGlobalConfig.battle,
    graceTickCount: 0,
    graceTickCountHyp: 0,
    delaySeconds: 0,
  },
  startingResources: [
    ...CommonEternumGlobalConfig.startingResources,
    // { resource: ResourcesIds.Essence, amount: 1000 },
    // { resource: ResourcesIds.StaminaRelic1, amount: 1000 },
    // { resource: ResourcesIds.StaminaRelic2, amount: 1000 },
    // { resource: ResourcesIds.DamageRelic1, amount: 1000 },
  ],
  villageStartingResources: [
    ...CommonEternumGlobalConfig.villageStartingResources,
    // { resource: ResourcesIds.Essence, amount: 1000 },
    // { resource: ResourcesIds.StaminaRelic1, amount: 1000 },
    // { resource: ResourcesIds.StaminaRelic2, amount: 1000 },
    // { resource: ResourcesIds.DamageRelic1, amount: 1000 },
  ],
  speed: {
    ...CommonEternumGlobalConfig.speed,
    // 1 second per km
    donkey: 0,
  },
  season: {
    ...CommonEternumGlobalConfig.season,
    startSettlingAfterSeconds: 5, // 5 seconds (overridden by blitz registration_start_at)
    startMainAfterSeconds: 15, // 15 seconds (overridden by blitz registration_end_at)
    durationSeconds: 60 * 60 * 24 * 30, // 1 month
    pointRegistrationCloseAfterEndSeconds: 60 * 10, // 10 minutes
  },
  realmUpgradeCosts: {
    ...CommonEternumGlobalConfig.realmUpgradeCosts,
    [RealmLevels.Settlement]: [],
    [RealmLevels.City]: [
      { resource: ResourcesIds.Labor, amount: 1 },
      { resource: ResourcesIds.Wheat, amount: 1 },
    ],
    [RealmLevels.Kingdom]: [
      { resource: ResourcesIds.Labor, amount: 2 },
      { resource: ResourcesIds.Wheat, amount: 2 },
    ],
    [RealmLevels.Empire]: [
      { resource: ResourcesIds.Labor, amount: 3 },
      { resource: ResourcesIds.Wheat, amount: 3 },
      { resource: ResourcesIds.Wood, amount: 3 },
    ],
  },
  buildings: {
    ...CommonEternumGlobalConfig.buildings,
    // complexBuildingCosts: {
    //   ...CommonEternumGlobalConfig.buildings.complexBuildingCosts,
    //   [BuildingType.ResourceWheat]: [{ resource: ResourcesIds.Fish, amount: 1 }],
    // },
    // buildingPopulation: {
    //   ...CommonEternumGlobalConfig.buildings.buildingPopulation,
    //   [BuildingType.ResourceWheat]: 0,
    // },
  },
  dev: {
    ...CommonEternumGlobalConfig.dev,
    mode: {
      ...CommonEternumGlobalConfig.dev.mode,
      on: true,
    },
  },
  blitz: {
    ...CommonEternumGlobalConfig.blitz,
    mode: {
      on: true,
    },
    registration: {
      ...CommonEternumGlobalConfig.blitz.registration,
      fee_amount: 0n,
      registration_delay_seconds: 5, // 5 seconds before registration opens
      registration_period_seconds: 10, // 10 seconds registration window
      collectible_cosmetics_address: "0x0",
      collectible_timelock_address: "0x0",
      collectibles_lootchest_address: "0x0",
      collectibles_elitenft_address: "0x0",
    },
  },
};

export default LocalEternumGlobalConfig;
