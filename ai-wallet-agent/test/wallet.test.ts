import { bcs } from '@mysten/sui/bcs';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from '../src/core/json.js';
import { openVault, sealVault } from '../src/wallet/vault.js';
import { explainMoveAbort } from '../src/core/errors.js';

describe('vault', () => {
	it('round-trips and rejects a wrong passphrase', () => {
		const rootSeed = new Uint8Array(32).map((_, i) => i);
		const file = sealVault({ rootSeed, ownerSecretKey: 'suiprivkey1test' }, 'correct horse battery');
		expect(JSON.stringify(file)).not.toContain('suiprivkey1test');
		const opened = openVault(file, 'correct horse battery');
		expect([...opened.rootSeed]).toEqual([...rootSeed]);
		expect(() => openVault(file, 'wrong passphrase!!')).toThrow(/Wrong passphrase/);
	}, 20_000);

	it('refuses short passphrases', () => {
		expect(() => sealVault({ rootSeed: new Uint8Array(32), ownerSecretKey: 'x' }, 'short')).toThrow();
	});
});

describe('helpers', () => {
	it('json round-trips bigint', () => {
		const v = { a: 1n << 200n, b: [3n], c: 'x' };
		expect(parse(stringify(v))).toEqual(v);
	});

	it('maps Move aborts to policy messages', () => {
		expect(explainMoveAbort('MoveAbort(MoveLocation { module: wallet_policy::policy, ... }, 7)')).toMatch(/EDailyUsdLimit/);
	});

	it('VecMap BCS layout used by the on-chain reader matches Sui (vector of entries)', () => {
		// Sui VecMap<u64,u64> { contents: vector<Entry{key,value}> } == vector<Entry>
		const Entry = bcs.struct('Entry', { key: bcs.u64(), value: bcs.u64() });
		const asStruct = bcs.struct('VecMap', { contents: bcs.vector(Entry) });
		const bytes = asStruct.serialize({ contents: [{ key: 1, value: 7 }] }).toBytes();
		expect(bcs.vector(Entry).parse(bytes)).toEqual([{ key: '1', value: '7' }]);
	});
});
