// AES-256-GCM sealing for everything the vault writes to disk.
// Layout of a sealed value: "PST1" | 12-byte IV | 16-byte tag | ciphertext.

import crypto from 'node:crypto';

const MAGIC = Buffer.from('PST1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_BYTES = 32;

export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

export function parseKey(text: string): Buffer {
  const t = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('master key must be 32 bytes (64 hex chars or base64)');
  return key;
}

/** The master key never encrypts data directly; it only derives purpose-specific subkeys. */
export function dataKey(master: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'personalitystore/data/v1', KEY_BYTES));
}

/** `aad` names where the value lives (e.g. "doc:taste/food"), so ciphertexts can't be swapped between files. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < MAGIC.length + IV_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a vault ciphertext');
  }
  const ivEnd = MAGIC.length + IV_BYTES;
  const tagEnd = ivEnd + TAG_BYTES;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(MAGIC.length, ivEnd), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(ivEnd, tagEnd));
  return Buffer.concat([decipher.update(sealed.subarray(tagEnd)), decipher.final()]);
}

export const sealJson = (key: Buffer, value: unknown, aad: string): Buffer => seal(key, Buffer.from(JSON.stringify(value)), aad);
export const openJson = (key: Buffer, sealed: Buffer, aad: string): unknown => JSON.parse(open(key, sealed, aad).toString('utf8'));

/** One sealed JSON value per line, for append-only files (logbook, audit). */
export const sealLine = (key: Buffer, value: unknown, aad: string): string => sealJson(key, value, aad).toString('base64url');
export const openLine = (key: Buffer, line: string, aad: string): unknown => openJson(key, Buffer.from(line, 'base64url'), aad);

export const sha256 = (value: string): Buffer => crypto.createHash('sha256').update(value).digest();
