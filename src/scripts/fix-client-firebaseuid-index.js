/**
 * fix-client-firebaseuid-index — ONE-TIME MIGRATION.
 *
 * Problem:
 *   The `clients.firebaseUid_1` index was created as a plain unique index
 *   (sparse: true was on the schema, but useless because the schema also
 *   had `default: null`). That means every Client row without Firebase
 *   auth has the *explicit* value null, and Mongo considers null === null
 *   for uniqueness. Result: the second OTP-verified client insert dies
 *   with E11000 duplicate key error on `{ firebaseUid: null }` and the
 *   user can never sign in.
 *
 * Fix:
 *   1. Unset `firebaseUid` on every client where it is currently null or
 *      empty string, so the field is absent from those documents.
 *   2. Drop the legacy `firebaseUid_1` index.
 *   3. Mongoose will recreate it on next boot using the partial-filter
 *      definition in models/Client.js (only docs where firebaseUid is a
 *      non-empty string are indexed, so nulls never collide).
 *
 * Safety:
 *   - Idempotent: rerunning is a no-op (the unset matches 0 docs, the
 *     drop will 404 silently).
 *   - Touches only the `clients` collection.
 *   - `--dry` prints what would change without writing anything.
 *
 * Usage:
 *   npm run migrate:fix-client-firebaseuid
 *   npm run migrate:fix-client-firebaseuid -- --dry
 */

const mongoose = require("mongoose");
const env = require("../config/env");

const DRY_RUN = process.argv.includes("--dry");

const main = async () => {
  console.log(
    `[migrate] fix-client-firebaseuid-index — ${DRY_RUN ? "DRY RUN" : "LIVE"}`
  );

  await mongoose.connect(env.MONGO_URI);
  const db = mongoose.connection.db;
  const clients = db.collection("clients");

  // 1. Count how many rows would be cleaned up.
  const badCount = await clients.countDocuments({
    $or: [
      { firebaseUid: null },
      { firebaseUid: "" },
    ],
  });
  console.log(`[migrate] clients with firebaseUid in {null, ""}: ${badCount}`);

  if (!DRY_RUN && badCount > 0) {
    const res = await clients.updateMany(
      {
        $or: [
          { firebaseUid: null },
          { firebaseUid: "" },
        ],
      },
      { $unset: { firebaseUid: "" } }
    );
    console.log(
      `[migrate] unset firebaseUid on ${res.modifiedCount} client doc(s)`
    );
  }

  // 2. Drop the legacy unique index if present.
  const indexes = await clients.indexes();
  const legacy = indexes.find((ix) => ix.name === "firebaseUid_1");
  if (legacy) {
    console.log(
      `[migrate] legacy index found: ${JSON.stringify({
        name: legacy.name,
        key: legacy.key,
        unique: legacy.unique,
        sparse: legacy.sparse,
        partialFilterExpression: legacy.partialFilterExpression,
      })}`
    );

    if (!DRY_RUN) {
      await clients.dropIndex("firebaseUid_1");
      console.log("[migrate] dropped legacy firebaseUid_1 index");
      console.log(
        "[migrate] restart the server — Mongoose will recreate it as a partial unique index"
      );
    }
  } else {
    console.log("[migrate] no legacy firebaseUid_1 index to drop");
  }

  await mongoose.disconnect();
  console.log("[migrate] done");
};

main().catch(async (err) => {
  console.error("[migrate] failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
