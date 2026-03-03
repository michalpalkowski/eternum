use crate::alias::ID;

#[starknet::interface]
pub trait IShardingSystems<T> {
    /// Request sharding for specific resource types of an entity using SetLock CRDT.
    ///
    /// Each resource type maps to a single `*_BALANCE` field in the Resource model.
    /// SetLock semantics: the balance field is exclusively locked for this shard; at
    /// settlement the shard's final value overwrites the main chain. No concurrent shards
    /// on the same slot are permitted while the lock is active.
    ///
    /// # Arguments
    /// * `proxy` - The sharding proxy contract address (operator's contract).
    /// * `entity_id` - The entity whose Resource to shard.
    /// * `resource_indices` - Which resource types to shard (1-based: 1=STONE, 2=COAL, 3=WOOD, …).
    fn request_shard(ref self: T, proxy: starknet::ContractAddress, entity_id: ID, resource_indices: Span<u32>);

    /// Request sharding for a full gameplay campaign: multiple entities, mixed CRDT types.
    ///
    /// Per entity, shards:
    /// - Resource balance fields with **SetLock** CRDT (shard owns the balance; overwrites at settlement)
    /// - Structure.owner (field 0) with **Lock** CRDT (unchanged at settlement — owner can't change)
    /// - Structure.base (field 1) with **Set** CRDT (level-up changes written back)
    /// - Structure.metadata (field 5) with **SetLock** CRDT (shard metadata is authoritative)
    fn request_shard_campaign(
        ref self: T,
        proxy: starknet::ContractAddress,
        entity_ids: Span<ID>,
        resource_indices: Span<u32>,
    );

    /// End the current shard session. Forwards to the sharding proxy.
    fn finish_shard(ref self: T);
}

#[dojo::contract]
pub mod sharding_systems {
    use dojo::meta::{FieldLayout, Layout};
    use dojo::model::Model;
    use dojo::sharding::request::{IntoShardModel, ShardModel};
    use dojo::world::IWorldDispatcherTrait;
    use crate::alias::ID;
    use crate::constants::DEFAULT_NS;
    use crate::models::resource::resource::Resource;
    use crate::models::structure::Structure;

    /// Max resource type (56 types, 1-based: STONE=1 … RELIC_E18=56).
    const MAX_RESOURCE_TYPE: u32 = 56;

    /// Select the balance field for each requested resource type.
    ///
    /// Resource type `i` (1-based) maps to layout field index `i - 1`
    /// (the first 56 fields of Resource are *_BALANCE in declaration order).
    fn select_resource_fields(
        fields: Span<FieldLayout>, resource_indices: Span<u32>, ref selected: Array<FieldLayout>,
    ) {
        for idx in resource_indices {
            let idx = *idx;
            assert!(idx >= 1 && idx <= MAX_RESOURCE_TYPE, "resource_index must be 1-56 (resource type)");
            selected.append(*fields[idx - 1]); // *_BALANCE field for this resource type
        }
    }

    #[abi(embed_v0)]
    impl ShardingSystemsImpl of super::IShardingSystems<ContractState> {
        fn request_shard(
            ref self: ContractState, proxy: starknet::ContractAddress, entity_id: ID, resource_indices: Span<u32>,
        ) {
            let world = self.world(DEFAULT_NS());
            let ns_hash = dojo::utils::bytearray_hash(@"s1_eternum");
            let selector = Model::<Resource>::selector(ns_hash);
            let full_layout = Model::<Resource>::layout();

            if let Layout::Struct(fields) = full_layout {
                let mut selected: Array<FieldLayout> = ArrayTrait::new();
                select_resource_fields(fields, resource_indices, ref selected);
                let partial_layout = Layout::Struct(selected.span());
                let keys: Array<felt252> = array![entity_id.into()];
                // SetLock: shard exclusively owns these balance fields.
                // At settlement the shard value overwrites main chain — no delta math,
                // no negative balance risk.
                world
                    .dispatcher
                    .request_sharding(proxy, [(selector, partial_layout).shard_set_lock(keys.span())].span());
            } else {
                panic!("Resource layout not Struct");
            }
        }

        fn request_shard_campaign(
            ref self: ContractState,
            proxy: starknet::ContractAddress,
            entity_ids: Span<ID>,
            resource_indices: Span<u32>,
        ) {
            let world = self.world(DEFAULT_NS());
            let ns_hash = dojo::utils::bytearray_hash(@"s1_eternum");

            let resource_selector = Model::<Resource>::selector(ns_hash);
            let resource_layout = Model::<Resource>::layout();
            let structure_selector = Model::<Structure>::selector(ns_hash);
            let structure_layout = Model::<Structure>::layout();

            let mut models: Array<ShardModel> = ArrayTrait::new();

            for entity_id in entity_ids {
                let entity_id = *entity_id;
                let keys: Array<felt252> = array![entity_id.into()];

                // Resource balance fields → SetLock CRDT.
                // Shard exclusively owns these balances; settlement overwrites main chain.
                // Game contract must prevent main chain spending of sharded resources
                // while the shard is active (checked via component's init_count).
                if let Layout::Struct(fields) = resource_layout {
                    let mut selected: Array<FieldLayout> = ArrayTrait::new();
                    select_resource_fields(fields, resource_indices, ref selected);
                    models
                        .append(
                            (resource_selector, Layout::Struct(selected.span())).shard_set_lock(keys.span()),
                        );
                };

                // Structure fields — mixed CRDT types
                if let Layout::Struct(fields) = structure_layout {
                    // owner (field 0) → Lock: shard value discarded, ownership unchanged at settlement
                    models
                        .append(
                            (structure_selector, Layout::Struct(array![*fields[0]].span()))
                                .shard_lock(keys.span()),
                        );

                    // base (field 1) → Set: level-up changes (troop caps etc.) written back
                    models
                        .append(
                            (structure_selector, Layout::Struct(array![*fields[1]].span()))
                                .shard(keys.span()),
                        );

                    // metadata (field 5) → SetLock: shard metadata is authoritative
                    models
                        .append(
                            (structure_selector, Layout::Struct(array![*fields[5]].span()))
                                .shard_set_lock(keys.span()),
                        );
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
