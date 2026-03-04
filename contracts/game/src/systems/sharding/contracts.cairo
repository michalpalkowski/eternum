use crate::alias::ID;
use dojo::sharding::request::ShardModel;

#[starknet::interface]
pub trait IShardingSystems<T> {
    /// Generic shard request — caller provides pre-built ShardModels with any CRDT configuration.
    ///
    /// Use `shard_helpers` module to compose ShardModel arrays, or build them manually.
    fn request_shard(ref self: T, proxy: starknet::ContractAddress, models: Span<ShardModel>);

    /// Shard ALL game models for given entities with default Set CRDT.
    ///
    /// Convenience for development/prototyping — shards every field of every known
    /// game model (Resource, Structure, …) using Set (direct overwrite) semantics.
    /// For production, use `request_shard` with specific CRDTs per field.
    fn request_shard_all(ref self: T, proxy: starknet::ContractAddress, entity_ids: Span<ID>);

    /// End the current shard session. Forwards to the sharding proxy.
    fn finish_shard(ref self: T);
}

/// Composable helpers for building ShardModel arrays per Eternum model.
///
/// Two variants per model:
/// - `resource()`, `structure()` — production CRDTs (SetLock, Lock, Set per field)
/// - `resource_all()`, `structure_all()` — default Set CRDT on ALL fields (dev/prototyping)
///
/// # Example — production campaign
/// ```cairo
/// let mut models = array![];
/// for id in entity_ids {
///     models.append(shard_helpers::resource(ns_hash, *id, resource_indices));
///     models.append(shard_helpers::structure(ns_hash, *id));
/// };
/// dispatcher.request_shard(proxy, models.span());
/// ```
///
/// # Example — shard everything for dev
/// ```cairo
/// dispatcher.request_shard_all(proxy, entity_ids);
/// ```
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

    const MAX_RESOURCE_TYPE: u32 = 56;

    // ── Resource ──────────────────────────────────────────────────────

    /// Resource model — selected balance fields with SetLock CRDT (production).
    pub fn resource(ns_hash: felt252, entity_id: ID, resource_indices: Span<u32>) -> ShardModel {
        let keys = array![entity_id.into()].span();
        let mut fields: Array<ShardField> = ArrayTrait::new();
        for idx in resource_indices {
            let idx = *idx;
            assert!(idx >= 1 && idx <= MAX_RESOURCE_TYPE, "resource_index must be 1-56");
            fields.append(ShardField {
                selector: ResourceImpl::balance_selector(idx.into()),
                crdt: CRDVariant::SetLock,
            });
        };
        ShardModel { selector: Model::<Resource>::selector(ns_hash), keys, fields: fields.span() }
    }

    /// Resource model — ALL fields with default Set CRDT (dev/prototyping).
    pub fn resource_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Resource>::selector(ns_hash), Model::<Resource>::layout()).shard(keys)
    }

    // ── Structure ─────────────────────────────────────────────────────

    /// Structure model — mixed CRDTs per field (production).
    pub fn structure(ns_hash: felt252, entity_id: ID) -> ShardModel {
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

    /// Structure model — ALL fields with default Set CRDT (dev/prototyping).
    pub fn structure_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Structure>::selector(ns_hash), Model::<Structure>::layout()).shard(keys)
    }

    // ── StructureBuildings ────────────────────────────────────────────

    pub fn structure_buildings_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<StructureBuildings>::selector(ns_hash), Model::<StructureBuildings>::layout())
            .shard(keys)
    }

    // ── ProductionBoostBonus ──────────────────────────────────────────

    pub fn production_boost_bonus_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<ProductionBoostBonus>::selector(ns_hash), Model::<ProductionBoostBonus>::layout())
            .shard(keys)
    }

    // ── VillageTroop ──────────────────────────────────────────────────

    pub fn village_troop_all(ns_hash: felt252, village_id: ID) -> ShardModel {
        let keys = array![village_id.into()].span();
        (Model::<VillageTroop>::selector(ns_hash), Model::<VillageTroop>::layout()).shard(keys)
    }

    // ── VillageRaidImmunity ───────────────────────────────────────────

    pub fn village_raid_immunity_all(ns_hash: felt252, village_id: ID) -> ShardModel {
        let keys = array![village_id.into()].span();
        (Model::<VillageRaidImmunity>::selector(ns_hash), Model::<VillageRaidImmunity>::layout())
            .shard(keys)
    }

    // ── TradeCount (packed) ─────────────────────────────────────────────

    pub fn trade_count_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<TradeCount>::selector(ns_hash), Model::<TradeCount>::layout()).shard(keys)
    }

    // ── Quantity (packed) ─────────────────────────────────────────────

    pub fn quantity_all(ns_hash: felt252, entity_id: ID) -> ShardModel {
        let keys = array![entity_id.into()].span();
        (Model::<Quantity>::selector(ns_hash), Model::<Quantity>::layout()).shard(keys)
    }

    // ── Wonder ─────────────────────────────────────────────────────────

    pub fn wonder_all(ns_hash: felt252, structure_id: ID) -> ShardModel {
        let keys = array![structure_id.into()].span();
        (Model::<Wonder>::selector(ns_hash), Model::<Wonder>::layout()).shard(keys)
    }

    // ── StructureVillageSlots ─────────────────────────────────────────

    pub fn structure_village_slots_all(ns_hash: felt252, realm_entity_id: ID) -> ShardModel {
        let keys = array![realm_entity_id.into()].span();
        (Model::<StructureVillageSlots>::selector(ns_hash), Model::<StructureVillageSlots>::layout())
            .shard(keys)
    }

    // ── QuantityTracker (packed, keyed by felt252) ────────────────────

    pub fn quantity_tracker_all(ns_hash: felt252, entity_id: felt252) -> ShardModel {
        let keys = array![entity_id].span();
        (Model::<QuantityTracker>::selector(ns_hash), Model::<QuantityTracker>::layout()).shard(keys)
    }

    // ── ResourceAllowance (packed, 3 keys) ────────────────────────────

    pub fn resource_allowance_all(
        ns_hash: felt252, owner_entity_id: ID, approved_entity_id: ID, resource_type: u8,
    ) -> ShardModel {
        let keys = array![owner_entity_id.into(), approved_entity_id.into(), resource_type.into()]
            .span();
        (Model::<ResourceAllowance>::selector(ns_hash), Model::<ResourceAllowance>::layout())
            .shard(keys)
    }

    // ── ResourceList (composite key: entity_id + index) ───────────────

    pub fn resource_list_all(ns_hash: felt252, entity_id: ID, index: u32) -> ShardModel {
        let keys = array![entity_id.into(), index.into()].span();
        (Model::<ResourceList>::selector(ns_hash), Model::<ResourceList>::layout()).shard(keys)
    }

    // ── HyperstructureRequirements (keyed by hyperstructure_id) ───────

    pub fn hyperstructure_requirements_all(ns_hash: felt252, hyperstructure_id: ID) -> ShardModel {
        let keys = array![hyperstructure_id.into()].span();
        (Model::<HyperstructureRequirements>::selector(ns_hash), Model::<HyperstructureRequirements>::layout())
            .shard(keys)
    }

    // ── PlayerConstructionPoints (composite key: address + hyperstructure_id)

    pub fn player_construction_points_all(
        ns_hash: felt252, address: starknet::ContractAddress, hyperstructure_id: ID,
    ) -> ShardModel {
        let keys = array![address.into(), hyperstructure_id.into()].span();
        (Model::<PlayerConstructionPoints>::selector(ns_hash), Model::<PlayerConstructionPoints>::layout())
            .shard(keys)
    }

    // ── Building (multi-key) ──────────────────────────────────────────

    pub fn building_all(
        ns_hash: felt252, outer_col: u32, outer_row: u32, inner_col: u32, inner_row: u32,
    ) -> ShardModel {
        let keys = array![outer_col.into(), outer_row.into(), inner_col.into(), inner_row.into()]
            .span();
        (Model::<Building>::selector(ns_hash), Model::<Building>::layout()).shard(keys)
    }

    // ── ExplorerTroops (keyed by explorer_id) ─────────────────────────

    pub fn explorer_troops_all(ns_hash: felt252, explorer_id: ID) -> ShardModel {
        let keys = array![explorer_id.into()].span();
        (Model::<ExplorerTroops>::selector(ns_hash), Model::<ExplorerTroops>::layout()).shard(keys)
    }

    // ── Trade (packed, keyed by trade_id) ────────────────────────────

    pub fn trade_all(ns_hash: felt252, trade_id: ID) -> ShardModel {
        let keys = array![trade_id.into()].span();
        (Model::<Trade>::selector(ns_hash), Model::<Trade>::layout()).shard(keys)
    }

    // ── ResourceArrival (composite key: structure_id + day) ───────────

    pub fn resource_arrival_all(ns_hash: felt252, structure_id: ID, day: u64) -> ShardModel {
        let keys = array![structure_id.into(), day.into()].span();
        (Model::<ResourceArrival>::selector(ns_hash), Model::<ResourceArrival>::layout()).shard(keys)
    }

    // ── Market (packed, keyed by resource_type) ─────────────────────────

    pub fn market_all(ns_hash: felt252, resource_type: u8) -> ShardModel {
        let keys = array![resource_type.into()].span();
        (Model::<Market>::selector(ns_hash), Model::<Market>::layout()).shard(keys)
    }

    // ── Liquidity (composite key: player + resource_type) ─────────────

    pub fn liquidity_all(
        ns_hash: felt252, player: starknet::ContractAddress, resource_type: u8,
    ) -> ShardModel {
        let keys = array![player.into(), resource_type.into()].span();
        (Model::<Liquidity>::selector(ns_hash), Model::<Liquidity>::layout()).shard(keys)
    }

    // ── Compose all (single entity_id key) ────────────────────────────

    /// ALL game models keyed by entity_id with default Set CRDT.
    /// For models with different keys (Building, ExplorerTroops, Trade,
    /// ResourceArrival, Market, Liquidity), use their individual helpers.
    pub fn all_models(ns_hash: felt252, entity_id: ID) -> Array<ShardModel> {
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
    use crate::alias::ID;
    use crate::constants::DEFAULT_NS;

    #[abi(embed_v0)]
    impl ShardingSystemsImpl of super::IShardingSystems<ContractState> {
        fn request_shard(
            ref self: ContractState, proxy: starknet::ContractAddress, models: Span<ShardModel>,
        ) {
            let world = self.world(DEFAULT_NS());
            world.dispatcher.request_sharding(proxy, models);
        }

        fn request_shard_all(
            ref self: ContractState, proxy: starknet::ContractAddress, entity_ids: Span<ID>,
        ) {
            let world = self.world(DEFAULT_NS());
            let ns_hash = dojo::utils::bytearray_hash(@"s1_eternum");

            // Collect all models into one request — proxy handles event chunking.
            let mut models: Array<ShardModel> = ArrayTrait::new();
            for entity_id in entity_ids {
                let entity_models = super::shard_helpers::all_models(ns_hash, *entity_id);
                for m in entity_models {
                    models.append(m);
                };
            };
            world.dispatcher.request_sharding(proxy, models.span());
        }

        fn finish_shard(ref self: ContractState) {
            let world = self.world(DEFAULT_NS());
            world.dispatcher.end_shard();
        }
    }
}
