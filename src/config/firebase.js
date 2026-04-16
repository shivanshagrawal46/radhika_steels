const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const env = require("./env");
const logger = require("./logger");

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK — used ONLY for FCM push notifications.
 * Client auth is handled by WhatsApp OTP + JWT (no Firebase Phone Auth).
 */
const initFirebase = () => {
  if (firebaseApp) return firebaseApp;

  try {
    const serviceAccountPath = env.FIREBASE_SERVICE_ACCOUNT_PATH;

    if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    } else if (env.FIREBASE_PROJECT_ID) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: (env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
      });
    } else {
      firebaseApp = admin.initializeApp();
    }

    logger.info("Firebase Admin SDK initialised (FCM only)");
  } catch (err) {
    logger.error("Firebase init failed:", err.message);
    logger.warn("Push notifications will not work until Firebase is configured");
    return null;
  }

  return firebaseApp;
};

module.exports = { initFirebase };
