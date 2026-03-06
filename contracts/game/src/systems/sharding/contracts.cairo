use crate::alias::ID;
use dojo::sharding::request::ShardModel;

#[starknet::interface]
pub trait IShardingSystems<T> {
    fn request_shard(ref self: T, proxy: starknet::ContractAddress, models: Span<ShardModel>);
    fn request_shard_all(ref self: T, proxy: starknet::ContractAddress, entity_ids: Span<ID>);
    fn finish_shard(ref self: T);
}

pub mod shard_helpers {
    use dojo::model::Model;
    use dojo::sharding::request::{CRDVariant, IntoShardField, IntoShardModel, ShardField, ShardModel};
    use crate::alias::ID;
    use crate::models::resource::resource::{Resource, ResourceImpl};
    use crate::models::structure::{
        Structure, Structure_fields, Wonder, StructureVillageSlots, VillageTroop, VillageRaidImmunity,
    };
    use crate::models::resource::production::building::{Building, StructureBuildings};
    use crate::models::resource::production::production::ProductionBoostBonus;
    use crate::models::resource::resource::{ResourceAllowance, ResourceList};
    use crate::models::trade::{Trade, TradeCount};
    use crate::models::resource::arrivals::ResourceArrival;
    use crate::models::quantity::{Quantity, QuantityTracker};
    use crate::models::troop::ExplorerTroops;
    use crate::models::hyperstructure::{HyperstructureRequirements, PlayerConstructionPoints};
    use crate::models::bank::market::Market;
    use crate::models::bank::liquidity::Liquidity;

    const RESOURCE_TYPE_COUNT: u32 = 56;

    pub fn resource_with_set_lock(ns_hash: felt252, entity_id: ID, resource_types: Span<u32>) -> ShardModel {
        assert!(resource_types.len() > 0, "resource_types must not be empty");
        let keys = array![entity_id.into()].span();
        let mut fields: Array<ShardField> = ArrayTrait::new();
        for resource_type in resource_types {
            let resource_type = *resource_type;
            assert!(
                resource_type >= 1 && resource_type <= RESOURCE_TYPE_COUNT, "resource_type must be 1..=56, got invalid",
            );
            fields.append(ShardField {
                selector: ResourceImpl::balance_selector(resource_type.into()),
                crdt: CRDVariant::SetLock,
            });
        };
        ShardModel { selector: Model::<Resource>::selector(ns_hash), keys, fields: fields.span() }
    }

    pub fn resource_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Resource>::selector(ns_hash), Model::<Resource>::layout()).shard(keys)
    }

    pub fn structure_with_field_crdts(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        ShardModel {
            selector: Model::<Structure>::selector(ns_hash),
            keys,
            fields: [
                Structure_fields::OWNER.as_lock(),
                Structure_fields::BASE.as_set(),
                Structure_fields::METADATA.as_set_lock(),
            ].span(),
        }
    }

    pub fn structure_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Structure>::selector(ns_hash), Model::<Structure>::layout()).shard(keys)
    }

    pub fn structure_buildings_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<StructureBuildings>::selector(ns_hash), Model::<StructureBuildings>::layout()).shard(keys)
    }

    pub fn production_boost_bonus_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<ProductionBoostBonus>::selector(ns_hash), Model::<ProductionBoostBonus>::layout()).shard(keys)
    }

    pub fn village_troop_all(ns_hash: felt252, village_id: ID) -> ShardModel {
        let keys = array![village_id.into()].span();
        (Model::<VillageTroop>::selector(ns_hash), Model::<VillageTroop>::layout()).shard(keys)
    }

    pub fn village_raid_immunity_all(ns_hash: felt252, village_id: ID) -> ShardModel {
        let keys = array![village_id.into()].span();
        (Model::<VillageRaidImmunity>::selector(ns_hash), Model::<VillageRaidImmunity>::layout()).shard(keys)
    }

    pub fn trade_count_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<TradeCount>::selector(ns_hash), Model::<TradeCount>::layout()).shard(keys)
    }

    pub fn quantity_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Quantity>::selector(ns_hash), Model::<Quantity>::layout()).shard(keys)
    }

    pub fn wonder_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<Wonder>::selector(ns_hash), Model::<Wonder>::layout()).shard(keys)
    }

    pub fn structure_village_slots_all(ns_hash: felt252, realm_entity_id: ID) -> ShardModel {
        let keys = array![realm_entity_id.into()].span();
        (Model::<StructureVillageSlots>::selector(ns_hash), Model::<StructureVillageSlots>::layout()).shard(keys)
    }

    pub fn quantity_tracker_all(ns_hash: felt252, entity_id: felt252) -> ShardModel {
        let keys = array![entity_id].span();
        (Model::<QuantityTracker>::selector(ns_hash), Model::<QuantityTracker>::layout()).shard(keys)
    }

    pub fn resource_allowance_all(
        ns_hash: felt252, owner_entity_id: ID, approved_entity_id: ID, resource_type: u8,
    ) -> ShardModel {
        let keys = array![owner_entity_id.into(), approved_entity_id.into(), resource_type.into()].span();
        (Model::<ResourceAllowance>::selector(ns_hash), Model::<ResourceAllowance>::layout()).shard(keys)
    }

    pub fn resource_list_all(ns_hash: felt252, entity_id: ID, index: u32) -> ShardModel {
        let keys = array![entity_id.into(), index.into()].span();
        (Model::<ResourceList>::selector(ns_hash), Model::<ResourceList>::layout()).shard(keys)
    }

    pub fn hyperstructure_requirements_all(ns_hash: felt252, hyperstructure_id: ID) -> ShardModel {
        let keys = array![hyperstructure_id.into()].span();
        (Model::<HyperstructureRequirements>::selector(ns_hash), Model::<HyperstructureRequirements>::layout())
            .shard(keys)
    }

    pub fn player_construction_points_all(
        ns_hash: felt252, address: starknet::ContractAddress, hyperstructure_id: ID,
    ) -> ShardModel {
        let keys = array![address.into(), hyperstructure_id.into()].span();
        (Model::<PlayerConstructionPoints>::selector(ns_hash), Model::<PlayerConstructionPoints>::layout()).shard(keys)
    }

    pub fn building_all(
        ns_hash: felt252, outer_col: u32, outer_row: u32, inner_col: u32, inner_row: u32,
    ) -> ShardModel {
        let keys = array![outer_col.into(), outer_row.into(), inner_col.into(), inner_row.into()].span();
        (Model::<Building>::selector(ns_hash), Model::<Building>::layout()).shard(keys)
    }

    pub fn explorer_troops_all(ns_hash: felt252, explorer_id: ID) -> ShardModel {
        let keys = array![explorer_id.into()].span();
        (Model::<ExplorerTroops>::selector(ns_hash), Model::<ExplorerTroops>::layout()).shard(keys)
    }

    pub fn trade_all(ns_hash: felt252, trade_id: ID) -> ShardModel {
        let keys = array![trade_id.into()].span();
        (Model::<Trade>::selector(ns_hash), Model::<Trade>::layout()).shard(keys)
    }

    pub fn resource_arrival_all(ns_hash: felt252, structure_id: ID, day: u64) -> ShardModel {
        let keys = array![structure_id.into(), day.into()].span();
        (Model::<ResourceArrival>::selector(ns_hash), Model::<ResourceArrival>::layout()).shard(keys)
    }

    pub fn market_all(ns_hash: felt252, resource_type: u8) -> ShardModel {
        let keys = array![resource_type.into()].span();
        (Model::<Market>::selector(ns_hash), Model::<Market>::layout()).shard(keys)
    }

    pub fn liquidity_all(
        ns_hash: felt252, player: starknet::ContractAddress, resource_type: u8,
    ) -> ShardModel {
        let keys = array![player.into(), resource_type.into()].span();
        (Model::<Liquidity>::selector(ns_hash), Model::<Liquidity>::layout()).shard(keys)
    }

    /// Even-row hex neighbors of building center (10,10):
    /// E(11,10) NE(11,11) NW(10,11) W(9,10) SW(10,9) SE(11,9)
    pub fn building_ring1(
        ns_hash: felt252, outer_col: u32, outer_row: u32,
    ) -> Array<ShardModel> {
        array![
            building_all(ns_hash, outer_col, outer_row, 11, 10),
            building_all(ns_hash, outer_col, outer_row, 11, 11),
            building_all(ns_hash, outer_col, outer_row, 10, 11),
            building_all(ns_hash, outer_col, outer_row, 9, 10),
            building_all(ns_hash, outer_col, outer_row, 10, 9),
            building_all(ns_hash, outer_col, outer_row, 11, 9),
        ]
    }

    /// Models keyed by entity_id only. Models with composite keys
    /// (Building, Trade, ResourceArrival, Market, Liquidity, etc.)
    /// must be registered separately via their individual helpers.
    pub fn entity_id_models(ns_hash: felt252, entity_id: ID) -> Array<ShardModel> {
        array![
            resource_all(ns_hash, entity_id),
            structure_all(ns_hash, entity_id),
            structure_buildings_all(ns_hash, entity_id),
            production_boost_bonus_all(ns_hash, entity_id),
            trade_count_all(ns_hash, entity_id),
            village_troop_all(ns_hash, entity_id),
            village_raid_immunity_all(ns_hash, entity_id),
            quantity_all(ns_hash, entity_id),
            wonder_all(ns_hash, entity_id),
            structure_village_slots_all(ns_hash, entity_id),
        ]
    }
}

#[dojo::contract]
pub mod sharding_systems {
    use dojo::sharding::request::ShardModel;
    use dojo::world::IWorldDispatcherTrait;
    use core::num::traits::Zero;
    use crate::alias::ID;
    use crate::constants::DEFAULT_NS;
    use crate::models::structure::{StructureBaseStoreImpl, StructureBaseTrait};
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;

    fn assert_valid_proxy(proxy: starknet::ContractAddress) {
        assert!(proxy.is_non_zero(), "proxy must not be zero");
    }

    #[abi(embed_v0)]
    impl ShardingSystemsImpl of super::IShardingSystems<ContractState> {
        fn request_shard(
            ref self: ContractState, proxy: starknet::ContractAddress, models: Span<ShardModel>,
        ) {
            assert_valid_proxy(proxy);
            assert!(models.len() > 0, "models must not be empty");
            let world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            world.dispatcher.request_sharding(proxy, models);
        }

        fn request_shard_all(
            ref self: ContractState, proxy: starknet::ContractAddress, entity_ids: Span<ID>,
        ) {
            assert_valid_proxy(proxy);
            assert!(entity_ids.len() > 0, "entity_ids must not be empty");

            let mut world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            let ns_hash = dojo::utils::bytearray_hash(DEFAULT_NS());

            let mut shard_models: Array<ShardModel> = ArrayTrait::new();
            for entity_id in entity_ids {
                for shard_model in super::shard_helpers::entity_id_models(ns_hash, *entity_id) {
                    shard_models.append(shard_model);
                };

                let base = StructureBaseStoreImpl::retrieve(ref world, *entity_id);
                if base.exists() {
                    for shard_model in super::shard_helpers::building_ring1(ns_hash, base.coord_x, base.coord_y) {
                        shard_models.append(shard_model);
                    };
                }
            };
            assert!(shard_models.len() > 0, "shard_models must not be empty");
            world.dispatcher.request_sharding(proxy, shard_models.span());
        }

        fn finish_shard(ref self: ContractState) {
            let world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            world.dispatcher.end_shard();
        }
    }
}
