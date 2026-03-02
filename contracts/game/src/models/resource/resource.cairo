use core::fmt::{Display, Error, Formatter};
use core::num::traits::zero::Zero;
use dojo::model::{Model, ModelStorage};
use dojo::world::WorldStorage;
use crate::alias::ID;
use crate::constants::{
    RELICS_RESOURCE_END_ID, RELICS_RESOURCE_START_ID, RESOURCE_PRECISION, ResourceTypes, resource_type_name,
};
use crate::models::config::{TickImpl, WeightConfig};
use crate::models::resource::production::production::{Production, ProductionImpl};
use crate::models::weight::{Weight, WeightImpl};


#[derive(Copy, Drop, Serde)]
pub struct SingleResource {
    pub entity_id: ID,
    pub resource_type: u8,
    /// Cumulative additions (G-Counter, only grows). Includes initial value + all adds.
    pub additions: u128,
    /// Cumulative subtractions (G-Counter, only grows). Tracks all spends.
    pub subtractions: u128,
    pub production: Production,
    pub produces: bool,
}

impl SingleResourceDisplay of Display<SingleResource> {
    fn fmt(self: @SingleResource, ref f: Formatter) -> Result<(), Error> {
        let str: ByteArray = format!(
            "{} (id: {}, balance: {})",
            resource_type_name(*self.resource_type),
            *self.entity_id,
            *self.additions - *self.subtractions,
        );
        f.buffer.append(@str);
        Result::Ok(())
    }
}


#[generate_trait]
pub impl WeightStoreImpl of WeightStoreTrait {
    fn retrieve(ref world: WorldStorage, entity_id: ID) -> Weight {
        assert!(entity_id.is_non_zero(), "entity id not found");
        ResourceImpl::read_weight(ref world, entity_id)
    }

    fn store(ref self: Weight, ref world: WorldStorage, entity_id: ID) {
        ResourceImpl::write_weight(ref world, entity_id, self);
    }
}

#[generate_trait]
pub impl ResourceWeightImpl of ResourceWeightTrait {
    fn grams(ref world: WorldStorage, resource_type: u8) -> u128 {
        let unit_weight_config: WeightConfig = world.read_model(resource_type);
        unit_weight_config.weight_gram
    }
}


#[generate_trait]
pub impl SingleResourceStoreImpl of SingleResourceStoreTrait {
    fn retrieve(
        ref world: WorldStorage,
        entity_id: ID,
        resource_type: u8,
        ref entity_weight: Weight,
        unit_weight_grams: u128,
        structure: bool,
    ) -> SingleResource {
        assert!(entity_id.is_non_zero(), "entity id not found");
        assert!(resource_type.is_non_zero(), "invalid resource specified");

        let additions: u128 = ResourceImpl::read_additions(ref world, entity_id, resource_type);
        let subtractions: u128 = ResourceImpl::read_subtractions(ref world, entity_id, resource_type);
        let mut resource = SingleResource {
            entity_id, resource_type, additions, subtractions, production: Zero::zero(), produces: structure,
        };
        if resource.produces {
            let now: u32 = starknet::get_block_timestamp().try_into().unwrap();
            resource.production = ResourceImpl::read_production(ref world, entity_id, resource_type);
            if resource.production.last_updated_at != now {
                // harvest the resource and get the amount of resources produced
                let harvest_amount: u128 = ProductionImpl::harvest(ref resource);

                // add the produced amount to the resource balance
                if harvest_amount.is_non_zero() {
                    let unit_weight_grams: u128 = ResourceWeightImpl::grams(ref world, resource_type);
                    resource.add(harvest_amount, ref entity_weight, unit_weight_grams);
                }

                // commit entity resource and weight
                resource.store(ref world);
                entity_weight.store(ref world, entity_id);
            }
        }

        return resource;
    }

    fn store(ref self: SingleResource, ref world: WorldStorage) {
        ResourceImpl::write_additions(ref world, self.entity_id, self.resource_type, self.additions);
        ResourceImpl::write_subtractions(ref world, self.entity_id, self.resource_type, self.subtractions);
        if self.produces {
            ResourceImpl::write_production(ref world, self.entity_id, self.resource_type, self.production);
        }
    }
}

#[generate_trait]
pub impl RelicResourceImpl of RelicResourceTrait {
    fn is_relic(resource_type: u8) -> bool {
        resource_type >= RELICS_RESOURCE_START_ID && resource_type <= RELICS_RESOURCE_END_ID
    }
}

#[generate_trait]
pub impl TroopResourceImpl of TroopResourceTrait {
    fn is_troop(resource_type: u8) -> bool {
        resource_type == ResourceTypes::KNIGHT_T1
            || resource_type == ResourceTypes::KNIGHT_T2
            || resource_type == ResourceTypes::KNIGHT_T3
            || resource_type == ResourceTypes::CROSSBOWMAN_T1
            || resource_type == ResourceTypes::CROSSBOWMAN_T2
            || resource_type == ResourceTypes::CROSSBOWMAN_T3
            || resource_type == ResourceTypes::PALADIN_T1
            || resource_type == ResourceTypes::PALADIN_T2
            || resource_type == ResourceTypes::PALADIN_T3
    }

    fn is_t2_troop(resource_type: u8) -> bool {
        resource_type == ResourceTypes::KNIGHT_T2
            || resource_type == ResourceTypes::CROSSBOWMAN_T2
            || resource_type == ResourceTypes::PALADIN_T2
    }

    fn is_t3_troop(resource_type: u8) -> bool {
        resource_type == ResourceTypes::KNIGHT_T3
            || resource_type == ResourceTypes::CROSSBOWMAN_T3
            || resource_type == ResourceTypes::PALADIN_T3
    }
}

#[generate_trait]
pub impl SingleResourceImpl of SingleResourceTrait {
    /// Effective balance = cumulative additions - cumulative subtractions.
    fn balance(self: @SingleResource) -> u128 {
        *self.additions - *self.subtractions
    }

    fn ensure_correct_precision(ref self: SingleResource) {
        if RelicResourceImpl::is_relic(self.resource_type) {
            assert!(
                self.balance() % RESOURCE_PRECISION == 0,
                "Eternum: Resource balance must be a multiple of RESOURCE_PRECISION for relics",
            );
        }
    }

    fn spend(ref self: SingleResource, amount: u128, ref entity_weight: Weight, unit_weight: u128) {
        assert!(self.balance() >= amount, "Insufficient Balance: {} < {}", self, amount);
        self.subtractions += amount;
        self.ensure_correct_precision();
        entity_weight.deduct(amount * unit_weight);
    }


    fn add(ref self: SingleResource, amount: u128, ref entity_weight: Weight, unit_weight: u128) -> u128 {
        let (max_storable, total_weight) = Self::storable_amount(amount, entity_weight.unused(), unit_weight);

        self.additions += max_storable;
        self.ensure_correct_precision();
        entity_weight.add(total_weight);

        max_storable
    }

    fn storable_amount(amount: u128, storage_left: u128, unit_weight: u128) -> (u128, u128) {
        let mut max_storable: u128 = amount;
        let mut total_weight: u128 = unit_weight * amount;

        if storage_left < total_weight {
            max_storable = storage_left / unit_weight;
            total_weight = max_storable * unit_weight;
        }

        (max_storable, total_weight)
    }
}


#[generate_trait]
pub impl StructureSingleResourceFoodImpl of StructureSingleResourceFoodTrait {
    fn is_food(resource_type: u8) -> bool {
        resource_type == ResourceTypes::WHEAT || resource_type == ResourceTypes::FISH
    }
}

#[derive(Introspect, Copy, Drop, Serde, Default)]
#[dojo::model]
pub struct Resource {
    #[key]
    entity_id: ID,
    // PN-Counter resource fields: ADDITIONS (P, grow-only) + SUBTRACTIONS (N, grow-only).
    // Effective balance = ADDITIONS - SUBTRACTIONS.
    STONE_ADDITIONS: u128,
    STONE_SUBTRACTIONS: u128,
    COAL_ADDITIONS: u128,
    COAL_SUBTRACTIONS: u128,
    WOOD_ADDITIONS: u128,
    WOOD_SUBTRACTIONS: u128,
    COPPER_ADDITIONS: u128,
    COPPER_SUBTRACTIONS: u128,
    IRONWOOD_ADDITIONS: u128,
    IRONWOOD_SUBTRACTIONS: u128,
    OBSIDIAN_ADDITIONS: u128,
    OBSIDIAN_SUBTRACTIONS: u128,
    GOLD_ADDITIONS: u128,
    GOLD_SUBTRACTIONS: u128,
    SILVER_ADDITIONS: u128,
    SILVER_SUBTRACTIONS: u128,
    MITHRAL_ADDITIONS: u128,
    MITHRAL_SUBTRACTIONS: u128,
    ALCHEMICAL_SILVER_ADDITIONS: u128,
    ALCHEMICAL_SILVER_SUBTRACTIONS: u128,
    COLD_IRON_ADDITIONS: u128,
    COLD_IRON_SUBTRACTIONS: u128,
    DEEP_CRYSTAL_ADDITIONS: u128,
    DEEP_CRYSTAL_SUBTRACTIONS: u128,
    RUBY_ADDITIONS: u128,
    RUBY_SUBTRACTIONS: u128,
    DIAMONDS_ADDITIONS: u128,
    DIAMONDS_SUBTRACTIONS: u128,
    HARTWOOD_ADDITIONS: u128,
    HARTWOOD_SUBTRACTIONS: u128,
    IGNIUM_ADDITIONS: u128,
    IGNIUM_SUBTRACTIONS: u128,
    TWILIGHT_QUARTZ_ADDITIONS: u128,
    TWILIGHT_QUARTZ_SUBTRACTIONS: u128,
    TRUE_ICE_ADDITIONS: u128,
    TRUE_ICE_SUBTRACTIONS: u128,
    ADAMANTINE_ADDITIONS: u128,
    ADAMANTINE_SUBTRACTIONS: u128,
    SAPPHIRE_ADDITIONS: u128,
    SAPPHIRE_SUBTRACTIONS: u128,
    ETHEREAL_SILICA_ADDITIONS: u128,
    ETHEREAL_SILICA_SUBTRACTIONS: u128,
    DRAGONHIDE_ADDITIONS: u128,
    DRAGONHIDE_SUBTRACTIONS: u128,
    LABOR_ADDITIONS: u128,
    LABOR_SUBTRACTIONS: u128,
    EARTHEN_SHARD_ADDITIONS: u128,
    EARTHEN_SHARD_SUBTRACTIONS: u128,
    DONKEY_ADDITIONS: u128,
    DONKEY_SUBTRACTIONS: u128,
    KNIGHT_T1_ADDITIONS: u128,
    KNIGHT_T1_SUBTRACTIONS: u128,
    KNIGHT_T2_ADDITIONS: u128,
    KNIGHT_T2_SUBTRACTIONS: u128,
    KNIGHT_T3_ADDITIONS: u128,
    KNIGHT_T3_SUBTRACTIONS: u128,
    CROSSBOWMAN_T1_ADDITIONS: u128,
    CROSSBOWMAN_T1_SUBTRACTIONS: u128,
    CROSSBOWMAN_T2_ADDITIONS: u128,
    CROSSBOWMAN_T2_SUBTRACTIONS: u128,
    CROSSBOWMAN_T3_ADDITIONS: u128,
    CROSSBOWMAN_T3_SUBTRACTIONS: u128,
    PALADIN_T1_ADDITIONS: u128,
    PALADIN_T1_SUBTRACTIONS: u128,
    PALADIN_T2_ADDITIONS: u128,
    PALADIN_T2_SUBTRACTIONS: u128,
    PALADIN_T3_ADDITIONS: u128,
    PALADIN_T3_SUBTRACTIONS: u128,
    WHEAT_ADDITIONS: u128,
    WHEAT_SUBTRACTIONS: u128,
    FISH_ADDITIONS: u128,
    FISH_SUBTRACTIONS: u128,
    LORDS_ADDITIONS: u128,
    LORDS_SUBTRACTIONS: u128,
    ESSENCE_ADDITIONS: u128,
    ESSENCE_SUBTRACTIONS: u128,
    RELIC_E1_ADDITIONS: u128,
    RELIC_E1_SUBTRACTIONS: u128,
    RELIC_E2_ADDITIONS: u128,
    RELIC_E2_SUBTRACTIONS: u128,
    RELIC_E3_ADDITIONS: u128,
    RELIC_E3_SUBTRACTIONS: u128,
    RELIC_E4_ADDITIONS: u128,
    RELIC_E4_SUBTRACTIONS: u128,
    RELIC_E5_ADDITIONS: u128,
    RELIC_E5_SUBTRACTIONS: u128,
    RELIC_E6_ADDITIONS: u128,
    RELIC_E6_SUBTRACTIONS: u128,
    RELIC_E7_ADDITIONS: u128,
    RELIC_E7_SUBTRACTIONS: u128,
    RELIC_E8_ADDITIONS: u128,
    RELIC_E8_SUBTRACTIONS: u128,
    RELIC_E9_ADDITIONS: u128,
    RELIC_E9_SUBTRACTIONS: u128,
    RELIC_E10_ADDITIONS: u128,
    RELIC_E10_SUBTRACTIONS: u128,
    RELIC_E11_ADDITIONS: u128,
    RELIC_E11_SUBTRACTIONS: u128,
    RELIC_E12_ADDITIONS: u128,
    RELIC_E12_SUBTRACTIONS: u128,
    RELIC_E13_ADDITIONS: u128,
    RELIC_E13_SUBTRACTIONS: u128,
    RELIC_E14_ADDITIONS: u128,
    RELIC_E14_SUBTRACTIONS: u128,
    RELIC_E15_ADDITIONS: u128,
    RELIC_E15_SUBTRACTIONS: u128,
    RELIC_E16_ADDITIONS: u128,
    RELIC_E16_SUBTRACTIONS: u128,
    RELIC_E17_ADDITIONS: u128,
    RELIC_E17_SUBTRACTIONS: u128,
    RELIC_E18_ADDITIONS: u128,
    RELIC_E18_SUBTRACTIONS: u128,
    weight: Weight,
    STONE_PRODUCTION: Production,
    COAL_PRODUCTION: Production,
    WOOD_PRODUCTION: Production,
    COPPER_PRODUCTION: Production,
    IRONWOOD_PRODUCTION: Production,
    OBSIDIAN_PRODUCTION: Production,
    GOLD_PRODUCTION: Production,
    SILVER_PRODUCTION: Production,
    MITHRAL_PRODUCTION: Production,
    ALCHEMICAL_SILVER_PRODUCTION: Production,
    COLD_IRON_PRODUCTION: Production,
    DEEP_CRYSTAL_PRODUCTION: Production,
    RUBY_PRODUCTION: Production,
    DIAMONDS_PRODUCTION: Production,
    HARTWOOD_PRODUCTION: Production,
    IGNIUM_PRODUCTION: Production,
    TWILIGHT_QUARTZ_PRODUCTION: Production,
    TRUE_ICE_PRODUCTION: Production,
    ADAMANTINE_PRODUCTION: Production,
    SAPPHIRE_PRODUCTION: Production,
    ETHEREAL_SILICA_PRODUCTION: Production,
    DRAGONHIDE_PRODUCTION: Production,
    LABOR_PRODUCTION: Production,
    EARTHEN_SHARD_PRODUCTION: Production,
    DONKEY_PRODUCTION: Production,
    KNIGHT_T1_PRODUCTION: Production,
    KNIGHT_T2_PRODUCTION: Production,
    KNIGHT_T3_PRODUCTION: Production,
    CROSSBOWMAN_T1_PRODUCTION: Production,
    CROSSBOWMAN_T2_PRODUCTION: Production,
    CROSSBOWMAN_T3_PRODUCTION: Production,
    PALADIN_T1_PRODUCTION: Production,
    PALADIN_T2_PRODUCTION: Production,
    PALADIN_T3_PRODUCTION: Production,
    WHEAT_PRODUCTION: Production,
    FISH_PRODUCTION: Production,
    LORDS_PRODUCTION: Production,
    ESSENCE_PRODUCTION: Production,
}


#[generate_trait]
pub impl ResourceImpl of ResourceTrait {
    fn initialize(ref world: WorldStorage, entity_id: ID) {
        let mut resource: Resource = Default::default();
        resource.entity_id = entity_id;
        world.write_model(@resource);
    }

    fn read_additions(ref world: WorldStorage, entity_id: ID, resource_type: u8) -> u128 {
        return world
            .read_member(
                Model::<Resource>::ptr_from_keys(entity_id), Self::additions_selector(resource_type.into()),
            );
    }

    fn read_subtractions(ref world: WorldStorage, entity_id: ID, resource_type: u8) -> u128 {
        return world
            .read_member(
                Model::<Resource>::ptr_from_keys(entity_id), Self::subtractions_selector(resource_type.into()),
            );
    }

    /// Convenience: read effective balance = additions - subtractions.
    fn read_balance(ref world: WorldStorage, entity_id: ID, resource_type: u8) -> u128 {
        let additions = Self::read_additions(ref world, entity_id, resource_type);
        let subtractions = Self::read_subtractions(ref world, entity_id, resource_type);
        additions - subtractions
    }

    /// Convenience: set effective balance by writing additions=balance, subtractions=0.
    fn write_balance(ref world: WorldStorage, entity_id: ID, resource_type: u8, balance: u128) {
        Self::write_additions(ref world, entity_id, resource_type, balance);
        Self::write_subtractions(ref world, entity_id, resource_type, 0);
    }

    fn read_production(ref world: WorldStorage, entity_id: ID, resource_type: u8) -> Production {
        if RelicResourceImpl::is_relic(resource_type) || resource_type == ResourceTypes::LORDS {
            return Zero::zero();
        }
        return world
            .read_member(Model::<Resource>::ptr_from_keys(entity_id), Self::production_selector(resource_type.into()));
    }


    fn write_additions(ref world: WorldStorage, entity_id: ID, resource_type: u8, additions: u128) {
        world
            .write_member(
                Model::<Resource>::ptr_from_keys(entity_id), Self::additions_selector(resource_type.into()), additions,
            );
    }

    fn write_subtractions(ref world: WorldStorage, entity_id: ID, resource_type: u8, subtractions: u128) {
        world
            .write_member(
                Model::<Resource>::ptr_from_keys(entity_id),
                Self::subtractions_selector(resource_type.into()),
                subtractions,
            );
    }

    fn write_production(ref world: WorldStorage, entity_id: ID, resource_type: u8, production: Production) {
        if RelicResourceImpl::is_relic(resource_type) || resource_type == ResourceTypes::LORDS {
            return;
        }
        world
            .write_member(
                Model::<Resource>::ptr_from_keys(entity_id),
                Self::production_selector(resource_type.into()),
                production,
            );
    }

    fn read_weight(ref world: WorldStorage, entity_id: ID) -> Weight {
        return world.read_member(Model::<Resource>::ptr_from_keys(entity_id), selector!("weight"));
    }

    fn write_weight(ref world: WorldStorage, entity_id: ID, weight: Weight) {
        world.write_member(Model::<Resource>::ptr_from_keys(entity_id), selector!("weight"), weight);
    }

    fn additions_selector(resource_type: felt252) -> felt252 {
        match resource_type {
            0 => panic!("Invalid resource type"),
            1 => selector!("STONE_ADDITIONS"),
            2 => selector!("COAL_ADDITIONS"),
            3 => selector!("WOOD_ADDITIONS"),
            4 => selector!("COPPER_ADDITIONS"),
            5 => selector!("IRONWOOD_ADDITIONS"),
            6 => selector!("OBSIDIAN_ADDITIONS"),
            7 => selector!("GOLD_ADDITIONS"),
            8 => selector!("SILVER_ADDITIONS"),
            9 => selector!("MITHRAL_ADDITIONS"),
            10 => selector!("ALCHEMICAL_SILVER_ADDITIONS"),
            11 => selector!("COLD_IRON_ADDITIONS"),
            12 => selector!("DEEP_CRYSTAL_ADDITIONS"),
            13 => selector!("RUBY_ADDITIONS"),
            14 => selector!("DIAMONDS_ADDITIONS"),
            15 => selector!("HARTWOOD_ADDITIONS"),
            16 => selector!("IGNIUM_ADDITIONS"),
            17 => selector!("TWILIGHT_QUARTZ_ADDITIONS"),
            18 => selector!("TRUE_ICE_ADDITIONS"),
            19 => selector!("ADAMANTINE_ADDITIONS"),
            20 => selector!("SAPPHIRE_ADDITIONS"),
            21 => selector!("ETHEREAL_SILICA_ADDITIONS"),
            22 => selector!("DRAGONHIDE_ADDITIONS"),
            23 => selector!("LABOR_ADDITIONS"),
            24 => selector!("EARTHEN_SHARD_ADDITIONS"),
            25 => selector!("DONKEY_ADDITIONS"),
            26 => selector!("KNIGHT_T1_ADDITIONS"),
            27 => selector!("KNIGHT_T2_ADDITIONS"),
            28 => selector!("KNIGHT_T3_ADDITIONS"),
            29 => selector!("CROSSBOWMAN_T1_ADDITIONS"),
            30 => selector!("CROSSBOWMAN_T2_ADDITIONS"),
            31 => selector!("CROSSBOWMAN_T3_ADDITIONS"),
            32 => selector!("PALADIN_T1_ADDITIONS"),
            33 => selector!("PALADIN_T2_ADDITIONS"),
            34 => selector!("PALADIN_T3_ADDITIONS"),
            35 => selector!("WHEAT_ADDITIONS"),
            36 => selector!("FISH_ADDITIONS"),
            37 => selector!("LORDS_ADDITIONS"),
            38 => selector!("ESSENCE_ADDITIONS"),
            39 => selector!("RELIC_E1_ADDITIONS"),
            40 => selector!("RELIC_E2_ADDITIONS"),
            41 => selector!("RELIC_E3_ADDITIONS"),
            42 => selector!("RELIC_E4_ADDITIONS"),
            43 => selector!("RELIC_E5_ADDITIONS"),
            44 => selector!("RELIC_E6_ADDITIONS"),
            45 => selector!("RELIC_E7_ADDITIONS"),
            46 => selector!("RELIC_E8_ADDITIONS"),
            47 => selector!("RELIC_E9_ADDITIONS"),
            48 => selector!("RELIC_E10_ADDITIONS"),
            49 => selector!("RELIC_E11_ADDITIONS"),
            50 => selector!("RELIC_E12_ADDITIONS"),
            51 => selector!("RELIC_E13_ADDITIONS"),
            52 => selector!("RELIC_E14_ADDITIONS"),
            53 => selector!("RELIC_E15_ADDITIONS"),
            54 => selector!("RELIC_E16_ADDITIONS"),
            55 => selector!("RELIC_E17_ADDITIONS"),
            56 => selector!("RELIC_E18_ADDITIONS"),
            _ => panic!("Invalid resource type"),
        }
    }

    fn subtractions_selector(resource_type: felt252) -> felt252 {
        match resource_type {
            0 => panic!("Invalid resource type"),
            1 => selector!("STONE_SUBTRACTIONS"),
            2 => selector!("COAL_SUBTRACTIONS"),
            3 => selector!("WOOD_SUBTRACTIONS"),
            4 => selector!("COPPER_SUBTRACTIONS"),
            5 => selector!("IRONWOOD_SUBTRACTIONS"),
            6 => selector!("OBSIDIAN_SUBTRACTIONS"),
            7 => selector!("GOLD_SUBTRACTIONS"),
            8 => selector!("SILVER_SUBTRACTIONS"),
            9 => selector!("MITHRAL_SUBTRACTIONS"),
            10 => selector!("ALCHEMICAL_SILVER_SUBTRACTIONS"),
            11 => selector!("COLD_IRON_SUBTRACTIONS"),
            12 => selector!("DEEP_CRYSTAL_SUBTRACTIONS"),
            13 => selector!("RUBY_SUBTRACTIONS"),
            14 => selector!("DIAMONDS_SUBTRACTIONS"),
            15 => selector!("HARTWOOD_SUBTRACTIONS"),
            16 => selector!("IGNIUM_SUBTRACTIONS"),
            17 => selector!("TWILIGHT_QUARTZ_SUBTRACTIONS"),
            18 => selector!("TRUE_ICE_SUBTRACTIONS"),
            19 => selector!("ADAMANTINE_SUBTRACTIONS"),
            20 => selector!("SAPPHIRE_SUBTRACTIONS"),
            21 => selector!("ETHEREAL_SILICA_SUBTRACTIONS"),
            22 => selector!("DRAGONHIDE_SUBTRACTIONS"),
            23 => selector!("LABOR_SUBTRACTIONS"),
            24 => selector!("EARTHEN_SHARD_SUBTRACTIONS"),
            25 => selector!("DONKEY_SUBTRACTIONS"),
            26 => selector!("KNIGHT_T1_SUBTRACTIONS"),
            27 => selector!("KNIGHT_T2_SUBTRACTIONS"),
            28 => selector!("KNIGHT_T3_SUBTRACTIONS"),
            29 => selector!("CROSSBOWMAN_T1_SUBTRACTIONS"),
            30 => selector!("CROSSBOWMAN_T2_SUBTRACTIONS"),
            31 => selector!("CROSSBOWMAN_T3_SUBTRACTIONS"),
            32 => selector!("PALADIN_T1_SUBTRACTIONS"),
            33 => selector!("PALADIN_T2_SUBTRACTIONS"),
            34 => selector!("PALADIN_T3_SUBTRACTIONS"),
            35 => selector!("WHEAT_SUBTRACTIONS"),
            36 => selector!("FISH_SUBTRACTIONS"),
            37 => selector!("LORDS_SUBTRACTIONS"),
            38 => selector!("ESSENCE_SUBTRACTIONS"),
            39 => selector!("RELIC_E1_SUBTRACTIONS"),
            40 => selector!("RELIC_E2_SUBTRACTIONS"),
            41 => selector!("RELIC_E3_SUBTRACTIONS"),
            42 => selector!("RELIC_E4_SUBTRACTIONS"),
            43 => selector!("RELIC_E5_SUBTRACTIONS"),
            44 => selector!("RELIC_E6_SUBTRACTIONS"),
            45 => selector!("RELIC_E7_SUBTRACTIONS"),
            46 => selector!("RELIC_E8_SUBTRACTIONS"),
            47 => selector!("RELIC_E9_SUBTRACTIONS"),
            48 => selector!("RELIC_E10_SUBTRACTIONS"),
            49 => selector!("RELIC_E11_SUBTRACTIONS"),
            50 => selector!("RELIC_E12_SUBTRACTIONS"),
            51 => selector!("RELIC_E13_SUBTRACTIONS"),
            52 => selector!("RELIC_E14_SUBTRACTIONS"),
            53 => selector!("RELIC_E15_SUBTRACTIONS"),
            54 => selector!("RELIC_E16_SUBTRACTIONS"),
            55 => selector!("RELIC_E17_SUBTRACTIONS"),
            56 => selector!("RELIC_E18_SUBTRACTIONS"),
            _ => panic!("Invalid resource type"),
        }
    }


    fn production_selector(resource_type: felt252) -> felt252 {
        match resource_type {
            0 => panic!("Invalid resource type"),
            1 => selector!("STONE_PRODUCTION"),
            2 => selector!("COAL_PRODUCTION"),
            3 => selector!("WOOD_PRODUCTION"),
            4 => selector!("COPPER_PRODUCTION"),
            5 => selector!("IRONWOOD_PRODUCTION"),
            6 => selector!("OBSIDIAN_PRODUCTION"),
            7 => selector!("GOLD_PRODUCTION"),
            8 => selector!("SILVER_PRODUCTION"),
            9 => selector!("MITHRAL_PRODUCTION"),
            10 => selector!("ALCHEMICAL_SILVER_PRODUCTION"),
            11 => selector!("COLD_IRON_PRODUCTION"),
            12 => selector!("DEEP_CRYSTAL_PRODUCTION"),
            13 => selector!("RUBY_PRODUCTION"),
            14 => selector!("DIAMONDS_PRODUCTION"),
            15 => selector!("HARTWOOD_PRODUCTION"),
            16 => selector!("IGNIUM_PRODUCTION"),
            17 => selector!("TWILIGHT_QUARTZ_PRODUCTION"),
            18 => selector!("TRUE_ICE_PRODUCTION"),
            19 => selector!("ADAMANTINE_PRODUCTION"),
            20 => selector!("SAPPHIRE_PRODUCTION"),
            21 => selector!("ETHEREAL_SILICA_PRODUCTION"),
            22 => selector!("DRAGONHIDE_PRODUCTION"),
            23 => selector!("LABOR_PRODUCTION"),
            24 => selector!("EARTHEN_SHARD_PRODUCTION"),
            25 => selector!("DONKEY_PRODUCTION"),
            26 => selector!("KNIGHT_T1_PRODUCTION"),
            27 => selector!("KNIGHT_T2_PRODUCTION"),
            28 => selector!("KNIGHT_T3_PRODUCTION"),
            29 => selector!("CROSSBOWMAN_T1_PRODUCTION"),
            30 => selector!("CROSSBOWMAN_T2_PRODUCTION"),
            31 => selector!("CROSSBOWMAN_T3_PRODUCTION"),
            32 => selector!("PALADIN_T1_PRODUCTION"),
            33 => selector!("PALADIN_T2_PRODUCTION"),
            34 => selector!("PALADIN_T3_PRODUCTION"),
            35 => selector!("WHEAT_PRODUCTION"),
            36 => selector!("FISH_PRODUCTION"),
            37 => selector!("LORDS_PRODUCTION"),
            38 => selector!("ESSENCE_PRODUCTION"),
            _ => panic!("Invalid resource type"),
        }
    }

    fn key_only(entity_id: ID) -> Resource {
        let mut model: Resource = Default::default();
        model.entity_id = entity_id;
        return model;
    }
}


#[derive(IntrospectPacked, Copy, Drop, Serde)]
#[dojo::model]
pub struct ResourceAllowance {
    #[key]
    pub owner_entity_id: ID,
    #[key]
    pub approved_entity_id: ID,
    #[key]
    pub resource_type: u8,
    pub amount: u128,
}

#[derive(Introspect, Copy, Drop, Serde)]
#[dojo::model]
pub struct ResourceList {
    #[key]
    pub entity_id: ID,
    #[key]
    pub index: u32,
    pub resource_type: u8,
    pub amount: u128,
}


#[derive(Introspect, Copy, Drop, Serde)]
#[dojo::model]
pub struct ResourceMinMaxList {
    #[key]
    pub entity_id: ID,
    #[key]
    pub index: u32,
    pub resource_type: u8,
    pub min_amount: u128,
    pub max_amount: u128,
}
