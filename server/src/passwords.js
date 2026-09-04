/* ============================================================
   Password hashing.

   scrypt from node's own crypto module. No dependency to install, no
   native build to fight on Windows, and it is a deliberately slow,
   memory-hard function: the whole point is that verifying one password
   costs a moment and guessing billions costs centuries.

   Never store a password. Store the hash and the salt.
   ============================================================ */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/* Cost parameters. N is the work factor; raising it makes both
   verification and attack proportionally slower. 2^15 lands around
   100ms per hash on ordinary hardware, which is the usual target. */
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(plain) {
    const salt = randomBytes(16).toString("hex");
    const derived = await scryptAsync(plain, salt, KEY_LENGTH, SCRYPT_OPTIONS);

    return { hash: derived.toString("hex"), salt };
}

/* Compares in constant time.

   A normal string comparison returns as soon as two bytes differ, and
   the time it took leaks how much of the guess was right. Over enough
   attempts that is enough to recover the value a byte at a time.
   timingSafeEqual always looks at every byte. */
export async function verifyPassword(plain, hash, salt) {
    if (!hash || !salt) return false;

    const derived = await scryptAsync(plain, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    const stored = Buffer.from(hash, "hex");

    if (stored.length !== derived.length) return false;

    return timingSafeEqual(stored, derived);
}

/* Minimum bar for a new password. Length carries far more real
   strength than character-class rules, which mostly push people
   towards Password1! and a sticky note. */
export function checkPasswordStrength(plain) {
    if (typeof plain !== "string" || plain.length < 12) {
        return "Password must be at least 12 characters";
    }

    if (/^(.)\1+$/.test(plain)) {
        return "Password cannot be a single repeated character";
    }

    return null;
}

/* A temporary password for a new account or a reset.

   Read aloud over a noisy shop floor, so the alphabet leaves out
   everything that gets misheard or miscopied: no O or 0, no I, l or 1,
   no S or 5. Grouped in fours because people transcribe chunks more
   reliably than a run of twelve characters.

   randomBytes, never Math.random: the latter is predictable and has no
   business anywhere near a credential. */
const SPEAKABLE = "ABCDEFGHJKMNPQRTUVWXYZ2346789";

export function generateTemporaryPassword() {
    const bytes = randomBytes(12);
    let out = "";

    for (let i = 0; i < 12; i++) {
        if (i > 0 && i % 4 === 0) out += "-";
        out += SPEAKABLE[bytes[i] % SPEAKABLE.length];
    }

    return out;
}
