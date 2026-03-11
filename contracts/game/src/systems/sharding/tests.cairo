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

use dojo::model::{Model, ModelStorage};
use dojo::sharding::component::{IContractComponentDispatcher, IContractComponentDispatcherTrait};
use dojo::sharding::compute_dojo_field_slot;
use dojo::sharding::request::ShardModel;
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
use crate::models::resource::production::building::{Building, Population, StructureBuildings};
use crate::models::trade::Trade;
use crate::models::hyperstructure::HyperstructureRequirements;
use crate::models::position::Coord;
use crate::models::structure::{
    Structure, StructureCategory, Structure_fields,
};
use crate::models::config::WorldConfigUtilImpl;
use crate::systems::sharding::contracts::{
    IShardingSystemsDispatcher, IShardingSystemsDispatcherTrait, shard_helpers,
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
    // Set caller() as admin so sharding system auth checks pass
    WorldConfigUtilImpl::set_member(ref world, selector!("admin_address"), caller());
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

fn hyperstructure_needed_total_slot(hyperstructure_id: ID) -> felt252 {
    let model_selector = Model::<HyperstructureRequirements>::selector(ns_hash());
    let field_selector = selector!("needed_resource_total");
    let dojo_entity_id = entity_id_from_keys(@hyperstructure_id);
    compute_dojo_field_slot(model_selector, dojo_entity_id, field_selector)
}

fn caller() -> ContractAddress {
    0x1234_felt252.try_into().unwrap()
}

fn non_admin_caller() -> ContractAddress {
    0x5678_felt252.try_into().unwrap()
}

fn zero_address() -> ContractAddress {
    0x0_felt252.try_into().unwrap()
}

fn seed_realm_structure(ref world: WorldStorage, entity_id: ID, owner: ContractAddress, coord_x: u32, coord_y: u32) {
    let mut structure: Structure = Default::default();
    structure.entity_id = entity_id;
    structure.owner = owner;
    structure.base.troop_max_guard_count = 1;
    structure.base.troop_max_explorer_count = 1;
    structure.base.created_at = starknet::get_block_timestamp().try_into().unwrap();
    structure.base.category = StructureCategory::Realm.into();
    structure.base.coord_x = coord_x;
    structure.base.coord_y = coord_y;
    structure.base.level = 1;
    structure.metadata.realm_id = 1;
    structure.metadata.order = 1;
    structure.category = StructureCategory::Realm.into();
    world.write_model(@structure);
}

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
    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1, 3].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // Balances should remain readable and unchanged after locking.
    let stone = ResourceImpl::read_balance(ref world, entity_id, 1);
    let wood = ResourceImpl::read_balance(ref world, entity_id, 3);
    assert!(stone == 100, "STONE should be 100");
    assert!(wood == 200, "WOOD should be 200");
}

#[test]
#[should_panic(expected: "proxy must not be zero")]
fn test_request_shard_rejects_zero_proxy() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);
    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(zero_address(), models);
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "models must not be empty")]
fn test_request_shard_rejects_empty_models() {
    let mut world = setup_world();
    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);
    let empty_models: Array<ShardModel> = array![];

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, empty_models.span());
    stop_cheat_caller_address(system_addr);
}

/// SetLock now blocks regular main-chain writes while shard is active.
#[test]
#[should_panic]
fn test_set_lock_blocks_mainchain_write_during_active_shard() {
    let mut world = setup_world();
    let entity_id: ID = 42;

    // Initial balance: STONE=100
    ResourceImpl::write_balance(ref world, entity_id, 1, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    // Lock STONE (type 1) for the shard.
    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();
    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard(proxy_address, models);
    stop_cheat_caller_address(system_addr);

    // Main-chain gameplay write must fail while shard lock is active.
    ResourceImpl::write_balance(ref world, entity_id, 1, 80);
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

    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();
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
    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();
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

    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();
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

    let models = [shard_helpers::resource_with_set_lock(ns_hash(), entity_id, array![1].span())].span();
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

/// request_shard_all registers the expected shard-critical Eternum models.
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

/// request_shard_all_with_related_ids must register models keyed by related ids
/// (hyperstructure_id), not only realm entity_id.
#[test]
fn test_request_shard_all_with_related_ids_registers_hyperstructure_requirements() {
    let mut world = setup_world();
    let world_address = world.dispatcher.contract_address;
    let realm_entity_id: ID = 42;
    let hyperstructure_id: ID = 9001;

    let mut requirements: HyperstructureRequirements = Default::default();
    requirements.hyperstructure_id = hyperstructure_id;
    requirements.needed_resource_total = 1;
    world.write_model(@requirements);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher
        .request_shard_all_with_related_ids(
            proxy_address,
            array![realm_entity_id].span(),
            array![].span(),
            array![].span(),
            array![hyperstructure_id].span(),
        );
    stop_cheat_caller_address(system_addr);

    let hyper_slot = hyperstructure_needed_total_slot(hyperstructure_id);
    let sharding = IContractComponentDispatcher { contract_address: world_address };

    start_cheat_caller_address(world_address, proxy_address);
    sharding.update_shard_state(array![(hyper_slot, 555)]);
    stop_cheat_caller_address(world_address);

    let updated_requirements: HyperstructureRequirements = world.read_model(hyperstructure_id);
    assert!(
        updated_requirements.needed_resource_total == 555, "needed_resource_total should be updated via shard state",
    );
}

/// request_shard_all_with_related_ids registers Trade by trade_id without locking
/// main-chain writes (Set CRDT behavior).
#[test]
fn test_request_shard_all_with_related_ids_allows_trade_write() {
    let mut world = setup_world();
    let realm_entity_id: ID = 42;
    let trade_id: ID = 7001;

    world.write_model(
        @Trade {
            trade_id,
            maker_id: realm_entity_id,
            taker_id: 0,
            expires_at: 123,
            maker_gives_resource_type: 1,
            taker_pays_resource_type: 3,
            maker_gives_min_resource_amount: 10,
            taker_pays_min_resource_amount: 20,
            maker_gives_max_count: 3,
        },
    );

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher
        .request_shard_all_with_related_ids(
            proxy_address, array![realm_entity_id].span(), array![].span(), array![trade_id].span(), array![].span(),
        );
    stop_cheat_caller_address(system_addr);

    world.write_model(
        @Trade {
            trade_id,
            maker_id: 777,
            taker_id: 0,
            expires_at: 123,
            maker_gives_resource_type: 1,
            taker_pays_resource_type: 3,
            maker_gives_min_resource_amount: 10,
            taker_pays_min_resource_amount: 20,
            maker_gives_max_count: 3,
        },
    );

    let updated_trade: Trade = world.read_model(trade_id);
    assert!(updated_trade.maker_id == 777, "trade write should stay allowed for Set CRDT");
}

/// request_shard_all_with_related_ids registers HyperstructureRequirements by hyperstructure_id
/// without locking main-chain writes (Set CRDT behavior).
#[test]
fn test_request_shard_all_with_related_ids_allows_hyperstructure_requirements_write() {
    let mut world = setup_world();
    let realm_entity_id: ID = 42;
    let hyperstructure_id: ID = 9001;

    let mut requirements: HyperstructureRequirements = Default::default();
    requirements.hyperstructure_id = hyperstructure_id;
    requirements.needed_resource_total = 1;
    world.write_model(@requirements);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher
        .request_shard_all_with_related_ids(
            proxy_address, array![realm_entity_id].span(), array![].span(), array![].span(), array![hyperstructure_id].span(),
        );
    stop_cheat_caller_address(system_addr);

    requirements.needed_resource_total = 2;
    world.write_model(@requirements);

    let updated_requirements: HyperstructureRequirements = world.read_model(hyperstructure_id);
    assert!(
        updated_requirements.needed_resource_total == 2,
        "hyperstructure requirements write should stay allowed for Set CRDT",
    );
}

/// request_shard_all must block writes to the per-structure building summary model.
#[test]
#[should_panic]
fn test_request_shard_all_blocks_structure_buildings_write() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    seed_realm_structure(ref world, entity_id, caller(), 100, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(proxy_address, array![entity_id].span());
    stop_cheat_caller_address(system_addr);

    world.write_model(
        @StructureBuildings {
            entity_id,
            packed_counts_1: 1,
            packed_counts_2: 0,
            packed_counts_3: 0,
            population: Population { current: 1, max: 5 },
            coord: Coord { alt: false, x: 100, y: 100 },
        },
    );
}

/// request_shard_all must block writes to buildable hex slots around the realm.
#[test]
#[should_panic]
fn test_request_shard_all_blocks_building_slot_write() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    seed_realm_structure(ref world, entity_id, caller(), 100, 100);

    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(proxy_address, array![entity_id].span());
    stop_cheat_caller_address(system_addr);

    world.write_model(
        @Building {
            outer_col: 100,
            outer_row: 100,
            inner_col: 11,
            inner_row: 10,
            category: 3,
            bonus_percent: 0,
            entity_id: 999,
            outer_entity_id: entity_id,
            paused: false,
        },
    );
}

#[test]
#[should_panic(expected: "proxy must not be zero")]
fn test_request_shard_all_rejects_zero_proxy() {
    let mut world = setup_world();
    let entity_id: ID = 42;
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(zero_address(), array![entity_id].span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "entity_ids must not be empty")]
fn test_request_shard_all_rejects_empty_entity_ids() {
    let mut world = setup_world();
    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);
    let empty_entity_ids: Array<ID> = array![];

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(proxy_address, empty_entity_ids.span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "caller not admin")]
fn test_request_shard_all_rejects_non_admin_caller() {
    let mut world = setup_world();
    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, non_admin_caller());
    dispatcher.request_shard_all(proxy_address, array![42].span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "caller not admin")]
fn test_finish_shard_rejects_non_admin_caller() {
    let mut world = setup_world();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, non_admin_caller());
    dispatcher.finish_shard();
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "entity_ids exceeds limit")]
fn test_request_shard_all_rejects_entity_ids_over_limit() {
    let mut world = setup_world();
    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    start_cheat_caller_address(system_addr, caller());
    dispatcher.request_shard_all(proxy_address, array![42, 43].span());
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "trade_ids exceeds limit")]
fn test_request_shard_all_with_related_ids_rejects_trade_ids_over_limit() {
    let mut world = setup_world();
    let proxy_address = deploy_mock_proxy();
    let (system_addr, dispatcher) = get_sharding_dispatcher(ref world);

    let mut trade_ids: Array<ID> = ArrayTrait::new();
    let mut i: u32 = 0;
    loop {
        if i > 512 {
            break;
        }
        trade_ids.append(1000 + i);
        i += 1;
    };

    start_cheat_caller_address(system_addr, caller());
    dispatcher
        .request_shard_all_with_related_ids(
            proxy_address, array![42].span(), array![].span(), trade_ids.span(), array![].span(),
        );
    stop_cheat_caller_address(system_addr);
}

#[test]
#[should_panic(expected: "resource_types must not be empty")]
fn test_resource_with_set_lock_rejects_empty_resource_types() {
    let empty_resource_types: Array<u32> = array![];
    let _ = shard_helpers::resource_with_set_lock(ns_hash(), 42, empty_resource_types.span());
}

#[test]
#[should_panic(expected: "resource_type must be 1..=56, got invalid")]
fn test_resource_with_set_lock_rejects_out_of_range_type() {
    let _ = shard_helpers::resource_with_set_lock(ns_hash(), 42, array![57_u32].span());
}

#[test]
fn test_building_within_distance_registers_multiple_rings() {
    let outer_col: u32 = 111;
    let outer_row: u32 = 222;
    let models = shard_helpers::building_within_distance(ns_hash(), outer_col, outer_row, 2);

    // ring(1)=6, ring(2)=12 => total 18 slots
    assert!(models.len() == 18, "expected 18 building slots for distance=2, got {}", models.len());

    // Ensure a ring-2 slot exists (two East steps from center 10,10 => 12,10)
    let mut has_ring2_east = false;
    for model in models {
        if *model.keys.at(0) == outer_col.into()
            && *model.keys.at(1) == outer_row.into()
            && *model.keys.at(2) == 12
            && *model.keys.at(3) == 10 {
            has_ring2_east = true;
        }
    }

    assert!(has_ring2_east, "ring-2 slot (12,10) was not registered");
}

#[test]
fn test_building_within_distance_rejects_zero_distance() {
    let models = shard_helpers::building_within_distance(ns_hash(), 111, 222, 0);
    assert!(models.len() == 0, "expected 0 building slots for distance=0, got {}", models.len());
}
