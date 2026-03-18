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
    dispatcher.request_shard([entity_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Balance should be unchanged after lock.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    assert!(stone == 100, "STONE should be 100 after shard init");
}

#[test]
#[should_panic(expected: "entity_ids must not be empty")]
fn test_request_shard_rejects_empty_entity_ids() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);
    let empty: Array<felt252> = array![];

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(empty.span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "caller not admin")]
fn test_request_shard_rejects_non_admin_caller() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, non_admin_caller());
    dispatcher.request_shard([42].span());
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
    dispatcher.request_shard([entity_id.into()].span());
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
    dispatcher.request_shard([entity_id.into()].span());
    stop_cheat_caller_address(system_addr);

    // Write to locked entity should fail.
    ResourceImpl::write_balance(ref world, entity_id, 1, 80);
}
