use crate::alias::ID;
use dojo::sharding::request::ShardModel;

#[starknet::interface]
pub trait IShardingSystems<T> {
    fn request_shard(ref self: T, proxy: starknet::ContractAddress, models: Span<ShardModel>);
    fn request_shard_all(ref self: T, proxy: starknet::ContractAddress, entity_ids: Span<ID>);
    fn request_shard_all_with_related_ids(
        ref self: T,
        proxy: starknet::ContractAddress,
        entity_ids: Span<ID>,
        explorer_ids: Span<ID>,
        trade_ids: Span<ID>,
        hyperstructure_ids: Span<ID>,
    );
    fn finish_shard(ref self: T);
}

pub mod shard_helpers {
    use dojo::meta::Layout;
    use dojo::model::Model;
    use dojo::sharding::request::{
        CRDVariant, IntoShardField, IntoShardModel, ShardCoverage, ShardField, ShardFieldSelection, ShardModel,
    };
    use crate::alias::ID;
    use crate::models::resource::resource::{Resource, ResourceImpl};
    use crate::models::structure::{
        Structure, Structure_fields, Wonder, StructureVillageSlots, VillageTroop, VillageRaidImmunity,
    };
    use crate::models::position::CoordTrait;
    use crate::models::resource::production::building::{Building, BuildingImpl, StructureBuildings};
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

    fn shard_set_lock_deterministic(selector: felt252, layout: Layout, keys: Span<felt252>) -> ShardModel {
        (selector, layout).shard_with(keys, CRDVariant::SetLock, ShardFieldSelection::AutoDeterministic)
    }

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
        ShardModel {
            selector: Model::<Resource>::selector(ns_hash),
            keys,
            fields: fields.span(),
            coverage: ShardCoverage::DeterministicSubset,
        }
    }

    pub fn resource_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Resource>::selector(ns_hash), Model::<Resource>::layout()).shard(keys)
    }

    /// Lock all resource balances for a shard session.
    /// This prevents spending/building on main chain while the shard is active.
    pub fn resource_all_balances_set_lock(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let mut resource_types: Array<u32> = ArrayTrait::new();
        let mut resource_type: u32 = 1;
        loop {
            if resource_type > RESOURCE_TYPE_COUNT {
                break;
            }
            resource_types.append(resource_type);
            resource_type += 1;
        };
        resource_with_set_lock(ns_hash, entity_id, resource_types.span())
    }

    pub fn structure_with_field_crdts(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        ShardModel {
            selector: Model::<Structure>::selector(ns_hash),
            keys,
            fields: [
                Structure_fields::OWNER.as_lock(),
                Structure_fields::BASE.as_set_lock(),
                Structure_fields::METADATA.as_set_lock(),
            ].span(),
            coverage: ShardCoverage::DeterministicSubset,
        }
    }

    pub fn structure_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Structure>::selector(ns_hash), Model::<Structure>::layout()).shard(keys)
    }

    pub fn structure_buildings_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        shard_set_lock_deterministic(
            Model::<StructureBuildings>::selector(ns_hash), Model::<StructureBuildings>::layout(), keys,
        )
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
        shard_set_lock_deterministic(Model::<Quantity>::selector(ns_hash), Model::<Quantity>::layout(), keys)
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
        shard_set_lock_deterministic(
            Model::<QuantityTracker>::selector(ns_hash), Model::<QuantityTracker>::layout(), keys,
        )
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
        shard_set_lock_deterministic(Model::<Building>::selector(ns_hash), Model::<Building>::layout(), keys)
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

    /// Register all possible building slots from ring-1 up to `max_distance`
    /// around the local structure center (10,10).
    pub fn building_within_distance(
        ns_hash: felt252, outer_col: u32, outer_row: u32, max_distance: u32,
    ) -> Array<ShardModel> {
        let mut models: Array<ShardModel> = ArrayTrait::new();
        if max_distance == 0 {
            return models;
        }

        let center = BuildingImpl::center();
        let mut distance: u32 = 1;
        loop {
            if distance > max_distance {
                break;
            }

            let ring = center.ring(distance);
            for inner_coord in ring {
                models.append(building_all(ns_hash, outer_col, outer_row, inner_coord.x, inner_coord.y));
            };

            distance += 1;
        };

        models
    }

    /// Models keyed by the same `entity_id` passed to `request_shard_all`.
    /// Models keyed by other ids (e.g. explorer_id, trade_id, hyperstructure_id)
    /// and models with composite keys (Building, ResourceArrival, Market, Liquidity, etc.)
    /// must be registered separately via dedicated helpers.
    pub fn entity_id_models(ns_hash: felt252, entity_id: ID) -> Array<ShardModel> {
        array![
            resource_all_balances_set_lock(ns_hash, entity_id),
            structure_with_field_crdts(ns_hash, entity_id),
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

    pub fn max_resource_type() -> u8 {
        RESOURCE_TYPE_COUNT.try_into().unwrap()
    }
}

#[dojo::contract]
pub mod sharding_systems {
    use dojo::sharding::request::ShardModel;
    use dojo::world::{IWorldDispatcherTrait, WorldStorage};
    use core::num::traits::Zero;
    use crate::alias::ID;
    use crate::constants::DEFAULT_NS;
    use crate::models::config::TickImpl;
    use crate::models::resource::arrivals::ResourceArrivalImpl;
    use crate::models::structure::{StructureBaseStoreImpl, StructureBaseTrait, StructureOwnerStoreImpl};
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;

    const MAX_REQUEST_ENTITY_IDS: usize = 1;
    const MAX_REQUEST_RELATED_IDS: usize = 512;
    const MAX_SHARD_MODELS_PER_REQUEST: usize = 4096;

    fn assert_valid_proxy(proxy: starknet::ContractAddress) {
        assert!(proxy.is_non_zero(), "proxy must not be zero");
    }

    fn append_shard_model(ref shard_models: Array<ShardModel>, shard_model: ShardModel) {
        assert!(shard_models.len() < MAX_SHARD_MODELS_PER_REQUEST, "shard_models exceeds limit");
        shard_models.append(shard_model);
    }

    fn build_shard_models_for_entities(ref world: WorldStorage, entity_ids: Span<ID>) -> Array<ShardModel> {
        assert!(entity_ids.len() > 0, "entity_ids must not be empty");
        assert!(entity_ids.len() <= MAX_REQUEST_ENTITY_IDS, "entity_ids exceeds limit");

        let ns_hash = dojo::utils::bytearray_hash(DEFAULT_NS());
        let delivery_interval = TickImpl::get_delivery_tick_interval(ref world).interval();
        let register_arrivals = delivery_interval.is_non_zero();
        let mut arrival_day: u64 = 0;
        if register_arrivals {
            let (day, _) = ResourceArrivalImpl::arrival_slot(ref world, 0);
            arrival_day = day;
        }

        let mut shard_models: Array<ShardModel> = ArrayTrait::new();
        let mut ids: Array<ID> = ArrayTrait::new();
        let mut structure_owners: Array<starknet::ContractAddress> = ArrayTrait::new();
        for entity_id in entity_ids {
            ids.append(*entity_id);

            for shard_model in super::shard_helpers::entity_id_models(ns_hash, *entity_id) {
                append_shard_model(ref shard_models, shard_model);
            };

            append_shard_model(
                ref shard_models, super::shard_helpers::quantity_tracker_all(ns_hash, (*entity_id).into()),
            );
            if register_arrivals {
                append_shard_model(
                    ref shard_models, super::shard_helpers::resource_arrival_all(ns_hash, *entity_id, arrival_day),
                );
                if arrival_day.is_non_zero() {
                    append_shard_model(
                        ref shard_models,
                        super::shard_helpers::resource_arrival_all(ns_hash, *entity_id, arrival_day - 1),
                    );
                }
                append_shard_model(
                    ref shard_models,
                    super::shard_helpers::resource_arrival_all(ns_hash, *entity_id, arrival_day + 1),
                );
            }
            let base = StructureBaseStoreImpl::retrieve(ref world, *entity_id);
            if base.exists() {
                let owner = StructureOwnerStoreImpl::retrieve(ref world, *entity_id);
                if owner.is_non_zero() {
                    structure_owners.append(owner);
                    append_shard_model(
                        ref shard_models,
                        super::shard_helpers::player_construction_points_all(ns_hash, owner, *entity_id),
                    );
                }

                let max_building_distance: u32 = base.max_level(world).into() + 1;
                for shard_model in super::shard_helpers::building_within_distance(
                    ns_hash, base.coord_x, base.coord_y, max_building_distance,
                ) {
                    append_shard_model(ref shard_models, shard_model);
                };
            }
        };

        let max_resource_type = super::shard_helpers::max_resource_type();
        let mut resource_type: u8 = 1;
        loop {
            if resource_type > max_resource_type {
                break;
            }

            append_shard_model(ref shard_models, super::shard_helpers::market_all(ns_hash, resource_type));

            for owner in structure_owners.span() {
                append_shard_model(ref shard_models, super::shard_helpers::liquidity_all(ns_hash, *owner, resource_type));
            };

            for owner_entity_id in ids.span() {
                for approved_entity_id in ids.span() {
                    append_shard_model(
                        ref shard_models,
                        super::shard_helpers::resource_allowance_all(
                            ns_hash, *owner_entity_id, *approved_entity_id, resource_type,
                        ),
                    );
                };
            };

            resource_type += 1;
        };

        assert!(shard_models.len() > 0, "shard_models must not be empty");
        shard_models
    }

    fn append_related_shard_models(
        ns_hash: felt252,
        ref shard_models: Array<ShardModel>,
        explorer_ids: Span<ID>,
        trade_ids: Span<ID>,
        hyperstructure_ids: Span<ID>,
    ) {
        assert!(explorer_ids.len() <= MAX_REQUEST_RELATED_IDS, "explorer_ids exceeds limit");
        assert!(trade_ids.len() <= MAX_REQUEST_RELATED_IDS, "trade_ids exceeds limit");
        assert!(hyperstructure_ids.len() <= MAX_REQUEST_RELATED_IDS, "hyperstructure_ids exceeds limit");

        for explorer_id in explorer_ids {
            append_shard_model(
                ref shard_models, super::shard_helpers::explorer_troops_all(ns_hash, *explorer_id),
            );
        };

        for trade_id in trade_ids {
            append_shard_model(ref shard_models, super::shard_helpers::trade_all(ns_hash, *trade_id));
        };

        for hyperstructure_id in hyperstructure_ids {
            append_shard_model(
                ref shard_models,
                super::shard_helpers::hyperstructure_requirements_all(ns_hash, *hyperstructure_id),
            );
        };
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

            let mut world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            let mut shard_models = build_shard_models_for_entities(ref world, entity_ids);
            world.dispatcher.request_sharding(proxy, shard_models.span());
        }

        fn request_shard_all_with_related_ids(
            ref self: ContractState,
            proxy: starknet::ContractAddress,
            entity_ids: Span<ID>,
            explorer_ids: Span<ID>,
            trade_ids: Span<ID>,
            hyperstructure_ids: Span<ID>,
        ) {
            assert_valid_proxy(proxy);

            let mut world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            let ns_hash = dojo::utils::bytearray_hash(DEFAULT_NS());
            let mut shard_models = build_shard_models_for_entities(ref world, entity_ids);
            append_related_shard_models(
                ns_hash, ref shard_models, explorer_ids, trade_ids, hyperstructure_ids,
            );
            world.dispatcher.request_sharding(proxy, shard_models.span());
        }

        fn finish_shard(ref self: ContractState) {
            let world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            world.dispatcher.end_shard();
        }
    }
}
