import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

// Credential primitives deliberately have no Next.js dependency, so maintenance
// scripts can reuse the exact same hash format instead of re-implementing it.

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Hash format: `scrypt$N$r$p$salt$hash`. Recording the cost parameters inside the string is
// what makes the scheme maintainable: raising the cost later is a one-line change, old hashes
// keep verifying under their recorded parameters, and the login path transparently re-hashes
// them (see the auth route) so a stronger policy never locks an existing administrator out.
const HASH_PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// Node's crypto.scrypt defaults, written out so the stored string always describes exactly
// how a hash was produced instead of depending on the runtime's current defaults.
const COST = { N: 16384, r: 8, p: 1 } as const;

export function hashPassword(password: string) {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(password, salt, KEY_BYTES, COST).toString("hex");
  return `${HASH_PREFIX}$${COST.N}$${COST.r}$${COST.p}$${salt}$${hash}`;
}

// Hashes written before parameters were recorded (`salt:hash`). They keep verifying — and are
// upgraded on the next successful login — instead of silently breaking after this change.
export const isLegacyHash = (stored: string) => !stored.startsWith(`${HASH_PREFIX}$`);

// A tampered database row could ask the login thread for, say, N = 2^31 and scrypt would
// happily try to allocate gigabytes. Anything outside these bounds is treated as an invalid
// hash rather than an expensive computation.
function parseCost(n: number, r: number, p: number) {
  const ok = Number.isInteger(n) && Number.isInteger(r) && Number.isInteger(p) &&
    n >= 16384 && n <= 2097152 && r >= 8 && r <= 64 && p >= 1 && p <= 8;
  return ok ? { N: n, r, p } : null;
}

// Verification runs on every login attempt. scrypt takes ~100 ms and is deliberately
// memory-hard, so doing it synchronously would freeze the whole event loop for that long —
// and because a missing account is charged the same work, anyone could trigger it without
// knowing a valid username. The async form moves the same work onto the libuv thread pool,
// which costs nothing extra and keeps the single-threaded server responsive.
export function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  let salt: string;
  let expected: Buffer;
  let cost: { N: number; r: number; p: number };
  if (parts.length === 6 && parts[0] === HASH_PREFIX) {
    const cost2 = parseCost(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    if (!cost2 || !/^[0-9a-f]+$/i.test(parts[5]) || parts[5].length % 2 !== 0) return Promise.resolve(false);
    cost = cost2;
    salt = parts[4];
    expected = Buffer.from(parts[5], "hex");
  } else {
    const [legacySalt, legacyHash] = stored.split(":");
    if (!legacySalt || !legacyHash || !/^[0-9a-f]+$/i.test(legacyHash) || legacyHash.length % 2 !== 0) return Promise.resolve(false);
    cost = { N: COST.N, r: COST.r, p: COST.p };
    salt = legacySalt;
    expected = Buffer.from(legacyHash, "hex");
  }
  return new Promise(resolve => {
    scrypt(password, salt, expected.length, cost, (error, actual) => {
      resolve(!error && actual.length === expected.length && timingSafeEqual(actual, expected));
    });
  });
}

// Constant-time comparison on fixed-length digests, so a failure cannot be told apart
// from a success by response timing or by input length.
export function safeEqual(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export const validAdminUsername = (value: string) => /^[a-zA-Z0-9_-]{3,30}$/.test(value);

// Verification-plausibility bound, NOT the creation policy. Login only needs to know whether
// a submitted password is even in the range this system has ever issued; the creation policy
// below is deliberately stricter, and the split is what lets that policy tighten over time
// without ever locking an existing administrator out of the console.
export const validAdminPassword = (value: string) => value.length >= 8 && value.length <= 128;

// Short list of the passwords that appear first in every credential-stuffing list.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password1234",
  "1234567890", "12345678901", "123456789012", "1234567890123",
  "qwertyuiop", "qwerty12345", "administrator", "admin12345",
  "letmein1234", "iloveyou123", "welcome12345", "aura1234567",
]);

// Privileged-account creation policy, NIST 800-63B style: length over composition rules.
// 12+ characters, none of the top-of-every-list passwords, no low-entropy repeats, nothing
// containing the username. Applied only when a password is *chosen* (first-run initialisation,
// credential rotation) and never when one is verified.
export function strongAdminPassword(password: string, username = "") {
  if (password.length < 12 || password.length > 128) return false;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return false;
  // Fewer than four distinct characters: "aaaaaaaaaa", "ababababab" and similar.
  if (new Set(lower).size < 4) return false;
  if (username && lower.includes(username.toLowerCase())) return false;
  return true;
}
