import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

/** Ported verbatim from DESKTOP's src/main/lib/password-hash.ts — this is the exact scheme
 * Employee.pinHash/passwordHash rows already use, synced to this same Postgres database (Phase 1).
 * Kept as a duplicate file rather than a shared package, same convention already used for the
 * BusinessType value list across DESKTOP/SERVER/admin in this codebase. Cost 32768 (double Node's
 * own 16384 default) since these hashes now leave the device via cloud sync. */
const DEFAULT_COST = 32768;

/** Node's own default `maxmem` (32MB) is sized for its own default cost (16384) — scrypt's memory
 * requirement scales with cost, so 32768 needs ~32MB and trips the default limit outright. This
 * generous headroom means a future cost increase doesn't need this touched again. */
const MAX_MEM = 64 * 1024 * 1024;

/** Byte-for-byte the same output format as DESKTOP's hashSecret (`cost:salt:derived`) — needed now
 * that the Owner App can reset an employee's PIN (mobile-employees-service.ts). The hash reaches
 * every DESKTOP install via the normal employees pull, and DESKTOP's own verifySecret must accept it
 * exactly as if it had been created locally. */
export function hashSecret(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(plain, salt, KEY_LENGTH, { cost: DEFAULT_COST, maxmem: MAX_MEM }).toString("hex");
  return `${DEFAULT_COST}:${salt}:${derived}`;
}

/** Verifies a plain PIN/password against a hash produced by hashSecret (this one or DESKTOP's).
 * Handles both the current `cost:salt:derived` format and the original `salt:derived` format
 * (implicitly Node's own default cost of 16384). */
export function verifySecret(plain: string, stored: string): boolean {
  const parts = stored.split(":");
  const [cost, salt, derivedHex] =
    parts.length === 3 ? [Number(parts[0]), parts[1], parts[2]] : [16384, parts[0], parts[1]];
  if (!salt || !derivedHex || !Number.isFinite(cost)) return false;

  const candidate = scryptSync(plain, salt, KEY_LENGTH, { cost, maxmem: MAX_MEM });
  const expected = Buffer.from(derivedHex, "hex");
  if (candidate.length !== expected.length) return false;

  return timingSafeEqual(candidate, expected);
}
