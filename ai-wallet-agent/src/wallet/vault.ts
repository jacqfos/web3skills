/**
 * Local encrypted vault for the user's secrets. Runs ONLY on the user's device.
 *
 * What is in here and why:
 *   - `rootSeed` (32 bytes): derives the user's `UserShareEncryptionKeys`
 *     (class-groups decryption key + ed25519 signing key). The Ika network
 *     stores the user's secret key share on-chain *encrypted to this key*;
 *     only this seed can decrypt it. Losing it = losing the ability to sign;
 *     leaking it (together with the owner key) = losing the zero-trust property.
 *   - `ownerSecretKey`: the Sui key that is the policy `owner` and pays for
 *     Ika transactions. In production, prefer a separate hardware/OS-keychain
 *     signer and keep only the root seed here.
 *
 * Encryption: scrypt(passphrase) -> AES-256-GCM. The passphrase is entered by
 * the user at approval time; the decrypted seed lives in memory only for the
 * duration of one signing flow and is zeroed afterwards.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export interface VaultSecrets {
	rootSeed: Uint8Array;
	ownerSecretKey: string; // bech32 `suiprivkey...`
}

interface VaultFile {
	version: 1;
	kdf: 'scrypt';
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

export function sealVault(secrets: VaultSecrets, passphrase: string): VaultFile {
	if (passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const plaintext = Buffer.from(
		JSON.stringify({ rootSeed: Buffer.from(secrets.rootSeed).toString('base64'), ownerSecretKey: secrets.ownerSecretKey }),
	);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	plaintext.fill(0);
	key.fill(0);
	return {
		version: 1,
		kdf: 'scrypt',
		salt: salt.toString('base64'),
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	};
}

export function openVault(file: VaultFile, passphrase: string): VaultSecrets {
	const key = scryptSync(passphrase.normalize('NFKC'), Buffer.from(file.salt, 'base64'), 32, SCRYPT);
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
		decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
		const plaintext = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]);
		const parsed = JSON.parse(plaintext.toString()) as { rootSeed: string; ownerSecretKey: string };
		plaintext.fill(0);
		return { rootSeed: new Uint8Array(Buffer.from(parsed.rootSeed, 'base64')), ownerSecretKey: parsed.ownerSecretKey };
	} catch {
		throw new Error('Wrong passphrase or corrupted vault.');
	} finally {
		key.fill(0);
	}
}

export async function saveVault(path: string, file: VaultFile) {
	await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export async function loadVault(path: string): Promise<VaultFile> {
	return JSON.parse(await readFile(path, 'utf8')) as VaultFile;
}

/** Best-effort wipe of secret material once a flow finishes. */
export function wipe(secrets: VaultSecrets) {
	secrets.rootSeed.fill(0);
	secrets.ownerSecretKey = '';
}
