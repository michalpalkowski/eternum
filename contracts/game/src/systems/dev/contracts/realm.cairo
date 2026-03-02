use crate::alias::ID;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IDevRealmSystems<T> {
    fn create_test_realm(ref self: T, entity_id: ID, owner: ContractAddress, coord_x: u32, coord_y: u32);
}

#[dojo::contract]
pub mod dev_realm_systems {
    use dojo::model::ModelStorage;
    use dojo::world::WorldStorage;
    use starknet::ContractAddress;
    use crate::alias::ID;
    use crate::constants::{DEFAULT_NS, RESOURCE_PRECISION};
    use crate::models::config::{StructureCapacityConfig, WorldConfigUtilImpl};
    use crate::models::position::Coord;
    use crate::models::resource::resource::{ResourceImpl, ResourceTrait};
    use crate::models::structure::{
        StructureCategory, StructureImpl, StructureMetadata, StructureOwnerStatsImpl,
    };
    use crate::models::weight::Weight;
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;

    #[abi(embed_v0)]
    impl DevRealmSystemsImpl of super::IDevRealmSystems<ContractState> {
        fn create_test_realm(
            ref self: ContractState, entity_id: ID, owner: ContractAddress, coord_x: u32, coord_y: u32,
        ) {
            let mut world: WorldStorage = self.world(DEFAULT_NS());
            assert_caller_is_admin(world);

            let coord = Coord { alt: false, x: coord_x, y: coord_y };
            let metadata = StructureMetadata {
                realm_id: entity_id.try_into().unwrap(),
                order: 1,
                has_wonder: false,
                villages_count: 0,
                village_realm: 0,
            };

            let mut structure = StructureImpl::new(entity_id, StructureCategory::Realm, coord, 0, metadata);
            structure.owner = owner;

            world.write_model(@structure);
            StructureOwnerStatsImpl::increase(ref world, owner);

            // Initialize Resource model + Weight capacity (mirrors make_structure)
            let capacity_config: StructureCapacityConfig = WorldConfigUtilImpl::get_member(
                world, selector!("structure_capacity_config"),
            );
            let capacity: u128 = capacity_config.realm_capacity.into() * RESOURCE_PRECISION;
            ResourceImpl::initialize(ref world, entity_id);
            ResourceImpl::write_weight(ref world, entity_id, Weight { capacity, weight: 0 });
        }
    }
}
