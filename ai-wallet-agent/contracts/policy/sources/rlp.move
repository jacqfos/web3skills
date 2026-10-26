/// Minimal RLP encoder — just enough to build EIP-1559 transactions on-chain.
///
/// The policy contract builds the exact bytes the dWallet signs. Nothing
/// off-chain (and in particular not the AI) gets to supply raw tx bytes.
module wallet_policy::rlp;

/// Big-endian, minimal-length bytes of `v` (empty for zero), as RLP requires
/// for integers.
public fun u256_to_min_be(v: u256): vector<u8> {
    let mut v = v;
    let mut out = vector[];
    while (v > 0) {
        out.push_back((v & 0xff) as u8);
        v = v >> 8;
    };
    out.reverse();
    out
}

/// RLP-encode a byte string.
public fun encode_bytes(b: vector<u8>): vector<u8> {
    let len = b.length();
    if (len == 1 && b[0] < 0x80) return b;
    let mut out = encode_length(len, 0x80);
    out.append(b);
    out
}

/// RLP-encode an unsigned integer.
public fun encode_u256(v: u256): vector<u8> {
    encode_bytes(u256_to_min_be(v))
}

/// RLP-encode a list whose items are already RLP-encoded.
public fun encode_list(items: vector<vector<u8>>): vector<u8> {
    let mut payload = vector[];
    items.do!(|item| payload.append(item));
    let mut out = encode_length(payload.length(), 0xc0);
    out.append(payload);
    out
}

fun encode_length(len: u64, offset: u8): vector<u8> {
    if (len < 56) {
        vector[offset + (len as u8)]
    } else {
        let len_bytes = u256_to_min_be(len as u256);
        let mut out = vector[offset + 55 + (len_bytes.length() as u8)];
        out.append(len_bytes);
        out
    }
}
