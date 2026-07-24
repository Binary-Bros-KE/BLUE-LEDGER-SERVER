import { scryptSync, timingSafeEqual } from "node:crypto";

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

/** Verifies a plain PIN/password against a hash produced by DESKTOP's hashSecret. Handles both the
 * current `cost:salt:derived` format and the original `salt:derived` format (implicitly Node's own
 * default cost of 16384). SERVER never hashes a new secret itself — only verifies ones synced down
 * from a device — so there is no matching hashSecret() here. */
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
