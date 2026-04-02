#[starknet::interface]
pub trait IShardingSystems<T> {
    fn register_policies(ref self: T);
    /// Generic shard request. Commitment is computed atomically on-chain
    /// inside dojo's request_sharding as H(sorted(entity_ids)).
    fn request_shard(
        ref self: T, entity_ids: Span<felt252>, shared_entity_ids: Span<felt252>,
    );
    /// Shard an entire realm. Computes entities (realm + hex grid buildings)
    /// on-chain, then atomically locks entities + computes commitment.
    fn request_shard_realm(
        ref self: T,
        realm_entity_id: felt252,
        exclusive_related_entity_ids: Span<felt252>,
        shared_entity_ids: Span<felt252>,
    );
    fn finish_shard(ref self: T, shard_id: felt252);
}

#[dojo::contract]
pub mod sharding_systems {
    use dojo::model::Model;
    use dojo::sharding::request::{CRDVariant, ShardField};
    use dojo::world::{IWorldDispatcherTrait, WorldStorage};
    use dojo::utils::entity_id_from_serialized_keys;
    use crate::constants::DEFAULT_NS;
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;

    use crate::models::bank::market::Market;
    use crate::models::bank::liquidity::Liquidity;
    use crate::models::resource::resource::{Resource, ResourceAllowance, ResourceList};
    use crate::models::resource::arrivals::ResourceArrival;
    use crate::models::resource::production::building::{Building, BuildingImpl, StructureBuildings};
    use crate::models::resource::production::production::ProductionBoostBonus;
    use crate::models::structure::{
        Structure, Structure_fields, StructureBaseStoreImpl, StructureBaseTrait, Wonder,
        StructureVillageSlots, VillageTroop, VillageRaidImmunity,
    };
    use crate::models::position::{Coord, CoordTrait};
    use crate::models::trade::{Trade, TradeCount};
    use crate::models::quantity::{Quantity, QuantityTracker};
    use crate::models::troop::ExplorerTroops;
    use crate::models::hyperstructure::{
        HyperstructureGlobals, HyperstructureRequirements, PlayerConstructionPoints,
        PlayerRegisteredPoints,
    };
    use crate::models::season::SeasonPrize;

    fn register_policy(
        ref world: WorldStorage,
        ns_hash: felt252,
        model_selector: felt252,
        default_crdt: CRDVariant,
        field_overrides: Span<ShardField>,
    ) {
        world.dispatcher.register_shard_policy(model_selector, default_crdt, field_overrides);
    }

    #[abi(embed_v0)]
    impl ShardingSystemsImpl of super::IShardingSystems<ContractState> {
        /// Register CRDT policies for all shardable models. Called once at deploy.
        fn register_policies(ref self: ContractState) {
            let mut world = self.world(DEFAULT_NS());
            let ns_hash = dojo::utils::bytearray_hash(DEFAULT_NS());

            // ── Global shared state → Add (concurrent shard access) ──

            register_policy(
                ref world, ns_hash, Model::<Market>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<Liquidity>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<SeasonPrize>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<HyperstructureGlobals>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<HyperstructureRequirements>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<PlayerRegisteredPoints>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<PlayerConstructionPoints>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<TradeCount>::selector(ns_hash),
                CRDVariant::Add, [].span(),
            );

            // ── Entity-locked state with per-field overrides ──

            register_policy(
                ref world, ns_hash, Model::<Structure>::selector(ns_hash),
                CRDVariant::Set,
                [
                    ShardField { selector: Structure_fields::OWNER, crdt: CRDVariant::Lock, max_elements: 0 },
                    ShardField { selector: selector!("troop_explorers"), crdt: CRDVariant::SetLock, max_elements: 20 },
                ].span(),
            );

            // ── Dynamic members → SetLock ──

            register_policy(
                ref world, ns_hash, Model::<Building>::selector(ns_hash),
                CRDVariant::SetLock, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<StructureBuildings>::selector(ns_hash),
                CRDVariant::SetLock, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<Quantity>::selector(ns_hash),
                CRDVariant::SetLock, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<QuantityTracker>::selector(ns_hash),
                CRDVariant::SetLock, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<StructureVillageSlots>::selector(ns_hash),
                CRDVariant::SetLock,
                [ShardField { selector: selector!("directions_left"), crdt: CRDVariant::SetLock, max_elements: 6 }].span(),
            );

            // ── Entity-locked, simple models → Set (default) ──

            register_policy(
                ref world, ns_hash, Model::<Resource>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<ResourceAllowance>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<ResourceList>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<ResourceArrival>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<ProductionBoostBonus>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<Wonder>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<VillageTroop>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<VillageRaidImmunity>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<ExplorerTroops>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
            register_policy(
                ref world, ns_hash, Model::<Trade>::selector(ns_hash),
                CRDVariant::Set, [].span(),
            );
        }

        fn request_shard(
            ref self: ContractState, entity_ids: Span<felt252>, shared_entity_ids: Span<felt252>,
        ) {
            assert!(
                entity_ids.len() + shared_entity_ids.len() > 0,
                "entity_ids and shared_entity_ids must not both be empty"
            );
            let world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            let mut dojo_entities: Array<felt252> = ArrayTrait::new();
            let mut dojo_shared_entities: Array<felt252> = ArrayTrait::new();
            let mut entity_keys_flat: Array<felt252> = ArrayTrait::new();
            for id in entity_ids {
                dojo_entities.append(entity_id_from_serialized_keys([*id].span()));
                // Each entity has 1 key (the raw entity_id)
                entity_keys_flat.append(1);
                entity_keys_flat.append(*id);
            };
            for id in shared_entity_ids {
                dojo_shared_entities.append(entity_id_from_serialized_keys([*id].span()));
                // Shared entities currently use the same single-key encoding.
                entity_keys_flat.append(1);
                entity_keys_flat.append(*id);
            };
            world
                .dispatcher
                .request_sharding(
                    dojo_entities.span(), dojo_shared_entities.span(), entity_keys_flat.span(),
                );
        }

        fn request_shard_realm(
            ref self: ContractState,
            realm_entity_id: felt252,
            exclusive_related_entity_ids: Span<felt252>,
            shared_entity_ids: Span<felt252>,
        ) {
            let mut world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);

            let realm_id: u32 = realm_entity_id.try_into().expect('realm_entity_id overflow');
            let base = StructureBaseStoreImpl::retrieve(ref world, realm_id);
            assert!(base.coord_x != 0 || base.coord_y != 0, "realm not found");

            let outer_col: felt252 = base.coord_x.into();
            let outer_row: felt252 = base.coord_y.into();
            let max_rings: u32 = base.max_level(world).into() + 1;

            let mut dojo_entities: Array<felt252> = ArrayTrait::new();
            let mut dojo_shared_entities: Array<felt252> = ArrayTrait::new();
            let mut entity_keys_flat: Array<felt252> = ArrayTrait::new();

            // Realm entity: 1 key = realm_entity_id
            dojo_entities.append(entity_id_from_serialized_keys([realm_entity_id].span()));
            entity_keys_flat.append(1);
            entity_keys_flat.append(realm_entity_id);

            let center = BuildingImpl::center();
            let mut ring: u32 = 1;
            while ring <= max_rings {
                let positions: Array<Coord> = center.ring(ring);
                for pos in positions {
                    let inner_col: felt252 = pos.x.into();
                    let inner_row: felt252 = pos.y.into();
                    dojo_entities.append(entity_id_from_serialized_keys(
                        [outer_col, outer_row, inner_col, inner_row].span(),
                    ));
                    // Building entity: 4 keys
                    entity_keys_flat.append(4);
                    entity_keys_flat.append(outer_col);
                    entity_keys_flat.append(outer_row);
                    entity_keys_flat.append(inner_col);
                    entity_keys_flat.append(inner_row);
                };
                ring += 1;
            };

            for id in exclusive_related_entity_ids {
                dojo_entities.append(entity_id_from_serialized_keys([*id].span()));
                // Related entities currently use the same single-key encoding.
                entity_keys_flat.append(1);
                entity_keys_flat.append(*id);
            };

            for id in shared_entity_ids {
                dojo_shared_entities.append(entity_id_from_serialized_keys([*id].span()));
                // Shared entities currently use the same single-key encoding.
                entity_keys_flat.append(1);
                entity_keys_flat.append(*id);
            };

            world
                .dispatcher
                .request_sharding(
                    dojo_entities.span(), dojo_shared_entities.span(), entity_keys_flat.span(),
                );
        }

        fn finish_shard(ref self: ContractState, shard_id: felt252) {
            let world = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);
            world.dispatcher.end_shard(shard_id);
        }
    }
}
