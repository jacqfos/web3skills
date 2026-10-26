/// EVM transaction + calldata builders used by the policy.
///
/// Every function here is deterministic and mirrored byte-for-byte by
/// `src/core/encoding/evm.ts` (tested against viem). The wallet app rebuilds
/// the same bytes locally to show the user what they are approving.
module wallet_policy::evm;

use wallet_policy::rlp;

const EIP1559_TX_TYPE: u8 = 0x02;

/// ERC-20 `transfer(address,uint256)`
const SEL_ERC20_TRANSFER: vector<u8> = x"a9059cbb";
/// ERC-20 `approve(address,uint256)`
const SEL_ERC20_APPROVE: vector<u8> = x"095ea7b3";
/// Uniswap SwapRouter02
/// `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`
const SEL_EXACT_INPUT_SINGLE: vector<u8> = x"04e45aaf";

const EBadAddress: u64 = 0;
const EBadFeeTier: u64 = 1;

/// Unsigned EIP-1559 payload:
/// `0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, []])`.
/// This is the exact message passed to Ika with hash = KECCAK256.
public fun eip1559_unsigned(
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u256,
    max_fee_per_gas: u256,
    gas_limit: u256,
    to: vector<u8>,
    value: u256,
    data: vector<u8>,
): vector<u8> {
    assert!(to.length() == 20, EBadAddress);
    let items = vector[
        rlp::encode_u256(chain_id as u256),
        rlp::encode_u256(nonce as u256),
        rlp::encode_u256(max_priority_fee_per_gas),
        rlp::encode_u256(max_fee_per_gas),
        rlp::encode_u256(gas_limit),
        rlp::encode_bytes(to),
        rlp::encode_u256(value),
        rlp::encode_bytes(data),
        rlp::encode_list(vector[]), // empty access list
    ];
    let mut out = vector[EIP1559_TX_TYPE];
    out.append(rlp::encode_list(items));
    out
}

public fun erc20_transfer_calldata(recipient: vector<u8>, amount: u256): vector<u8> {
    let mut out = SEL_ERC20_TRANSFER;
    out.append(word_address(recipient));
    out.append(word_u256(amount));
    out
}

public fun erc20_approve_calldata(spender: vector<u8>, amount: u256): vector<u8> {
    let mut out = SEL_ERC20_APPROVE;
    out.append(word_address(spender));
    out.append(word_u256(amount));
    out
}

/// SwapRouter02.exactInputSingle with `sqrtPriceLimitX96 = 0` (no price limit;
/// slippage is bounded by `amount_out_minimum`, which the policy checks).
public fun exact_input_single_calldata(
    token_in: vector<u8>,
    token_out: vector<u8>,
    fee_tier: u32,
    recipient: vector<u8>,
    amount_in: u256,
    amount_out_minimum: u256,
): vector<u8> {
    assert!(fee_tier < (1 << 24), EBadFeeTier);
    let mut out = SEL_EXACT_INPUT_SINGLE;
    out.append(word_address(token_in));
    out.append(word_address(token_out));
    out.append(word_u256(fee_tier as u256));
    out.append(word_address(recipient));
    out.append(word_u256(amount_in));
    out.append(word_u256(amount_out_minimum));
    out.append(word_u256(0));
    out
}

/// Left-pad a 20-byte address to a 32-byte ABI word.
fun word_address(addr: vector<u8>): vector<u8> {
    assert!(addr.length() == 20, EBadAddress);
    let mut out = vector[];
    12u64.do!(|_| out.push_back(0));
    out.append(addr);
    out
}

/// 32-byte big-endian ABI word.
fun word_u256(v: u256): vector<u8> {
    let mut out = vector[];
    let mut i = 0;
    while (i < 32) {
        let shift = ((31 - i) * 8) as u8;
        out.push_back(((v >> shift) & 0xff) as u8);
        i = i + 1;
    };
    out
}
