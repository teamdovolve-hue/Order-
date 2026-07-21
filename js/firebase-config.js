/**
 * firebase-config.js
 * ─────────────────────────────────────────────────────────────
 * Firebase initialisation for the QR Menu Panel.
 * Uses Firestore (as configured in your project).
 *
 * ⚠️  Your live keys are already filled in below from your config file.
 *     If you ever rotate them, update ONLY the values inside firebaseConfig.
 */

import { initializeApp }       from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore }        from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── Paste / update your Firebase project config here ─────────
const firebaseConfig = {
  apiKey:            "AIzaSyBLzGd0DlItKShk0eJoQR4CjRx1sP3-o-w",
  authDomain:        "billing-system-f8531.firebaseapp.com",
  projectId:         "billing-system-f8531",
  storageBucket:     "billing-system-f8531.firebasestorage.app",
  messagingSenderId: "921228841270",
  appId:             "1:921228841270:web:9013d59b3ef96dda40e397",
  measurementId:     "G-JMPEJCCBHZ",
};
// ─────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
