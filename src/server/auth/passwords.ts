/** Password hashing (scrypt) and constant-time verification. */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt parameters (~100ms per hash); stored with the digest so they can change later. */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 8;
/** Upper bound shared by the login endpoint and add_user, so every password set can also be used. */
export const MAX_PASSWORD_LENGTH = 1024;

/** Hash a password with scrypt: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/** Digests shorter than this are treated as corrupt (an empty digest would match anything). */
const MIN_DIGEST_LENGTH = 16;

/** Parse a stored digest; null when malformed or its cost parameters are out of bounds. */
function parseDigest(stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Bounds keep a tampered row from turning a login into a CPU/memory bomb.
  const isPowerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!isPowerOfTwo || !Number.isInteger(R) || R < 1 || R > 32 || !Number.isInteger(P) || P < 1 || P > 16) {
    return null;
  }
  const salt = Buffer.from(saltB64, "base64");
  const hash = Buffer.from(hashB64, "base64");
  if (salt.length === 0 || hash.length < MIN_DIGEST_LENGTH) return null;
  return { N, r: R, p: P, salt, hash };
}

/** Constant-time check of a password against a stored digest. Malformed digests never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const digest = parseDigest(stored);
  if (!digest) return false;
  try {
    const actual = await scrypt(password.normalize("NFKC"), digest.salt, digest.hash.length, {
      N: digest.N,
      r: digest.r,
      p: digest.p,
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(actual, digest.hash);
  } catch {
    return false;
  }
}

/** A throwaway digest used to equalise timing for unknown usernames. */
const DUMMY_HASH = [
  "scrypt",
  SCRYPT.N,
  SCRYPT.r,
  SCRYPT.p,
  randomBytes(SALT_LENGTH).toString("base64"),
  randomBytes(KEY_LENGTH).toString("base64"),
].join("$");

/**
 * Spend the same time as checking a real password, for logins with an unknown
 * username, so responses don't reveal which usernames exist. Always false.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}
