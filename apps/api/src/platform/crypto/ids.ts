import { createHash, randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUID version 7: 48-bit Unix millisecond timestamp + random bits. Time-ordered,
 * so B-tree indexes on primary keys stay compact (decision D-13).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((timestamp >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Opaque, URL-safe secret (refresh tokens, invitation tokens). 32 bytes = 256 bits. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 digests; high-entropy secrets need no salt or slow hash. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomBase36(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += BASE36[byte % BASE36.length];
  return out;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
