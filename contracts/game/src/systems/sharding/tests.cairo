use dojo::model::{Model, ModelStorage};
use dojo::utils::entity_id_from_keys;
use dojo::world::{IWorldDispatcherTrait, WorldStorage, WorldStorageTrait};
use dojo_snf_test::{
    ContractDef, ContractDefTrait, NamespaceDef, TestResource, WorldStorageTestTrait,
    spawn_test_world,
};
use snforge_std::{
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;
use crate::alias::ID;
use crate::constants::{DEFAULT_NS, DEFAULT_NS_STR};
use crate::models::resource::resource::{Resource, ResourceImpl};
use crate::models::structure::{Structure, StructureCategory};
use crate::models::config::WorldConfigUtilImpl;
use crate::systems::sharding::contracts::{
    IShardingSystemsDispatcher, IShardingSystemsDispatcherTrait,
};

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
            TestResource::Model("WorldConfig"),
            TestResource::Model("SeasonPrize"),
            TestResource::Model("HyperstructureGlobals"),
            TestResource::Model("PlayerRegisteredPoints"),
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
    WorldConfigUtilImpl::set_member(ref world, selector!("admin_address"), caller());
    world
}

fn caller() -> ContractAddress {
    0x1234_felt252.try_into().unwrap()
}

fn non_admin_caller() -> ContractAddress {
    0x5678_felt252.try_into().unwrap()
}

fn get_sharding_dispatcher(
    ref world: WorldStorage,
) -> (ContractAddress, IShardingSystemsDispatcher) {
    let (addr, _) = world.dns(@"sharding_systems").unwrap();
    (addr, IShardingSystemsDispatcher { contract_address: addr })
}

// ── request_shard tests ─────────────────────────────────────────────

#[test]
fn test_request_shard_locks_entity() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([entity_id.into()].span(), [].span());
    stop_cheat_caller_address(system_addr);

    // Balance should be unchanged after lock.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 100, "STONE should be 100 after shard init");
}

#[test]
#[should_panic(expected: "entity_ids and shared_entity_ids must not both be empty")]
fn test_request_shard_rejects_empty_entity_ids() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);
    let empty: Array<felt252> = array![];

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(empty.span(), [].span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "caller not admin")]
fn test_request_shard_rejects_non_admin_caller() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, non_admin_caller());
    dispatcher.request_shard([42].span(), [].span());
    stop_cheat_caller_address(system_addr);
}

// ── finish_shard tests ──────────────────────────────────────────────

#[test]
fn test_finish_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([entity_id.into()].span(), [].span());
    stop_cheat_caller_address(system_addr);

    // finish_shard should not panic.
    start_cheat_caller_address(system_addr, caller());
    dispatcher.finish_shard(1);
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "caller not admin")]
fn test_finish_shard_rejects_non_admin_caller() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, non_admin_caller());
    dispatcher.finish_shard(1);
    stop_cheat_caller_address(system_addr);
}

// ── register_policies tests ─────────────────────────────────────────

#[test]
fn test_register_policies() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.register_policies();
    stop_cheat_caller_address(system_addr);

    // Verify a known policy: Market should be Add (encoded=2).
    let ns_hash = dojo::utils::bytearray_hash(DEFAULT_NS());
    let market_selector = Model::<crate::models::bank::market::Market>::selector(ns_hash);
    let world_disp = dojo::world::IWorldDispatcher { contract_address: world.dispatcher.contract_address };
    let (default_encoded, overrides) = world_disp.get_shard_policy(market_selector);
    assert!(default_encoded == 2, "Market default should be Add(2), got {}", default_encoded);
    assert!(overrides.len() == 0, "Market should have no field overrides");

    // Verify Structure has Set default (1) with Lock override on owner.
    let structure_selector = Model::<Structure>::selector(ns_hash);
    let (struct_default, struct_overrides) = world_disp.get_shard_policy(structure_selector);
    assert!(struct_default == 1, "Structure default should be Set(1), got {}", struct_default);
    assert!(struct_overrides.len() == 1, "Structure should have 1 field override");
}

// ── Entity lock blocks writes ───────────────────────────────────────

#[test]
#[should_panic]
fn test_entity_lock_blocks_mainchain_write() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([entity_id.into()].span(), [].span());
    stop_cheat_caller_address(system_addr);

    // Write to locked entity should fail.
    ResourceImpl::write_balance(ref world, entity_id, 1, 80);
}

// ── Mixed exclusive + shared entity tests ───────────────────────────

#[test]
fn test_request_shard_with_exclusive_and_shared_entities() {
    let mut world = setup_world();
    let exclusive_id: ID = 42;
    let shared_id: ID = 99;
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 100);
    ResourceImpl::write_balance(ref world, shared_id, 1, 200);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([exclusive_id.into()].span(), [shared_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Both entities should retain their balances after locking.
    let exclusive_bal = ResourceImpl::read_balance(ref world, exclusive_id, 1);
    let shared_bal = ResourceImpl::read_balance(ref world, shared_id, 1);
    assert!(exclusive_bal == 100, "exclusive entity balance should be 100");
    assert!(shared_bal == 200, "shared entity balance should be 200");
}

#[test]
fn test_shared_entity_allows_mainchain_write() {
    let mut world = setup_world();
    let exclusive_id: ID = 42;
    let shared_id: ID = 99;
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 100);
    ResourceImpl::write_balance(ref world, shared_id, 1, 200);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([exclusive_id.into()].span(), [shared_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Mainchain write to shared entity should succeed (not locked exclusively).
    ResourceImpl::write_balance(ref world, shared_id, 1, 250);
    let shared_bal = ResourceImpl::read_balance(ref world, shared_id, 1);
    assert!(shared_bal == 250, "shared entity should accept mainchain writes");
}

#[test]
#[should_panic]
fn test_exclusive_entity_blocks_mainchain_write_with_shared_present() {
    let mut world = setup_world();
    let exclusive_id: ID = 42;
    let shared_id: ID = 99;
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 100);
    ResourceImpl::write_balance(ref world, shared_id, 1, 200);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([exclusive_id.into()].span(), [shared_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Mainchain write to exclusive entity should fail even when shared entities exist.
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 80);
}

#[test]
fn test_request_shard_multiple_exclusive_related_entities() {
    let mut world = setup_world();
    let realm_id: ID = 10;
    let explorer_id: ID = 100;
    let trade_id: ID = 200;
    ResourceImpl::write_balance(ref world, realm_id, 1, 50);
    ResourceImpl::write_balance(ref world, explorer_id, 1, 75);
    ResourceImpl::write_balance(ref world, trade_id, 1, 25);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(
        [realm_id.into(), explorer_id.into(), trade_id.into()].span(),
        [].span(),
    );
    stop_cheat_caller_address(system_addr);

    // All exclusive entities should retain their balances.
    assert!(ResourceImpl::read_balance(ref world, realm_id, 1) == 50, "realm balance");
    assert!(ResourceImpl::read_balance(ref world, explorer_id, 1) == 75, "explorer balance");
    assert!(ResourceImpl::read_balance(ref world, trade_id, 1) == 25, "trade balance");
}

#[test]
#[should_panic]
fn test_exclusive_related_entity_blocks_write() {
    let mut world = setup_world();
    let realm_id: ID = 10;
    let explorer_id: ID = 100;
    ResourceImpl::write_balance(ref world, realm_id, 1, 50);
    ResourceImpl::write_balance(ref world, explorer_id, 1, 75);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(
        [realm_id.into(), explorer_id.into()].span(),
        [].span(),
    );
    stop_cheat_caller_address(system_addr);

    // Write to any exclusive entity (not just the first) should fail.
    ResourceImpl::write_balance(ref world, explorer_id, 1, 0);
}

#[test]
fn test_finish_shard_unlocks_exclusive_and_shared() {
    let mut world = setup_world();
    let exclusive_id: ID = 42;
    let shared_id: ID = 99;
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 100);
    ResourceImpl::write_balance(ref world, shared_id, 1, 200);

    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard([exclusive_id.into()].span(), [shared_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Finish the shard.
    start_cheat_caller_address(system_addr, caller());
    dispatcher.finish_shard(1);
    stop_cheat_caller_address(system_addr);

    // Both entities should be writable again after finish.
    ResourceImpl::write_balance(ref world, exclusive_id, 1, 50);
    ResourceImpl::write_balance(ref world, shared_id, 1, 150);
    assert!(ResourceImpl::read_balance(ref world, exclusive_id, 1) == 50, "exclusive unlocked");
    assert!(ResourceImpl::read_balance(ref world, shared_id, 1) == 150, "shared unlocked");
}
