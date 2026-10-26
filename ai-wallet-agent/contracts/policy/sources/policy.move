/// Wallet policy: the only path to a dWallet signature.
///
/// The user's `DWalletCap` is wrapped inside `Policy` at creation time, so the
/// only way to obtain an Ika `MessageApproval` is through one of the
/// `authorize_*` functions below. Each of them:
///
///   1. checks the caller is the owner (the user's device key — never the AI),
///   2. checks every hard limit (chain, token, destination, per-tx size,
///      daily USD spend, daily tx count, slippage, gas caps, nonce),
///   3. BUILDS THE MESSAGE BYTES ITSELF from typed parameters, so no one can
///      smuggle in a different payload,
///   4. returns `coordinator::approve_message(...)` for exactly those bytes.
///
/// The approval is then consumed in the same PTB by Ika `request_sign`, which
/// also requires the user's partial signature computed from their decrypted
/// user share (zero-trust dWallet). If any check aborts, the whole PTB aborts
/// and nothing reaches the Ika network.
///
/// Roles:
///   - owner: hot key on the user's device; authorizes transactions within the
///     rules and may tighten rules / pause instantly.
///   - admin: cold key (hardware wallet / multisig); the only role that can
///     loosen rules, and only after `rule_timelock_ms`.
module wallet_policy::policy;

use ika_dwallet_2pc_mpc::coordinator::{Self, DWalletCoordinator};
use ika_dwallet_2pc_mpc::coordinator_inner::{DWalletCap, MessageApproval};
use sui::clock::Clock;
use sui::dynamic_object_field as dof;
use sui::event;
use sui::hash::keccak256;
use sui::vec_map::{Self, VecMap};
use sui::vec_set::{Self, VecSet};
use wallet_policy::evm;
use wallet_policy::oracle::PriceBook;
use wallet_policy::solana;

// === Ika algorithm ids (match @ika.xyz/sdk `hash-signature-validation`) ===
const CURVE_SECP256K1: u32 = 0;
const CURVE_ED25519: u32 = 2;
const SIG_ECDSA_SECP256K1: u32 = 0;
const SIG_EDDSA: u32 = 0;
const HASH_KECCAK256: u32 = 0;
const HASH_SHA512: u32 = 0;

// === Chains / actions ===
const CHAIN_EVM: u8 = 0;
const CHAIN_SOLANA: u8 = 1;

const ACTION_TRANSFER: u8 = 0;
const ACTION_APPROVE: u8 = 1;
const ACTION_SWAP: u8 = 2;

const MS_PER_DAY: u64 = 86_400_000;
const BPS: u256 = 10_000;
const U64_MAX: u256 = 18_446_744_073_709_551_615;

// === Errors ===
const ENotOwner: u64 = 0;
const ENotAdmin: u64 = 1;
const EPaused: u64 = 2;
const EChainNotAllowed: u64 = 3;
const ETokenNotAllowed: u64 = 4;
const EDestinationNotAllowed: u64 = 5;
const EAmountTooLarge: u64 = 6;
const EDailyUsdLimit: u64 = 7;
const EDailyTxLimit: u64 = 8;
const ESlippageTooHigh: u64 = 9;
const EGasTooHigh: u64 = 10;
const EBadNonce: u64 = 11;
const ERouterNotAllowed: u64 = 12;
const ENoDWallet: u64 = 13;
const EDWalletExists: u64 = 14;
const ETimelockActive: u64 = 15;
const ENothingPending: u64 = 16;
const EZeroAmount: u64 = 17;
const EWrongPriceBook: u64 = 18;
const ENotTightening: u64 = 19;
const ESameToken: u64 = 20;
const EAddressAlreadySet: u64 = 21;
const EAddressNotSet: u64 = 22;
const EBadSlippageRule: u64 = 23;

// === Types ===

/// EVM: `id` = EIP-155 chain id. Solana: `id` = cluster tag
/// (101 mainnet-beta, 102 testnet, 103 devnet).
public struct ChainKey has copy, drop, store {
    kind: u8,
    id: u64,
}

/// An address on a given chain. For tokens, an empty `address` = native asset.
public struct ChainAddress has copy, drop, store {
    chain: ChainKey,
    address: vector<u8>,
}

public struct TokenRule has copy, drop, store {
    /// Symbol in the PriceBook, e.g. b"ETH".
    oracle_symbol: vector<u8>,
    decimals: u8,
    /// Per-transaction cap in base units. Oracle-independent backstop.
    max_per_tx: u256,
}

public struct GasRule has copy, drop, store {
    max_fee_per_gas: u256,
    max_priority_fee_per_gas: u256,
    max_gas_limit: u256,
}

public struct Rules has copy, drop, store {
    max_daily_usd_e8: u64,
    max_tx_per_day: u64,
    max_slippage_bps: u64,
    max_price_age_ms: u64,
    chains: VecSet<ChainKey>,
    tokens: VecMap<ChainAddress, TokenRule>,
    destinations: VecSet<ChainAddress>,
    /// Swap routers (also the only allowed ERC-20 `approve` spenders).
    routers: VecSet<ChainAddress>,
    /// Gas caps per EVM chain id. Required for every allowed EVM chain:
    /// without it, gas fees could drain the native balance.
    evm_gas: VecMap<u64, GasRule>,
}

public struct DWalletInfo has copy, drop, store {
    /// Chain-native address/pubkey derived from the dWallet public output
    /// (set once by the owner after DKG; only used as the Solana fee payer).
    chain_address: Option<vector<u8>>,
}

public struct CapKey has copy, drop, store { curve: u32 }

public struct PendingRules has copy, drop, store {
    rules: Rules,
    effective_ms: u64,
}

public struct PendingWithdrawal has copy, drop, store {
    curve: u32,
    effective_ms: u64,
}

public struct Policy has key {
    id: UID,
    owner: address,
    admin: address,
    price_book: ID,
    rules: Rules,
    paused: bool,
    rule_timelock_ms: u64,
    pending_rules: Option<PendingRules>,
    pending_withdrawal: Option<PendingWithdrawal>,
    /// Current UTC day number and what has been spent in it.
    day: u64,
    spent_usd_e8: u64,
    tx_count: u64,
    /// Next expected nonce per EVM chain id.
    evm_nonces: VecMap<u64, u64>,
    /// curve -> info. The DWalletCap itself is a dynamic object field keyed by CapKey.
    dwallets: VecMap<u32, DWalletInfo>,
}

// === Events (the on-chain audit trail / transaction history) ===

public struct Authorized has copy, drop {
    policy: ID,
    proposal_id: vector<u8>,
    chain: ChainKey,
    action: u8,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u256,
    usd_e8: u64,
    day_spent_usd_e8: u64,
    message_digest: vector<u8>,
}

public struct RulesProposed has copy, drop { policy: ID, effective_ms: u64 }
public struct RulesApplied has copy, drop { policy: ID }
public struct RulesTightened has copy, drop { policy: ID, what: vector<u8> }
public struct PausedChanged has copy, drop { policy: ID, paused: bool }
public struct CapWithdrawalRequested has copy, drop { policy: ID, curve: u32, effective_ms: u64 }

// === Rules builder (callable from a PTB) ===

public fun new_rules(
    max_daily_usd_e8: u64,
    max_tx_per_day: u64,
    max_slippage_bps: u64,
    max_price_age_ms: u64,
): Rules {
    assert!((max_slippage_bps as u256) < BPS, EBadSlippageRule);
    Rules {
        max_daily_usd_e8,
        max_tx_per_day,
        max_slippage_bps,
        max_price_age_ms,
        chains: vec_set::empty(),
        tokens: vec_map::empty(),
        destinations: vec_set::empty(),
        routers: vec_set::empty(),
        evm_gas: vec_map::empty(),
    }
}

public fun rules_allow_evm_chain(
    r: &mut Rules,
    chain_id: u64,
    max_fee_per_gas: u256,
    max_priority_fee_per_gas: u256,
    max_gas_limit: u256,
) {
    r.chains.insert(ChainKey { kind: CHAIN_EVM, id: chain_id });
    r.evm_gas.insert(chain_id, GasRule { max_fee_per_gas, max_priority_fee_per_gas, max_gas_limit });
}

public fun rules_allow_solana_cluster(r: &mut Rules, cluster: u64) {
    r.chains.insert(ChainKey { kind: CHAIN_SOLANA, id: cluster });
}

public fun rules_add_token(
    r: &mut Rules,
    kind: u8,
    chain_id: u64,
    address: vector<u8>,
    oracle_symbol: vector<u8>,
    decimals: u8,
    max_per_tx: u256,
) {
    r.tokens.insert(
        ChainAddress { chain: ChainKey { kind, id: chain_id }, address },
        TokenRule { oracle_symbol, decimals, max_per_tx },
    );
}

public fun rules_add_destination(r: &mut Rules, kind: u8, chain_id: u64, address: vector<u8>) {
    r.destinations.insert(ChainAddress { chain: ChainKey { kind, id: chain_id }, address });
}

public fun rules_add_router(r: &mut Rules, chain_id: u64, address: vector<u8>) {
    r.routers.insert(ChainAddress { chain: ChainKey { kind: CHAIN_EVM, id: chain_id }, address });
}

// === Lifecycle ===

/// Create a policy. Typically in the same PTB as the dWallet DKG:
/// `create` -> `add_dwallet(cap)` -> `share`, so the cap is never held loose.
public fun create(
    owner: address,
    admin: address,
    price_book: &PriceBook,
    rules: Rules,
    rule_timelock_ms: u64,
    ctx: &mut TxContext,
): Policy {
    Policy {
        id: object::new(ctx),
        owner,
        admin,
        price_book: object::id(price_book),
        rules,
        paused: false,
        rule_timelock_ms,
        pending_rules: option::none(),
        pending_withdrawal: option::none(),
        day: 0,
        spent_usd_e8: 0,
        tx_count: 0,
        evm_nonces: vec_map::empty(),
        dwallets: vec_map::empty(),
    }
}

public fun share(policy: Policy) {
    transfer::share_object(policy);
}

/// Lock a dWallet cap into the policy. One dWallet per curve.
public fun add_dwallet(policy: &mut Policy, cap: DWalletCap, curve: u32, ctx: &TxContext) {
    assert_owner(policy, ctx);
    assert!(!policy.dwallets.contains(&curve), EDWalletExists);
    policy.dwallets.insert(curve, DWalletInfo { chain_address: option::none() });
    dof::add(&mut policy.id, CapKey { curve }, cap);
}

/// Record the chain address derived from the dWallet public key (set once).
public fun set_chain_address(policy: &mut Policy, curve: u32, chain_address: vector<u8>, ctx: &TxContext) {
    assert_owner(policy, ctx);
    assert!(policy.dwallets.contains(&curve), ENoDWallet);
    let info = policy.dwallets.get_mut(&curve);
    assert!(info.chain_address.is_none(), EAddressAlreadySet);
    info.chain_address = option::some(chain_address);
}

/// Resync the expected nonce (e.g. a signed tx was never broadcast).
/// Safe: every signature is still charged against the daily limits.
public fun set_evm_nonce(policy: &mut Policy, chain_id: u64, nonce: u64, ctx: &TxContext) {
    assert_owner(policy, ctx);
    set_nonce(policy, chain_id, nonce);
}

// === Authorization: the only paths to a MessageApproval ===

/// Native ETH (token = empty) or ERC-20 transfer on an EVM chain.
public fun authorize_evm_transfer(
    policy: &mut Policy,
    coordinator: &mut DWalletCoordinator,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    token: vector<u8>,
    recipient: vector<u8>,
    amount: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): MessageApproval {
    let message = check_evm_transfer(
        policy, prices, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
        token, recipient, amount, proposal_id, clock, ctx,
    );
    approve(policy, coordinator, CURVE_SECP256K1, SIG_ECDSA_SECP256K1, HASH_KECCAK256, message)
}

/// ERC-20 approve, only to an allow-listed router, at most `max_per_tx`.
public fun authorize_evm_erc20_approve(
    policy: &mut Policy,
    coordinator: &mut DWalletCoordinator,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    token: vector<u8>,
    spender: vector<u8>,
    amount: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): MessageApproval {
    let message = check_evm_erc20_approve(
        policy, prices, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
        token, spender, amount, proposal_id, clock, ctx,
    );
    approve(policy, coordinator, CURVE_SECP256K1, SIG_ECDSA_SECP256K1, HASH_KECCAK256, message)
}

/// Uniswap V3 exactInputSingle on an allow-listed router, with on-chain
/// slippage enforcement against oracle prices.
public fun authorize_evm_swap_exact_in(
    policy: &mut Policy,
    coordinator: &mut DWalletCoordinator,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    router: vector<u8>,
    token_in: vector<u8>,
    token_out: vector<u8>,
    fee_tier: u32,
    recipient: vector<u8>,
    amount_in: u256,
    min_amount_out: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): MessageApproval {
    let message = check_evm_swap_exact_in(
        policy, prices, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
        router, token_in, token_out, fee_tier, recipient, amount_in, min_amount_out, proposal_id,
        clock, ctx,
    );
    approve(policy, coordinator, CURVE_SECP256K1, SIG_ECDSA_SECP256K1, HASH_KECCAK256, message)
}

/// Native SOL transfer.
public fun authorize_solana_transfer(
    policy: &mut Policy,
    coordinator: &mut DWalletCoordinator,
    prices: &PriceBook,
    cluster: u64,
    recipient: vector<u8>,
    lamports: u64,
    recent_blockhash: vector<u8>,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): MessageApproval {
    let message = check_solana_transfer(
        policy, prices, cluster, recipient, lamports, recent_blockhash, proposal_id, clock, ctx,
    );
    approve(policy, coordinator, CURVE_ED25519, SIG_EDDSA, HASH_SHA512, message)
}

// === Checks (package-visible so they are unit-testable without Ika objects) ===

public(package) fun check_evm_transfer(
    policy: &mut Policy,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    token: vector<u8>,
    recipient: vector<u8>,
    amount: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): vector<u8> {
    begin(policy, prices, clock, ctx);
    let chain = ChainKey { kind: CHAIN_EVM, id: chain_id };
    check_evm_envelope(policy, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit);
    assert!(amount > 0, EZeroAmount);
    assert_destination(policy, chain, recipient);
    let usd_e8 = value_usd_e8(policy, prices, chain, token, amount, clock);
    charge(policy, usd_e8);

    let message = if (token.is_empty()) {
        evm::eip1559_unsigned(
            chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
            recipient, amount, vector[],
        )
    } else {
        evm::eip1559_unsigned(
            chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
            token, 0, evm::erc20_transfer_calldata(recipient, amount),
        )
    };
    set_nonce(policy, chain_id, nonce + 1);
    emit_authorized(policy, proposal_id, chain, ACTION_TRANSFER, token, recipient, amount, usd_e8, &message);
    message
}

public(package) fun check_evm_erc20_approve(
    policy: &mut Policy,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    token: vector<u8>,
    spender: vector<u8>,
    amount: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): vector<u8> {
    begin(policy, prices, clock, ctx);
    let chain = ChainKey { kind: CHAIN_EVM, id: chain_id };
    check_evm_envelope(policy, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit);
    assert!(!token.is_empty(), ETokenNotAllowed);
    assert!(policy.rules.routers.contains(&ChainAddress { chain, address: spender }), ERouterNotAllowed);
    let rule = token_rule(policy, chain, token);
    assert!(amount <= rule.max_per_tx, EAmountTooLarge);
    // An allowance moves no funds by itself; it still counts as a transaction.
    charge(policy, 0);

    let message = evm::eip1559_unsigned(
        chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
        token, 0, evm::erc20_approve_calldata(spender, amount),
    );
    set_nonce(policy, chain_id, nonce + 1);
    emit_authorized(policy, proposal_id, chain, ACTION_APPROVE, token, spender, amount, 0, &message);
    message
}

public(package) fun check_evm_swap_exact_in(
    policy: &mut Policy,
    prices: &PriceBook,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    router: vector<u8>,
    token_in: vector<u8>,
    token_out: vector<u8>,
    fee_tier: u32,
    recipient: vector<u8>,
    amount_in: u256,
    min_amount_out: u256,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): vector<u8> {
    begin(policy, prices, clock, ctx);
    let chain = ChainKey { kind: CHAIN_EVM, id: chain_id };
    check_evm_envelope(policy, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit);
    assert!(amount_in > 0, EZeroAmount);
    // v1: ERC-20 -> ERC-20 only (use WETH for ETH).
    assert!(!token_in.is_empty() && !token_out.is_empty(), ETokenNotAllowed);
    assert!(token_in != token_out, ESameToken);
    assert!(policy.rules.routers.contains(&ChainAddress { chain, address: router }), ERouterNotAllowed);
    assert_destination(policy, chain, recipient);

    // Value of what we sell (also enforces token_in allow-list + per-tx cap).
    let usd_e8 = value_usd_e8(policy, prices, chain, token_in, amount_in, clock);

    // Slippage: min_out must be within max_slippage_bps of the oracle-implied output.
    let rule_in = token_rule(policy, chain, token_in);
    let rule_out = token_rule(policy, chain, token_out);
    let p_in = price(policy, prices, &rule_in, clock) as u256;
    let p_out = price(policy, prices, &rule_out, clock) as u256;
    let expected_out =
        (amount_in * p_in * pow10(rule_out.decimals)) / (p_out * pow10(rule_in.decimals));
    let floor = expected_out * (BPS - (policy.rules.max_slippage_bps as u256));
    assert!(min_amount_out * BPS >= floor, ESlippageTooHigh);

    charge(policy, usd_e8);

    let data = evm::exact_input_single_calldata(
        token_in, token_out, fee_tier, recipient, amount_in, min_amount_out,
    );
    let message = evm::eip1559_unsigned(
        chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, router, 0, data,
    );
    set_nonce(policy, chain_id, nonce + 1);
    emit_authorized(policy, proposal_id, chain, ACTION_SWAP, token_in, recipient, amount_in, usd_e8, &message);
    message
}

public(package) fun check_solana_transfer(
    policy: &mut Policy,
    prices: &PriceBook,
    cluster: u64,
    recipient: vector<u8>,
    lamports: u64,
    recent_blockhash: vector<u8>,
    proposal_id: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): vector<u8> {
    begin(policy, prices, clock, ctx);
    let chain = ChainKey { kind: CHAIN_SOLANA, id: cluster };
    assert!(policy.rules.chains.contains(&chain), EChainNotAllowed);
    assert!(lamports > 0, EZeroAmount);
    assert_destination(policy, chain, recipient);
    let usd_e8 = value_usd_e8(policy, prices, chain, vector[], lamports as u256, clock);
    charge(policy, usd_e8);

    assert!(policy.dwallets.contains(&CURVE_ED25519), ENoDWallet);
    let info = policy.dwallets.get(&CURVE_ED25519);
    assert!(info.chain_address.is_some(), EAddressNotSet);
    let from = *info.chain_address.borrow();
    let message = solana::system_transfer_message(from, recipient, lamports, recent_blockhash);
    emit_authorized(
        policy, proposal_id, chain, ACTION_TRANSFER, vector[], recipient, lamports as u256, usd_e8, &message,
    );
    message
}

// === Instant tightening (owner or admin) ===

public fun pause(policy: &mut Policy, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    policy.paused = true;
    event::emit(PausedChanged { policy: object::id(policy), paused: true });
}

public fun remove_destination(policy: &mut Policy, kind: u8, chain_id: u64, address: vector<u8>, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    policy.rules.destinations.remove(&ChainAddress { chain: ChainKey { kind, id: chain_id }, address });
    event::emit(RulesTightened { policy: object::id(policy), what: b"destination" });
}

public fun remove_token(policy: &mut Policy, kind: u8, chain_id: u64, address: vector<u8>, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    policy.rules.tokens.remove(&ChainAddress { chain: ChainKey { kind, id: chain_id }, address });
    event::emit(RulesTightened { policy: object::id(policy), what: b"token" });
}

public fun lower_daily_usd_limit(policy: &mut Policy, max_daily_usd_e8: u64, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    assert!(max_daily_usd_e8 <= policy.rules.max_daily_usd_e8, ENotTightening);
    policy.rules.max_daily_usd_e8 = max_daily_usd_e8;
    event::emit(RulesTightened { policy: object::id(policy), what: b"daily_usd" });
}

public fun lower_max_slippage(policy: &mut Policy, max_slippage_bps: u64, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    assert!(max_slippage_bps <= policy.rules.max_slippage_bps, ENotTightening);
    policy.rules.max_slippage_bps = max_slippage_bps;
    event::emit(RulesTightened { policy: object::id(policy), what: b"slippage" });
}

// === Timelocked loosening (admin only) ===

public fun unpause(policy: &mut Policy, ctx: &TxContext) {
    assert_admin(policy, ctx);
    policy.paused = false;
    event::emit(PausedChanged { policy: object::id(policy), paused: false });
}

public fun propose_rules(policy: &mut Policy, rules: Rules, clock: &Clock, ctx: &TxContext) {
    assert_admin(policy, ctx);
    assert!((rules.max_slippage_bps as u256) < BPS, EBadSlippageRule);
    let effective_ms = clock.timestamp_ms() + policy.rule_timelock_ms;
    policy.pending_rules = option::some(PendingRules { rules, effective_ms });
    event::emit(RulesProposed { policy: object::id(policy), effective_ms });
}

public fun apply_rules(policy: &mut Policy, clock: &Clock, ctx: &TxContext) {
    assert_admin(policy, ctx);
    assert!(policy.pending_rules.is_some(), ENothingPending);
    let PendingRules { rules, effective_ms } = policy.pending_rules.extract();
    assert!(clock.timestamp_ms() >= effective_ms, ETimelockActive);
    policy.rules = rules;
    event::emit(RulesApplied { policy: object::id(policy) });
}

/// Either role can cancel — the owner sees the RulesProposed event and can veto.
public fun cancel_pending_rules(policy: &mut Policy, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    policy.pending_rules = option::none();
}

/// Migrating the dWallet out of the policy is the ultimate "loosening",
/// so it is timelocked like any rule change.
public fun request_cap_withdrawal(policy: &mut Policy, curve: u32, clock: &Clock, ctx: &TxContext) {
    assert_admin(policy, ctx);
    assert!(policy.dwallets.contains(&curve), ENoDWallet);
    let effective_ms = clock.timestamp_ms() + policy.rule_timelock_ms;
    policy.pending_withdrawal = option::some(PendingWithdrawal { curve, effective_ms });
    event::emit(CapWithdrawalRequested { policy: object::id(policy), curve, effective_ms });
}

public fun cancel_cap_withdrawal(policy: &mut Policy, ctx: &TxContext) {
    assert_owner_or_admin(policy, ctx);
    policy.pending_withdrawal = option::none();
}

public fun withdraw_cap(policy: &mut Policy, clock: &Clock, ctx: &TxContext): DWalletCap {
    assert_admin(policy, ctx);
    assert!(policy.pending_withdrawal.is_some(), ENothingPending);
    let PendingWithdrawal { curve, effective_ms } = policy.pending_withdrawal.extract();
    assert!(clock.timestamp_ms() >= effective_ms, ETimelockActive);
    policy.dwallets.remove(&curve);
    dof::remove(&mut policy.id, CapKey { curve })
}

// === Views ===

public fun owner(p: &Policy): address { p.owner }
public fun admin(p: &Policy): address { p.admin }
public fun is_paused(p: &Policy): bool { p.paused }
public fun spent_today_usd_e8(p: &Policy): u64 { p.spent_usd_e8 }
public fun tx_count_today(p: &Policy): u64 { p.tx_count }
public fun rules(p: &Policy): &Rules { &p.rules }
public fun evm_nonce(p: &Policy, chain_id: u64): u64 {
    if (p.evm_nonces.contains(&chain_id)) *p.evm_nonces.get(&chain_id) else 0
}

// === Internals ===

fun approve(
    policy: &Policy,
    coordinator: &mut DWalletCoordinator,
    curve: u32,
    signature_algorithm: u32,
    hash_scheme: u32,
    message: vector<u8>,
): MessageApproval {
    let key = CapKey { curve };
    assert!(dof::exists_(&policy.id, key), ENoDWallet);
    let cap: &DWalletCap = dof::borrow(&policy.id, key);
    coordinator::approve_message(coordinator, cap, signature_algorithm, hash_scheme, message)
}

/// Common prologue: caller, pause, oracle identity, daily window rollover.
fun begin(policy: &mut Policy, prices: &PriceBook, clock: &Clock, ctx: &TxContext) {
    assert_owner(policy, ctx);
    assert!(!policy.paused, EPaused);
    assert!(object::id(prices) == policy.price_book, EWrongPriceBook);
    let today = clock.timestamp_ms() / MS_PER_DAY;
    if (today != policy.day) {
        policy.day = today;
        policy.spent_usd_e8 = 0;
        policy.tx_count = 0;
    };
}

fun check_evm_envelope(
    policy: &Policy,
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
) {
    assert!(policy.rules.chains.contains(&ChainKey { kind: CHAIN_EVM, id: chain_id }), EChainNotAllowed);
    assert!(policy.rules.evm_gas.contains(&chain_id), EChainNotAllowed);
    let gas = policy.rules.evm_gas.get(&chain_id);
    assert!(max_fee_per_gas <= gas.max_fee_per_gas, EGasTooHigh);
    assert!(max_priority_fee_per_gas <= gas.max_priority_fee_per_gas, EGasTooHigh);
    assert!(max_priority_fee_per_gas <= max_fee_per_gas, EGasTooHigh);
    assert!(gas_limit <= gas.max_gas_limit, EGasTooHigh);
    assert!(nonce == evm_nonce(policy, chain_id), EBadNonce);
}

fun assert_destination(policy: &Policy, chain: ChainKey, address: vector<u8>) {
    assert!(policy.rules.destinations.contains(&ChainAddress { chain, address }), EDestinationNotAllowed);
}

fun token_rule(policy: &Policy, chain: ChainKey, token: vector<u8>): TokenRule {
    let key = ChainAddress { chain, address: token };
    assert!(policy.rules.tokens.contains(&key), ETokenNotAllowed);
    *policy.rules.tokens.get(&key)
}

fun price(policy: &Policy, prices: &PriceBook, rule: &TokenRule, clock: &Clock): u64 {
    wallet_policy::oracle::price_usd_e8(prices, rule.oracle_symbol, policy.rules.max_price_age_ms, clock)
}

/// USD value (8 decimals) of `amount` base units. Also enforces allow-list + per-tx cap.
fun value_usd_e8(
    policy: &Policy,
    prices: &PriceBook,
    chain: ChainKey,
    token: vector<u8>,
    amount: u256,
    clock: &Clock,
): u64 {
    let rule = token_rule(policy, chain, token);
    assert!(amount <= rule.max_per_tx, EAmountTooLarge);
    let p = price(policy, prices, &rule, clock) as u256;
    let usd = (amount * p) / pow10(rule.decimals);
    assert!(usd <= U64_MAX, EDailyUsdLimit);
    usd as u64
}

fun charge(policy: &mut Policy, usd_e8: u64) {
    assert!(policy.tx_count + 1 <= policy.rules.max_tx_per_day, EDailyTxLimit);
    assert!(
        (policy.spent_usd_e8 as u256) + (usd_e8 as u256) <= (policy.rules.max_daily_usd_e8 as u256),
        EDailyUsdLimit,
    );
    policy.tx_count = policy.tx_count + 1;
    policy.spent_usd_e8 = policy.spent_usd_e8 + usd_e8;
}

fun set_nonce(policy: &mut Policy, chain_id: u64, nonce: u64) {
    if (policy.evm_nonces.contains(&chain_id)) {
        *policy.evm_nonces.get_mut(&chain_id) = nonce;
    } else {
        policy.evm_nonces.insert(chain_id, nonce);
    }
}

fun emit_authorized(
    policy: &Policy,
    proposal_id: vector<u8>,
    chain: ChainKey,
    action: u8,
    asset: vector<u8>,
    destination: vector<u8>,
    amount: u256,
    usd_e8: u64,
    message: &vector<u8>,
) {
    event::emit(Authorized {
        policy: object::id(policy),
        proposal_id,
        chain,
        action,
        asset,
        destination,
        amount,
        usd_e8,
        day_spent_usd_e8: policy.spent_usd_e8,
        message_digest: keccak256(message),
    });
}

fun pow10(d: u8): u256 {
    let mut r = 1u256;
    let mut i = 0u8;
    while (i < d) {
        r = r * 10;
        i = i + 1;
    };
    r
}

fun assert_owner(policy: &Policy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
}

fun assert_admin(policy: &Policy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.admin, ENotAdmin);
}

fun assert_owner_or_admin(policy: &Policy, ctx: &TxContext) {
    let s = ctx.sender();
    assert!(s == policy.owner || s == policy.admin, ENotOwner);
}

#[test_only]
/// Registers chain metadata without a real DWalletCap (Ika caps cannot be minted in unit tests).
public fun set_chain_address_for_testing(policy: &mut Policy, curve: u32, chain_address: vector<u8>) {
    policy.dwallets.insert(curve, DWalletInfo { chain_address: option::some(chain_address) });
}

#[test_only]
public fun destroy_for_testing(policy: Policy) {
    let Policy { id, .. } = policy;
    id.delete();
}
