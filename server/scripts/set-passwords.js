/* ============================================================
   Sets a development password on every seeded account.

     npm run db:passwords

   DEVELOPMENT ONLY. Every account gets the same password, which is
   fine for a demo on one laptop and catastrophic anywhere else. In a
   real deployment people set their own password on first sign-in and
   this script does not exist.
   ============================================================ */

import { pool } from "../src/db.js";
import { hashPassword } from "../src/passwords.js";

const DEV_PASSWORD = "RidgelinePrecision2026";

try {
    const users = await pool.query(
        "select id, initials, full_name, role from users order by initials"
    );

    /* Hashing is deliberately slow, so do them in parallel rather than
       one after another. Eighteen accounts sequentially takes a while. */
    await Promise.all(users.rows.map(async (user) => {
        const { hash, salt } = await hashPassword(DEV_PASSWORD);

        await pool.query(`
            update users
               set password_hash = $2,
                   password_salt = $3,
                   must_change_password = true,
                   failed_attempts = 0,
                   locked_until = null
             where id = $1
        `, [user.id, hash, salt]);
    }));

    console.log("Set the development password on " + users.rowCount + " accounts.");
    console.log("");
    console.log("  Password for all of them:  " + DEV_PASSWORD);
    console.log("");
    console.log("  Sign in as, for example:");
    console.log("    r.sandoval@ridgeline.example    General Manager, every permission");
    console.log("    i.brannigan@ridgeline.example   Administrator, manages people");
    console.log("    s.parnell@ridgeline.example     Quality Manager");
    console.log("    r.vandermeer@ridgeline.example  Engineering Manager");
    console.log("    h.okafor@ridgeline.example      Design Engineer");
    console.log("    r.delacroix@ridgeline.example   Operator, six permissions");
} catch (error) {
    console.error("Failed: " + error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
