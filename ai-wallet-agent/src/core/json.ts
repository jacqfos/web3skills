/** JSON helpers that round-trip bigint (used for proposals over HTTP and on disk). */

export function stringify(value: unknown, space?: number): string {
	return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v), space);
}

export function parse<T>(text: string): T {
	return JSON.parse(text, (_k, v) =>
		v && typeof v === 'object' && typeof v.$bigint === 'string' && Object.keys(v).length === 1
			? BigInt(v.$bigint)
			: v,
	) as T;
}
