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

use dojo::model::Model;
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
use crate::models::resource::resource::{Resource, ResourceImpl, Resource_fields};
use crate::models::structure::{Structure_fields};
use crate::systems::sharding::contracts::{
    IShardingSystemsDispatcher, IShardingSystemsDispatcherTrait, shard_helpers,
};

const NS_HASH: felt252 = 0x0; // computed lazily in helpers via Model::selector

fn namespace_def() -> NamespaceDef {
    NamespaceDef {
        namespace: DEFAULT_NS_STR(),
        resources: [
            TestResource::Model("Resource"),
            TestResource::Model("Structure"),
            TestResource::Model("StructureBuildings"),
            TestResource::Model("ProductionBoostBonus"),
            TestResource::Model("TradeCount"),
            TestResource::Model("VillageTroop"),
            TestResource::Model("VillageRaidImmunity"),
            TestResource::Model("Quantity"),
            TestResource::Model("Wonder"),
            TestResource::Model("StructureVillageSlots"),
            TestResource::Model("QuantityTracker"),
            TestResource::Model("ResourceAllowance"),
            TestResource::Model("ResourceList"),
            TestResource::Model("HyperstructureRequirements"),
            TestResource::Model("PlayerConstructionPoints"),
            TestResource::Model("Building"),
            TestResource::Model("ExplorerTroops"),
            TestResource::Model("Trade"),
            TestResource::Model("ResourceArrival"),
            TestResource::Model("Market"),
            TestResource::Model("Liquidity"),
            TestResource::Contract("sharding_systems"),
        ]
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

fn ns_hash() -> felt252 {
    dojo::utils::bytearray_hash(@"s1_eternum")
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

/// Get the storage slot for resource_type `i` (1-based) BALANCE field.
fn resource_balance_slot(ref world: WorldStorage, entity_id: ID, resource_type: u32) -> felt252 {
    let model_selector = Model::<Resource>::selector(ns_hash());
    let field_selector = ResourceImpl::balance_selector(resource_type.into());
    let dojo_entity_id = entity_id_from_keys(@entity_id);
    compute_dojo_field_slot(model_selector, dojo_entity_id, field_selector)
}

fn caller() -> ContractAddress {
    0x1234_felt252.try_into().unwrap()
}

// ================================
// TESTS
// ================================

/// request_shard locks the balance field and balances are readable unchanged.
#[test]
fn test_request_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    // STONE(1)=100, WOOD(3)=200
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);
    ResourceImpl::write_balance(ref world, entity_id, 3, 200);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Request shard for STONE (type 1) and WOOD (type 3) via shard_helpers.
    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1, 3].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // Balances should remain readable and unchanged after locking.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(stone == 100, "STONE should be 100");
    assert!(wood == 200, "WOOD should be 200");
}

/// SetLock settlement: shard value overwrites main chain — no delta math, no underflow risk.
#[test]
fn test_shard_set_lock_overwrites() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    // Initial balance: STONE=100
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Lock STONE (type 1) for the shard.
    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // Simulate main chain independently changing STONE to 80 (e.g. spending 20).
    // With SetLock this change will be OVERWRITTEN at settlement — not merged.
    ResourceImpl::write_balance(ref world, entity_id, 1, 80);

    // Shard final: STONE=70 (spent 30 on shard).
    let slot = resource_balance_slot(ref world, entity_id, 1);
    let sharding = IContractComponentDispatcher { contract_address: world_address };

    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(slot, 70)]);
    stop_cheat_caller_address(world_address);

    // SetLock: shard value (70) overwrites main chain — no double-spend risk.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 70, "SetLock: expected shard value 70, got {}", stone);
}

/// Shard spends resources: final value lower than initial — no underflow panic (vs Add CRDT).
#[test]
fn test_shard_spend_no_underflow() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    // Initial STONE=1000
    ResourceImpl::write_balance(ref world, entity_id, 1, 1000);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // Shard spends 750: final balance = 250 (lower than initial — was impossible with Add CRDT).
    let slot = resource_balance_slot(ref world, entity_id, 1);
    let sharding = IContractComponentDispatcher { contract_address: world_address };

    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(slot, 250)]);
    stop_cheat_caller_address(world_address);

    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 250, "After shard spend: expected 250, got {}", stone);
}

/// Selective field sharding: only locked fields are updated, others untouched.
#[test]
fn test_shard_selective_fields_only() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    ResourceImpl::write_balance(ref world, entity_id, 1, 100); // STONE
    ResourceImpl::write_balance(ref world, entity_id, 3, 200); // WOOD

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Shard STONE only (type 1), NOT WOOD.
    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    let stone_slot = resource_balance_slot(ref world, entity_id, 1);
    let sharding = IContractComponentDispatcher { contract_address: world_address };

    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(stone_slot, 150)]);
    stop_cheat_caller_address(world_address);

    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(stone == 150, "STONE: expected 150 (shard value), got {}", stone);
    assert!(wood == 200, "WOOD: should be untouched at 200");
}

/// finish_shard forwards to the proxy without panicking.
#[test]
fn test_finish_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // finish_shard should not panic.
    start_cheat_caller_address(system_addr, caller());
    dispatcher.finish_shard();
    stop_cheat_caller_address(system_addr);
}

/// cancel_shard unlocks the slot without changing the balance.
#[test]
fn test_cancel_shard_preserves_balance() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let entity_id: ID = 42;

    ResourceImpl::write_balance(ref world, entity_id, 1, 500); // STONE

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    let models = [shard_helpers::resource(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    let stone_slot = resource_balance_slot(ref world, entity_id, 1);
    let sharding = IContractComponentDispatcher { contract_address: world_address };

    // Proxy cancels the shard (e.g. settlement failed).
    start_cheat_caller_address(world_address, proxy_address);
    sharding.cancel_shard_state(array![stone_slot].span());
    stop_cheat_caller_address(world_address);

    // Balance must remain unchanged after cancel.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 500, "Cancel: balance should be unchanged at 500, got {}", stone);
}

/// Verify that macro-generated field selector constants match selector!() values.
#[test]
fn test_field_selector_constants() {
    // Resource field constants
    assert!(Resource_fields::STONE_BALANCE == selector!("STONE_BALANCE"), "STONE_BALANCE mismatch");
    assert!(Resource_fields::COAL_BALANCE == selector!("COAL_BALANCE"), "COAL_BALANCE mismatch");
    assert!(Resource_fields::WOOD_BALANCE == selector!("WOOD_BALANCE"), "WOOD_BALANCE mismatch");

    // Structure field constants
    assert!(Structure_fields::OWNER == selector!("owner"), "owner mismatch");
    assert!(Structure_fields::BASE == selector!("base"), "base mismatch");
    assert!(Structure_fields::METADATA == selector!("metadata"), "metadata mismatch");
}

/// request_shard_all shards all game models with default Set CRDT.
#[test]
fn test_request_shard_all() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(proxy_address, array![entity_id].span());
    stop_cheat_caller_address(system_addr);

    // Balance should be unchanged — shard just initialized, no settlement yet.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 100, "STONE should be 100 after shard_all init");
}
