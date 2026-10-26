/// Solana legacy-message builder for a single SystemProgram SOL transfer.
///
/// The dWallet (ed25519) signs this message directly (Ika EdDSA, hash SHA512 —
/// i.e. plain Ed25519). Mirrored by `src/core/encoding/solana.ts` and tested
/// against @solana/web3.js.
module wallet_policy::solana;

const EBadKey: u64 = 0;
const ESelfTransfer: u64 = 1;

/// SystemProgram id is the all-zero pubkey.
const SYSTEM_PROGRAM_ID: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000000";
/// SystemInstruction::Transfer discriminant (u32 LE).
const IX_TRANSFER: vector<u8> = x"02000000";

/// Legacy message layout:
/// header [1 signer, 0 ro-signed, 1 ro-unsigned]
/// accounts [from (signer, writable), to (writable), system program]
/// recent blockhash
/// 1 instruction: program 2, accounts [0, 1], data = Transfer(lamports)
public fun system_transfer_message(
    from: vector<u8>,
    to: vector<u8>,
    lamports: u64,
    recent_blockhash: vector<u8>,
): vector<u8> {
    assert!(from.length() == 32 && to.length() == 32, EBadKey);
    assert!(recent_blockhash.length() == 32, EBadKey);
    // With from == to the runtime would dedupe accounts and the layout changes.
    assert!(from != to, ESelfTransfer);

    let mut m = vector[1u8, 0, 1];
    m.push_back(3); // compact-u16 account count
    m.append(from);
    m.append(to);
    m.append(SYSTEM_PROGRAM_ID);
    m.append(recent_blockhash);
    m.push_back(1); // one instruction
    m.push_back(2); // program id index
    m.push_back(2); // two account indices
    m.push_back(0);
    m.push_back(1);
    m.push_back(12); // data length
    m.append(IX_TRANSFER);
    m.append(u64_le(lamports));
    m
}

fun u64_le(v: u64): vector<u8> {
    let mut out = vector[];
    let mut i = 0;
    while (i < 8) {
        out.push_back(((v >> ((i * 8) as u8)) & 0xff) as u8);
        i = i + 1;
    };
    out
}
