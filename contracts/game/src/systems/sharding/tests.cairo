use dojo::sharding::crdt::CRDType;

#[starknet::contract]
pub mod mock_sharding_proxy {
    use dojo::sharding::crdt::CRDType;

    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl IShardingImpl of dojo::sharding::interface::ISharding<ContractState> {
        fn initialize_sharding(ref self: ContractState, storage_slots: Span<CRDType>) {}
        fn end_shard(ref self: ContractState) {}
    }
}

use dojo::meta::Layout;
use dojo::model::{Model, ModelStorage};
use dojo::sharding::component::{IContractComponentDispatcher, IContractComponentDispatcherTrait};
use dojo::sharding::compute_dojo_field_slot;
use dojo::utils::entity_id_from_keys;
use dojo::world::{IWorldDispatcherTrait, WorldStorage, WorldStorageTrait};
use dojo_snf_test::{
    ContractDef, ContractDefTrait, NamespaceDef, TestResource, WorldStorageTestTrait,
    spawn_test_world,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::alias::ID;
use crate::constants::{DEFAULT_NS, DEFAULT_NS_STR};
use crate::models::resource::resource::{Resource, ResourceImpl};
use crate::systems::sharding::contracts::{
    IShardingSystemsDispatcher, IShardingSystemsDispatcherTrait,
};

fn namespace_def() -> NamespaceDef {
    NamespaceDef {
        namespace: DEFAULT_NS_STR(),
        resources: [TestResource::Model("Resource"), TestResource::Contract("sharding_systems"),]
            .span(),
    }
}

fn contract_defs() -> Span<ContractDef> {
    [
        ContractDefTrait::new(DEFAULT_NS(), @"sharding_systems")
            .with_writer_of([dojo::utils::bytearray_hash(DEFAULT_NS())].span()),
    ]
        .span()
}

fn setup_world() -> WorldStorage {
    let mut world = spawn_test_world([namespace_def()].span());
    world.sync_perms_and_inits(contract_defs());
    world.dispatcher.uuid();
    world
}

fn deploy_mock_proxy() -> ContractAddress {
    let contract_class = declare("mock_sharding_proxy").unwrap().contract_class();
    let (addr, _) = contract_class.deploy(@array![]).unwrap();
    addr
}

fn get_sharding_dispatcher(
    ref world: WorldStorage,
) -> (ContractAddress, IShardingSystemsDispatcher) {
    let (addr, _) = world.dns(@"sharding_systems").unwrap();
    (addr, IShardingSystemsDispatcher { contract_address: addr })
}

/// Get field selector for a specific field index from the Resource layout.
/// Resource type `i` has additions at index `i*2` and subtractions at `i*2+1`.
fn resource_field_selector(index: u32) -> felt252 {
    let layout = Model::<Resource>::layout();
    if let Layout::Struct(fields) = layout {
        (*fields[index]).selector
    } else {
        panic!("Resource layout not Struct")
    }
}

/// Write initial Resource balance values using ResourceImpl.
fn write_test_balances(ref world: WorldStorage, entity_id: ID, stone: u128, wood: u128) {
    // resource_type 1 = STONE, resource_type 3 = WOOD
    ResourceImpl::write_balance(ref world, entity_id, 1, stone);
    ResourceImpl::write_balance(ref world, entity_id, 3, wood);
}

fn caller() -> ContractAddress {
    0x1234_felt252.try_into().unwrap()
}

// ================================
// TESTS
// ================================

#[test]
fn test_request_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    write_test_balances(ref world, entity_id, 100, 200);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Request shard for STONE (index 0) and WOOD (index 2).
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, entity_id, array![0, 2].span());
    stop_cheat_caller_address(system_addr);

    // Balances should remain readable and unchanged.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(stone == 100, "STONE should be 100");
    assert!(wood == 200, "WOOD should be 200");
}

#[test]
fn test_shard_add_crdt_delta() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    write_test_balances(ref world, entity_id, 100, 200);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Request shard for STONE (index 0) — snapshots initial=100.
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, entity_id, array![0].span());
    stop_cheat_caller_address(system_addr);

    // Simulate mainchain change: STONE 100 → 120.
    write_test_balances(ref world, entity_id, 120, 200);

    // Compute the slot for STONE_ADDITIONS (field index 0).
    let ns_hash = dojo::utils::bytearray_hash(@"s1_eternum");
    let model_selector = Model::<Resource>::selector(ns_hash);
    let field_selector = resource_field_selector(0);
    let dojo_entity_id = entity_id_from_keys(@entity_id);
    let slot = compute_dojo_field_slot(model_selector, dojo_entity_id, field_selector);

    // Shard saw initial=100, produced shard_value=150 (delta=50).
    let sharding = IContractComponentDispatcher { contract_address: world_address };
    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(slot, 150)]);
    stop_cheat_caller_address(world_address);

    // Expected: current(120) + (shard(150) - initial(100)) = 170
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(stone == 170, "Add delta: expected 170, got {}", stone);
    assert!(wood == 200, "WOOD should be unchanged");
}

#[test]
fn test_shard_selective_fields_only() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    write_test_balances(ref world, entity_id, 100, 200);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Shard STONE only (index 0), NOT WOOD.
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, entity_id, array![0].span());
    stop_cheat_caller_address(system_addr);

    // Mainchain changes STONE 100 → 120.
    write_test_balances(ref world, entity_id, 120, 200);

    // Compute slot for STONE and update via shard.
    let ns_hash = dojo::utils::bytearray_hash(@"s1_eternum");
    let model_selector = Model::<Resource>::selector(ns_hash);
    let field_selector = resource_field_selector(0);
    let dojo_entity_id = entity_id_from_keys(@entity_id);
    let slot = compute_dojo_field_slot(model_selector, dojo_entity_id, field_selector);

    let sharding = IContractComponentDispatcher { contract_address: world_address };
    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(slot, 130)]);
    stop_cheat_caller_address(world_address);

    // STONE: 120 + (130 - 100) = 150
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 150, "STONE: expected 150, got {}", stone);
    // WOOD should be completely unaffected.
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(wood == 200, "WOOD should be unchanged at 200");
}

#[test]
fn test_finish_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    write_test_balances(ref world, entity_id, 100, 200);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, entity_id, array![0].span());
    stop_cheat_caller_address(system_addr);

    // finish_shard should not panic — forwards to proxy.end_shard().
    start_cheat_caller_address(system_addr, caller());
    dispatcher.finish_shard();
    stop_cheat_caller_address(system_addr);
}
