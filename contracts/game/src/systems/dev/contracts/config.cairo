use starknet::ContractAddress;

#[starknet::interface]
pub trait IDevConfigSystems<T> {
    fn init_test_configs(ref self: T, admin_address: ContractAddress);
}

#[dojo::contract]
pub mod dev_config_systems {
    use dojo::model::ModelStorage;
    use dojo::world::{IWorldDispatcherTrait, WorldStorage};
    use starknet::ContractAddress;
    use crate::constants::DEFAULT_NS;
    use crate::models::config::{
        CapacityConfig, SeasonConfig, StructureCapacityConfig, StructureLevelConfig, StructureMaxLevelConfig,
        TickConfig, TradeConfig, WeightConfig, WorldConfigUtilImpl,
    };
    use core::num::traits::Zero;
    use crate::models::resource::resource::ResourceList;
    use crate::systems::config::contracts::config_systems::assert_caller_is_admin;

    #[abi(embed_v0)]
    impl DevConfigSystemsImpl of super::IDevConfigSystems<ContractState> {
        fn init_test_configs(ref self: ContractState, admin_address: ContractAddress) {
            let mut world: WorldStorage = self.world(DEFAULT_NS());

            // Bootstrap admin address: allow first call (zero admin), require admin thereafter
            let current_admin: ContractAddress = WorldConfigUtilImpl::get_member(
                world, selector!("admin_address"),
            );
            if current_admin.is_non_zero() {
                assert_caller_is_admin(world);
            }
            WorldConfigUtilImpl::set_member(ref world, selector!("admin_address"), admin_address);

            // Season: dev mode on, always active
            WorldConfigUtilImpl::set_member(
                ref world,
                selector!("season_config"),
                SeasonConfig {
                    dev_mode_on: true,
                    start_settling_at: 0,
                    start_main_at: 0,
                    end_at: 0,
                    end_grace_seconds: 0,
                    registration_grace_seconds: 0,
                },
            );

            // Tick config
            WorldConfigUtilImpl::set_member(
                ref world, selector!("tick_config"), TickConfig { armies_tick_in_seconds: 1, delivery_tick_in_seconds: 1 },
            );

            // Capacity: large values so we never hit limits
            WorldConfigUtilImpl::set_member(
                ref world,
                selector!("capacity_config"),
                CapacityConfig {
                    structure_capacity: 1_000_000_000_000_000,
                    troop_capacity: 100_000_000,
                    donkey_capacity: 10_000_000,
                    storehouse_boost_capacity: 10_000,
                },
            );
            WorldConfigUtilImpl::set_member(
                ref world,
                selector!("structure_capacity_config"),
                StructureCapacityConfig {
                    realm_capacity: 1_000_000_000_000_000,
                    village_capacity: 1_000_000_000_000_000,
                    hyperstructure_capacity: 1_000_000_000_000_000,
                    fragment_mine_capacity: 1_000_000_000_000_000,
                    bank_structure_capacity: 1_000_000_000_000_000,
                },
            );

            // Structure levels: realm max 3, village max 2
            WorldConfigUtilImpl::set_member(
                ref world,
                selector!("structure_max_level_config"),
                StructureMaxLevelConfig { realm_max: 3, village_max: 2 },
            );

            // Trade config
            WorldConfigUtilImpl::set_member(ref world, selector!("trade_config"), TradeConfig { max_count: 10 });

            // Weight config for all resource types we use (100 grams each)
            // STONE=1, COAL=2, WOOD=3, COPPER=4, GOLD=7
            let resource_types: Array<u8> = array![1, 2, 3, 4, 5, 6, 7, 8];
            for resource_type in resource_types {
                world.write_model(@WeightConfig { resource_type, weight_gram: 100 });
            };

            // Level 1 upgrade cost: 100 WOOD + 50 STONE
            let level1_resources_id = world.dispatcher.uuid();
            world
                .write_model(
                    @ResourceList {
                        entity_id: level1_resources_id, index: 0, resource_type: 3, amount: 100,
                    },
                );
            world
                .write_model(
                    @ResourceList {
                        entity_id: level1_resources_id, index: 1, resource_type: 1, amount: 50,
                    },
                );
            world
                .write_model(
                    @StructureLevelConfig {
                        level: 1, required_resources_id: level1_resources_id, required_resource_count: 2,
                    },
                );

            // Level 2 upgrade cost: 200 WOOD + 100 STONE + 50 COAL
            let level2_resources_id = world.dispatcher.uuid();
            world
                .write_model(
                    @ResourceList {
                        entity_id: level2_resources_id, index: 0, resource_type: 3, amount: 200,
                    },
                );
            world
                .write_model(
                    @ResourceList {
                        entity_id: level2_resources_id, index: 1, resource_type: 1, amount: 100,
                    },
                );
            world
                .write_model(
                    @ResourceList {
                        entity_id: level2_resources_id, index: 2, resource_type: 2, amount: 50,
                    },
                );
            world
                .write_model(
                    @StructureLevelConfig {
                        level: 2, required_resources_id: level2_resources_id, required_resource_count: 3,
                    },
                );
        }
    }
}
