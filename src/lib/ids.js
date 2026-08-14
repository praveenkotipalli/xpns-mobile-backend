import { randomBytes } from 'node:crypto';

// No 0/O/1/I — these codes get read aloud and typed on a phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function inviteCode(length = 6) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Retry `insert` until the generated code is unique (unique index is the real guard). */
export async function withUniqueCode(insert, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await insert(inviteCode());
    } catch (err) {
      if (err.code === '23505' && i < attempts - 1) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique invite code');
}

/** Round to 2dp the way money should round, avoiding float dust like 0.1+0.2. */
export const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
