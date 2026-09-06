/* ============================================================
   Supplier quality scoring, clause 8.4.

   ppm and grade used to be numbers typed into seed data once and
   never touched again - real for a demo, useless the moment a real
   customer's actual receiving history diverged from it. This computes
   both live, from the same receipts and SCARs every other screen
   already writes to, with one deliberate exception: a vendor with too
   little receiving volume to make a percentage mean anything keeps
   its entered figure rather than reporting something like "1,000,000
   PPM" off a single bad receipt of sixty pieces. The same honesty the
   quality objectives endpoint already applies (measurement: computed
   vs entered) applies here.
   ============================================================ */

import { query } from "./db.js";

/* Both have to be true before a computed ppm is trusted over an
   entered one: enough units for a percentage to mean anything, and
   enough separate receipts that one unusual lot cannot single-
   handedly define a vendor's whole rating. A vendor rejected once for
   a paperwork issue on their only dispositioned receipt is not yet a
   100%-defective supplier - that is one incident, not a record. */
const MIN_VOLUME_FOR_LIVE_PPM = 500;
const MIN_RECEIPTS_FOR_LIVE_PPM = 3;

export function gradeFromPpm(ppm) {
    if (ppm <= 500) return "A";
    if (ppm <= 2000) return "B";
    if (ppm <= 8000) return "C";
    return "D";
}

/* Every vendor in an org, real ppm/grade where there is enough
   receiving history to compute one, the entered figure otherwise -
   but an open SCAR caps the grade at C regardless of which, since
   "under an active corrective action" is a fact real either way. */
export async function scoredVendors(orgId) {
    const result = await query(`
        select v.id, v.name, v.scope, v.cert_type, v.cert_expires, v.otd_pct, v.status,
               v.ppm as stored_ppm, v.grade as stored_grade,
               coalesce(sum(rc.qty_received) filter (where rc.status in ('accept', 'reject')), 0)::int as qty_inspected,
               coalesce(sum(rc.qty_received) filter (where rc.status = 'reject'), 0)::int as qty_rejected,
               count(rc.id) filter (where rc.status in ('accept', 'reject'))::int as dispositioned_receipts,
               (select count(*)::int
                  from records r join record_types rt on rt.id = r.record_type_id
                 where rt.key = 'scar' and r.org_id = v.org_id and r.closed_at is null
                   and r.data->>'vendor' = v.name) as open_scars
          from vendors v
     left join receipts rc on rc.vendor_id = v.id
         where v.org_id = $1
         group by v.id
         order by v.name
    `, [orgId]);

    return result.rows.map((row) => {
        const enoughVolume = row.qty_inspected >= MIN_VOLUME_FOR_LIVE_PPM
            && row.dispositioned_receipts >= MIN_RECEIPTS_FOR_LIVE_PPM;

        /* Computed and entered are two complete, separate pairs, never
           mixed - an entered grade of D means D, even if the entered
           ppm alone would compute to a C. Trusting one entered figure
           while silently recalculating the other from it is worse
           than trusting neither. */
        let ppm, grade;
        if (enoughVolume) {
            ppm = Math.round(1000000 * row.qty_rejected / row.qty_inspected);
            grade = gradeFromPpm(ppm);
        } else {
            ppm = row.stored_ppm !== null ? Number(row.stored_ppm) : null;
            grade = row.stored_grade;
        }

        if (row.open_scars > 0 && (grade === "A" || grade === "B")) grade = "C";

        return {
            id: row.id,
            name: row.name,
            scope: row.scope,
            cert_type: row.cert_type,
            cert_expires: row.cert_expires,
            otd_pct: row.otd_pct,
            status: row.status,
            ppm,
            grade,
            open_scars: row.open_scars,
            scoring: enoughVolume ? "computed" : "entered"
        };
    });
}

/* ANSI/ASQ Z1.4-style receiving sampling, tightened as a vendor's
   real record gets worse - exactly the rule already written as a
   comment on the receipts table's own sample_plan column, made real.
   A grade this project cannot compute yet (brand new vendor, nothing
   received from them) is sampled like an unproven one, not a trusted
   one. */
export function samplePlanForGrade(grade) {
    switch (grade) {
        case "A": return "AQL 1.0";
        case "B": return "AQL 1.5";
        case "C": return "AQL 2.5";
        case "D": return "100% inspection";
        default:  return "AQL 2.5";
    }
}

/* ANSI/ASQ Z1.4 Table I - sample size code letters, general
   inspection level II. This table (which lot-size range maps to
   which letter, and how many units that letter means) is the
   published, unambiguous part of the standard. What is deliberately
   NOT reproduced here is Table II-A's accept/reject numbers per AQL:
   that table has enough cells (every code letter crossed with every
   AQL, plus arrow-down substitution rules for combinations with no
   direct entry) that getting one transcribed wrong would be a worse
   failure than not having it, in a system built to help a plant pass
   an audit. So the accept rule used below is zero-defect - pull the
   real, correctly-sized sample this table calls for, reject the lot
   if anything in it fails - a legitimate, simpler alternative to the
   full standard (this is exactly what a c=0 sampling plan is), not a
   fabricated stand-in for it. An org that needs the exact published
   Ac/Re numbers should read them from their own controlled copy of
   the standard until this table is extended with a verified source. */
const SAMPLE_SIZE_CODE_LETTERS = [
    { max: 8,       letter: "A", size: 2 },
    { max: 15,      letter: "B", size: 3 },
    { max: 25,      letter: "C", size: 5 },
    { max: 50,      letter: "D", size: 8 },
    { max: 90,      letter: "E", size: 13 },
    { max: 150,     letter: "F", size: 20 },
    { max: 280,     letter: "G", size: 32 },
    { max: 500,     letter: "H", size: 50 },
    { max: 1200,    letter: "J", size: 80 },
    { max: 3200,    letter: "K", size: 125 },
    { max: 10000,   letter: "L", size: 200 },
    { max: 35000,   letter: "M", size: 315 },
    { max: 150000,  letter: "N", size: 500 },
    { max: 500000,  letter: "P", size: 800 },
    { max: Infinity, letter: "Q", size: 1250 }
];

/* Turns a vendor's grade and the quantity actually received into a
   real quality gate for this specific lot: how many units to pull,
   and what to reject on. A 100%-inspection vendor (grade D) and a
   lot too small for the table to apply both sample everything -
   there is no such thing as a sampling plan that asks for more units
   than the lot contains. */
export function receivingSamplePlan(grade, qtyReceived) {
    const sample_plan = samplePlanForGrade(grade);
    const qty = Number(qtyReceived) || 0;

    if (sample_plan === "100% inspection" || qty < 2) {
        return { sample_plan, code_letter: null, sample_size: qty, accept_on: "zero failures" };
    }

    const row = SAMPLE_SIZE_CODE_LETTERS.find((r) => qty <= r.max);
    const sampleSize = Math.min(row.size, qty);

    return { sample_plan, code_letter: row.letter, sample_size: sampleSize, accept_on: "zero failures" };
}
