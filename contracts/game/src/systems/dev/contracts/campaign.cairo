use crate::alias::ID;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IDevCampaignSystems<T> {
    /// Run a multi-step gameplay campaign on a shard.
    ///
    /// The campaign contract must own both realms so permission checks pass.
    /// Exercises all 4 CRDT types across 8 resource types, 2 entities, and ~10 actions.
    fn run_campaign(
        ref self: T,
        structure_systems_addr: ContractAddress,
        resource_systems_addr: ContractAddress,
        realm_a: ID,
        realm_b: ID,
    );
}

#[dojo::contract]
pub mod dev_campaign_systems {
    use dojo::world::WorldStorage;
    use starknet::ContractAddress;
    use crate::alias::ID;
    use crate::constants::DEFAULT_NS;
    use crate::models::resource::resource::{
        ResourceWeightImpl, SingleResourceImpl, SingleResourceStoreImpl, WeightStoreImpl,
    };
    use crate::models::structure::{
        StructureBaseStoreImpl, StructureMetadata, StructureMetadataStoreImpl,
    };
    use crate::models::weight::Weight;
    use crate::systems::resources::contracts::resource_systems::{
        IResourceSystemsDispatcher, IResourceSystemsDispatcherTrait,
    };
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;
    use crate::systems::structure::contracts::{
        IStructureSystemsDispatcher, IStructureSystemsDispatcherTrait,
    };

    fn mint_resource(ref world: WorldStorage, entity_id: ID, resource_type: u8, amount: u128) {
        let mut structure_weight: Weight = WeightStoreImpl::retrieve(ref world, entity_id);
        let resource_weight_grams: u128 = ResourceWeightImpl::grams(ref world, resource_type);
        let mut resource = SingleResourceStoreImpl::retrieve(
            ref world, entity_id, resource_type, ref structure_weight, resource_weight_grams, true,
        );
        resource.add(amount, ref structure_weight, resource_weight_grams);
        resource.store(ref world);
        structure_weight.store(ref world, entity_id);
    }

    #[abi(embed_v0)]
    impl DevCampaignSystemsImpl of super::IDevCampaignSystems<ContractState> {
        fn run_campaign(
            ref self: ContractState,
            structure_systems_addr: ContractAddress,
            resource_systems_addr: ContractAddress,
            realm_a: ID,
            realm_b: ID,
        ) {
            let mut world: WorldStorage = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);

            let structure_systems = IStructureSystemsDispatcher {
                contract_address: structure_systems_addr,
            };
            let resource_systems = IResourceSystemsDispatcher {
                contract_address: resource_systems_addr,
            };

            // Initial economy.
            mint_resource(ref world, realm_a, 1, 10000);
            mint_resource(ref world, realm_a, 2, 5000);
            mint_resource(ref world, realm_a, 3, 10000);
            mint_resource(ref world, realm_a, 4, 3000);
            mint_resource(ref world, realm_a, 5, 2000);
            mint_resource(ref world, realm_a, 6, 1500);
            mint_resource(ref world, realm_a, 7, 5000);
            mint_resource(ref world, realm_a, 8, 1000);

            mint_resource(ref world, realm_b, 1, 5000);
            mint_resource(ref world, realm_b, 2, 3000);
            mint_resource(ref world, realm_b, 3, 5000);
            mint_resource(ref world, realm_b, 4, 2000);
            mint_resource(ref world, realm_b, 7, 2000);

            // Infrastructure upgrades.
            structure_systems.level_up(realm_a);
            structure_systems.level_up(realm_a);

            // Resource burns.
            resource_systems
                .structure_burn(realm_a, array![(8_u8, 500_u128), (7_u8, 1000_u128)].span());
            resource_systems
                .structure_burn(realm_b, array![(2_u8, 1000_u128), (1_u8, 500_u128)].span());

            // Late economy updates.
            mint_resource(ref world, realm_b, 6, 3000);
            mint_resource(ref world, realm_a, 7, 2000);
            mint_resource(ref world, realm_b, 3, 1500);

            // Governance updates.
            let mut metadata_a: StructureMetadata = StructureMetadataStoreImpl::retrieve(
                ref world, realm_a,
            );
            metadata_a.villages_count = 42;
            StructureMetadataStoreImpl::store(metadata_a, ref world, realm_a);

            let mut metadata_b: StructureMetadata = StructureMetadataStoreImpl::retrieve(
                ref world, realm_b,
            );
            metadata_b.villages_count = 7;
            StructureMetadataStoreImpl::store(metadata_b, ref world, realm_b);

            // Final cleanup burn.
            resource_systems.structure_burn(realm_a, array![(4_u8, 500_u128)].span());
        }
    }
}
