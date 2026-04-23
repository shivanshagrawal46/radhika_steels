/**
 * backfill-contact-phones — ONE-TIME MIGRATION.
 *
 * Context:
 *   The original `normalizePhone` in contactHandler stripped non-digits
 *   without prefixing the country code, so any contact saved from a
 *   source that did NOT already include "+91" (e.g. admin typing a bare
 *   10-digit number) was stored as "9876543210". Every User row on the
 *   other hand stores the Meta/WhatsApp form "919876543210". That
 *   asymmetry meant contact lookups (chat header, order list, rate
 *   broadcast name resolution) could silently return no match and show
 *   a blank name.
 *
 * What this script does:
 *   - Iterates every Contact row.
 *   - Rewrites `phone` into the canonical 12-digit "91..." form using
 *     the same rules as `utils/phoneUtils.canonicalizePhone`.
 *   - If the canonical version would clash with another (phone,
 *     syncedBy) row (the unique index), it KEEPS the pre-existing
 *     canonical row and DELETES the non-canonical duplicate.
 *   - Leaves already-canonical rows untouched.
 *
 * Safety:
 *   - Idempotent: rerunning is a no-op.
 *   - Read-only against every other collection — touches Contact only.
 *   - Dry-run mode available: `node src/scripts/backfill-contact-phones.js --dry`
 *     prints what would change without writing anything.
 *
 * Usage:
 *   npm run migrate:contact-phones         # execute
 *   npm run migrate:contact-phones -- --dry   # preview only
 */

const mongoose = require("mongoose");
const env = require("../config/env");
const { Contact } = require("../models");
const { canonicalizePhone } = require("../utils/phoneUtils");

const DRY_RUN = process.argv.includes("--dry");

const run = async () => {
  await mongoose.connect(env.MONGO_URI);
  console.log(`Connected to MongoDB (${DRY_RUN ? "DRY RUN" : "LIVE"} mode)`);

  const cursor = Contact.find({}).cursor();

  let scanned = 0;
  let alreadyCanonical = 0;
  let updated = 0;
  let deletedDuplicates = 0;
  const samples = [];

  for await (const row of cursor) {
    scanned++;
    const before = row.phone;
    const after = canonicalizePhone(before);

    if (!after) {
      // Empty / bogus phone — skip, don't delete (might be data the
      // admin intentionally kept).
      continue;
    }
    if (after === before) {
      alreadyCanonical++;
      continue;
    }

    // Would this rewrite collide with the unique (phone, syncedBy) index?
    const clash = await Contact.findOne({
      phone: after,
      syncedBy: row.syncedBy,
      _id: { $ne: row._id },
    }).lean();

    if (clash) {
      if (samples.length < 10) {
        samples.push({
          action: "delete-duplicate",
          from: before,
          canonical: after,
          contactName: row.contactName,
        });
      }
      if (!DRY_RUN) await Contact.deleteOne({ _id: row._id });
      deletedDuplicates++;
      continue;
    }

    if (samples.length < 10) {
      samples.push({
        action: "rewrite",
        from: before,
        to: after,
        contactName: row.contactName,
      });
    }
    if (!DRY_RUN) {
      await Contact.updateOne({ _id: row._id }, { $set: { phone: after } });
    }
    updated++;
  }

  console.log("\n───── RESULT ─────");
  console.log(`Scanned:            ${scanned}`);
  console.log(`Already canonical:  ${alreadyCanonical}`);
  console.log(`Rewritten:          ${updated}`);
  console.log(`Duplicates removed: ${deletedDuplicates}`);
  if (samples.length) {
    console.log("\nFirst 10 changes (sample):");
    for (const s of samples) console.log(" ", s);
  }
  console.log(DRY_RUN ? "\n(Dry run — no writes performed.)" : "\nDone.");

  await mongoose.disconnect();
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
