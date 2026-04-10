const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const env = require("./env");
const logger = require("./logger");

let firebaseApp = null;

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
      // Fallback: use individual env vars (works in cloud environments)
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: (env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
        }),
      });
    } else {
      // Application Default Credentials (GCP / Cloud Run / etc.)
      firebaseApp = admin.initializeApp();
    }

    logger.info("Firebase Admin SDK initialised");
  } catch (err) {
    logger.error("Firebase init failed:", err.message);
    logger.warn("Client auth will not work until Firebase is configured");
    return null;
  }

  return firebaseApp;
};

/**
 * Verify a Firebase ID token (sent by the client app after OTP login).
 * Returns the decoded token with uid, phone_number, etc.
 */
const verifyIdToken = async (idToken) => {
  if (!firebaseApp) {
    throw new Error("Firebase not initialised — cannot verify token");
  }
  return admin.auth().verifyIdToken(idToken);
};

module.exports = { initFirebase, verifyIdToken };
