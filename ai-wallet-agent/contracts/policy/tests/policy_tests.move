/// Unit tests for the policy checks and encoders.
/// Byte vectors were generated with viem / @solana/web3.js via the TS mirror
/// (see test/encoding.test.ts), so a pass here means Move == TS == viem.
#[test_only]
module wallet_policy::policy_tests;

use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};
use wallet_policy::evm;
use wallet_policy::oracle::{Self, OracleCap, PriceBook};
use wallet_policy::policy::{Self, Policy};
use wallet_policy::solana;

const OWNER: address = @0xA;
const ADMIN: address = @0xB;
const AGENT: address = @0xC;

const DAY_MS: u64 = 86_400_000;

const USDC: vector<u8> = x"a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH: vector<u8> = x"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ROUTER: vector<u8> = x"68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const ME: vector<u8> = x"1111111111111111111111111111111111111111";
const STRANGER: vector<u8> = x"2222222222222222222222222222222222222222";

const SOL_ME: vector<u8> = x"0101010101010101010101010101010101010101010101010101010101010101";
const SOL_DEST: vector<u8> = x"0202020202020202020202020202020202020202020202020202020202020202";
const SOL_BLOCKHASH: vector<u8> = x"0303030303030303030303030303030303030303030303030303030303030303";

const PRIO: u256 = 1_500_000_000;
const MAXFEE: u256 = 30_000_000_000;
const TENTH_ETH: u256 = 100_000_000_000_000_000;

// ---------- Encoder vectors ----------

#[test]
fun evm_native_transfer_vector() {
    let m = evm::eip1559_unsigned(1, 7, PRIO, MAXFEE, 21_000, ME, TENTH_ETH, vector[]);
    assert!(m == x"02f001078459682f008506fc23ac0082520894111111111111111111111111111111111111111188016345785d8a000080c0");
}

#[test]
fun evm_erc20_transfer_vector() {
    let data = evm::erc20_transfer_calldata(ME, 50_000_000);
    let m = evm::eip1559_unsigned(1, 7, PRIO, MAXFEE, 65_000, USDC, 0, data);
    assert!(m == x"02f86d01078459682f008506fc23ac0082fde894a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4880b844a9059cbb00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000002faf080c0");
}

#[test]
fun evm_swap_vector() {
    let data = evm::exact_input_single_calldata(USDC, WETH, 500, ME, 320_000_000, 99_000_000_000_000_000);
    let m = evm::eip1559_unsigned(1, 7, PRIO, MAXFEE, 200_000, ROUTER, 0, data);
    assert!(m == x"02f9010e01078459682f008506fc23ac0083030d409468b3465833fb72a70ecdf485e0e4c7bd8665fc4580b8e404e45aaf000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc200000000000000000000000000000000000000000000000000000000000001f40000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000001312d000000000000000000000000000000000000000000000000000015fb7f9b8c380000000000000000000000000000000000000000000000000000000000000000000c0");
}

#[test]
fun solana_transfer_vector() {
    let m = solana::system_transfer_message(SOL_ME, SOL_DEST, 1_000_000, SOL_BLOCKHASH);
    assert!(m == x"01000103010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020000000000000000000000000000000000000000000000000000000000000000030303030303030303030303030303030303030303030303030303030303030301020200010c0200000040420f0000000000");
}

// ---------- Fixtures ----------

fun default_rules(): policy::Rules {
    // $1,000/day, 10 tx/day, 1% slippage, prices valid 5 minutes
    let mut r = policy::new_rules(1_000_00000000, 10, 100, 300_000);
    policy::rules_allow_evm_chain(&mut r, 1, 50_000_000_000, 2_000_000_000, 300_000);
    policy::rules_add_token(&mut r, 0, 1, vector[], b"ETH", 18, 1_000_000_000_000_000_000);
    policy::rules_add_token(&mut r, 0, 1, USDC, b"USDC", 6, 1_000_000_000);
    policy::rules_add_token(&mut r, 0, 1, WETH, b"ETH", 18, 1_000_000_000_000_000_000);
    policy::rules_add_destination(&mut r, 0, 1, ME);
    policy::rules_add_router(&mut r, 1, ROUTER);
    policy::rules_allow_solana_cluster(&mut r, 103);
    policy::rules_add_token(&mut r, 1, 103, vector[], b"SOL", 9, 10_000_000_000);
    policy::rules_add_destination(&mut r, 1, 103, SOL_DEST);
    r
}

fun start(): (Scenario, Clock, OracleCap) {
    let mut sc = ts::begin(ADMIN);
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(1_000 * DAY_MS + 1_000);
    let cap = oracle::create(sc.ctx());
    sc.next_tx(ADMIN);
    {
        let mut book = sc.take_shared<PriceBook>();
        oracle::set_price(&mut book, &cap, b"ETH", 3_200_00000000, &clk);
        oracle::set_price(&mut book, &cap, b"USDC", 1_00000000, &clk);
        oracle::set_price(&mut book, &cap, b"SOL", 140_00000000, &clk);
        let mut p = policy::create(OWNER, ADMIN, &book, default_rules(), DAY_MS, sc.ctx());
        policy::set_chain_address_for_testing(&mut p, 2, SOL_ME);
        policy::share(p);
        ts::return_shared(book);
    };
    (sc, clk, cap)
}

fun finish(sc: Scenario, clk: Clock, cap: OracleCap) {
    clk.destroy_for_testing();
    oracle::destroy_cap_for_testing(cap);
    sc.end();
}

fun native_transfer(p: &mut Policy, book: &PriceBook, nonce: u64, to: vector<u8>, clk: &Clock, sc: &mut Scenario): vector<u8> {
    policy::check_evm_transfer(p, book, 1, nonce, PRIO, MAXFEE, 21_000, vector[], to, TENTH_ETH, b"p", clk, sc.ctx())
}

// ---------- Happy paths ----------

#[test]
fun owner_native_transfer_builds_expected_message() {
    let (mut sc, clk, cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    let m = native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    assert!(m == evm::eip1559_unsigned(1, 0, PRIO, MAXFEE, 21_000, ME, TENTH_ETH, vector[]));
    assert!(policy::spent_today_usd_e8(&p) == 320_00000000);
    assert!(policy::evm_nonce(&p, 1) == 1);
    ts::return_shared(p);
    ts::return_shared(book);
    finish(sc, clk, cap);
}

#[test]
fun swap_at_exactly_max_slippage_passes() {
    let (mut sc, clk, cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    // 320 USDC @ ETH $3200 -> 0.1 WETH expected; 1% floor = 0.099
    let m = policy::check_evm_swap_exact_in(
        &mut p, &book, 1, 0, PRIO, MAXFEE, 200_000, ROUTER, USDC, WETH, 500, ME,
        320_000_000, 99_000_000_000_000_000, b"p", &clk, sc.ctx(),
    );
    assert!(m.length() > 0);
    ts::return_shared(p);
    ts::return_shared(book);
    finish(sc, clk, cap);
}

#[test]
fun solana_transfer_uses_registered_from_address() {
    let (mut sc, clk, cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    let m = policy::check_solana_transfer(&mut p, &book, 103, SOL_DEST, 1_000_000, SOL_BLOCKHASH, b"p", &clk, sc.ctx());
    assert!(m == solana::system_transfer_message(SOL_ME, SOL_DEST, 1_000_000, SOL_BLOCKHASH));
    ts::return_shared(p);
    ts::return_shared(book);
    finish(sc, clk, cap);
}

#[test]
fun daily_window_resets_next_day() {
    let (mut sc, mut clk, cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    native_transfer(&mut p, &book, 1, ME, &clk, &mut sc);
    native_transfer(&mut p, &book, 2, ME, &clk, &mut sc); // $960 spent
    ts::return_shared(p);
    ts::return_shared(book);

    clk.increment_for_testing(DAY_MS);
    sc.next_tx(ADMIN);
    let mut book = sc.take_shared<PriceBook>();
    oracle::set_price(&mut book, &cap, b"ETH", 3_200_00000000, &clk);
    ts::return_shared(book);

    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 3, ME, &clk, &mut sc);
    assert!(policy::spent_today_usd_e8(&p) == 320_00000000);
    ts::return_shared(p);
    ts::return_shared(book);
    finish(sc, clk, cap);
}

// ---------- Hard limits ----------

#[test, expected_failure(abort_code = policy::ENotOwner)]
fun agent_cannot_authorize() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(AGENT);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    abort 999
}

#[test, expected_failure(abort_code = policy::EDestinationNotAllowed)]
fun unknown_destination_rejected() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 0, STRANGER, &clk, &mut sc);
    abort 999
}

#[test, expected_failure(abort_code = policy::EDailyUsdLimit)]
fun daily_usd_limit_enforced() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    native_transfer(&mut p, &book, 1, ME, &clk, &mut sc);
    native_transfer(&mut p, &book, 2, ME, &clk, &mut sc);
    native_transfer(&mut p, &book, 3, ME, &clk, &mut sc); // $1280 > $1000
    abort 999
}

#[test, expected_failure(abort_code = policy::ESlippageTooHigh)]
fun swap_beyond_max_slippage_rejected() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    policy::check_evm_swap_exact_in(
        &mut p, &book, 1, 0, PRIO, MAXFEE, 200_000, ROUTER, USDC, WETH, 500, ME,
        320_000_000, 98_000_000_000_000_000, b"p", &clk, sc.ctx(),
    );
    abort 999
}

#[test, expected_failure(abort_code = policy::EGasTooHigh)]
fun gas_cap_enforced() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    policy::check_evm_transfer(&mut p, &book, 1, 0, PRIO, 500_000_000_000, 21_000, vector[], ME, TENTH_ETH, b"p", &clk, sc.ctx());
    abort 999
}

#[test, expected_failure(abort_code = policy::EBadNonce)]
fun nonce_must_match() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 5, ME, &clk, &mut sc);
    abort 999
}

#[test, expected_failure(abort_code = policy::EPaused)]
fun paused_blocks_everything() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    policy::pause(&mut p, sc.ctx());
    native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    abort 999
}

#[test, expected_failure(abort_code = oracle::EStalePrice)]
fun stale_price_rejected() {
    let (mut sc, mut clk, _cap) = start();
    clk.increment_for_testing(300_001);
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    let book = sc.take_shared<PriceBook>();
    native_transfer(&mut p, &book, 0, ME, &clk, &mut sc);
    abort 999
}

// ---------- Rule changes ----------

#[test, expected_failure(abort_code = policy::ENotAdmin)]
fun owner_cannot_loosen_rules() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    policy::propose_rules(&mut p, default_rules(), &clk, sc.ctx());
    abort 999
}

#[test, expected_failure(abort_code = policy::ETimelockActive)]
fun loosening_is_timelocked() {
    let (mut sc, clk, _cap) = start();
    sc.next_tx(ADMIN);
    let mut p = sc.take_shared<Policy>();
    policy::propose_rules(&mut p, default_rules(), &clk, sc.ctx());
    policy::apply_rules(&mut p, &clk, sc.ctx());
    abort 999
}

#[test]
fun loosening_applies_after_timelock() {
    let (mut sc, mut clk, cap) = start();
    sc.next_tx(ADMIN);
    let mut p = sc.take_shared<Policy>();
    let mut r = default_rules();
    policy::rules_add_destination(&mut r, 0, 1, STRANGER);
    policy::propose_rules(&mut p, r, &clk, sc.ctx());
    clk.increment_for_testing(DAY_MS);
    policy::apply_rules(&mut p, &clk, sc.ctx());
    ts::return_shared(p);
    finish(sc, clk, cap);
}

#[test, expected_failure(abort_code = policy::ENotTightening)]
fun instant_path_cannot_raise_limit() {
    let (mut sc, _clk, _cap) = start();
    sc.next_tx(OWNER);
    let mut p = sc.take_shared<Policy>();
    policy::lower_daily_usd_limit(&mut p, 5_000_00000000, sc.ctx());
    abort 999
}
