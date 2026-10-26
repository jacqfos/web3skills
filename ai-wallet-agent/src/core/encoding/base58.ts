/** Minimal base58 (Bitcoin alphabet) for Solana pubkeys / blockhashes / signatures. */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let out = '';
	while (n > 0n) {
		out = ALPHABET[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = '1' + out;
	}
	return out;
}

export function base58Decode(s: string, expectedLength?: number): Uint8Array {
	let n = 0n;
	for (const c of s) {
		const v = INDEX.get(c);
		if (v === undefined) throw new Error(`invalid base58 character '${c}'`);
		n = n * 58n + v;
	}
	const bytes: number[] = [];
	while (n > 0n) {
		bytes.unshift(Number(n & 0xffn));
		n >>= 8n;
	}
	for (const c of s) {
		if (c !== '1') break;
		bytes.unshift(0);
	}
	const out = Uint8Array.from(bytes);
	if (expectedLength !== undefined && out.length !== expectedLength) {
		throw new Error(`expected ${expectedLength} bytes, got ${out.length}`);
	}
	return out;
}
