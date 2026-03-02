use crate::alias::ID;

#[starknet::interface]
pub trait IShardingSystems<T> {
    /// Request sharding for specific resource types of an entity using PN-Counter CRDT.
    ///
    /// Each resource type `i` maps to two model fields: additions (P) and subtractions (N).
    /// Both are G-Counters (grow-only), enabling concurrent add+spend on shards.
    ///
    /// # Arguments
    /// * `proxy` - The sharding proxy contract address (operator's contract).
    /// * `entity_id` - The entity whose Resource to shard.
    /// * `resource_indices` - Which resource types to shard (0=STONE, 1=COAL, 2=WOOD, etc.).
    ///   Must be < 56.
    fn request_shard(ref self: T, proxy: starknet::ContractAddress, entity_id: ID, resource_indices: Span<u32>);

    /// Request sharding for a full gameplay campaign: multiple entities, mixed CRDT types.
    ///
    /// Per entity, shards:
    /// - Resource additions+subtractions fields with **PNCounter** CRDT
    /// - Structure.owner (field 0) with **Lock** CRDT
    /// - Structure.base (field 1) with **Set** CRDT
    /// - Structure.metadata (field 5) with **SetLock** CRDT
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

    /// Max resource type index (56 resource types: STONE=0, COAL=1, ...).
    const MAX_RESOURCE_TYPE: u32 = 56;

    /// Select both additions (P) and subtractions (N) fields for a resource type.
    /// Resource type `i` maps to model fields `i*2` (additions) and `i*2+1` (subtractions).
    fn select_resource_fields(
        fields: Span<FieldLayout>, resource_indices: Span<u32>, ref selected: Array<FieldLayout>,
    ) {
        for idx in resource_indices {
            let idx = *idx;
            assert!(idx < MAX_RESOURCE_TYPE, "Index must be a resource type (0-55)");
            selected.append(*fields[idx * 2]);     // additions (P counter)
            selected.append(*fields[idx * 2 + 1]); // subtractions (N counter)
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
                world.dispatcher.request_sharding(proxy, [(selector, partial_layout).shard_pn(keys.span())].span());
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

                // Resource additions+subtractions fields → PNCounter CRDT
                if let Layout::Struct(fields) = resource_layout {
                    let mut selected: Array<FieldLayout> = ArrayTrait::new();
                    select_resource_fields(fields, resource_indices, ref selected);
                    models
                        .append(
                            (resource_selector, Layout::Struct(selected.span())).shard_pn(keys.span()),
                        );
                };

                // Structure fields → mixed CRDT types
                if let Layout::Struct(fields) = structure_layout {
                    // owner (field 0) → Lock
                    models
                        .append(
                            (structure_selector, Layout::Struct(array![*fields[0]].span()))
                                .shard_lock(keys.span()),
                        );

                    // base (field 1) → Set
                    models
                        .append(
                            (structure_selector, Layout::Struct(array![*fields[1]].span()))
                                .shard(keys.span()),
                        );

                    // metadata (field 5) → SetLock
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
