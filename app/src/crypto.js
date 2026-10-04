/**
 * Cryptographic helpers for PIN hashing and user identification.
 * In accordance with P4 Spec:
 * - PINs are hashed client-side with SHA-256 using the userId as salt.
 * - PINs are NEVER stored or transmitted unhashed.
 */

/**
 * Hash a numeric PIN with the user ID as salt using the browser's native Web Crypto API.
 * @param {string} pin - Raw 4-digit PIN
 * @param {string} userId - Unique user identifier used as cryptographic salt
 * @returns {Promise<string>} Hexadecimal SHA-256 digest
 */
export async function hashPin(pin, userId) {
  if (!pin || !userId) {
    throw new Error('Both PIN and userId are required for hashing');
  }

  const saltAndPin = `firefly_salt_${userId}::${pin.trim()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(saltAndPin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Fast client-side PIN check during the countdown. There is one PIN: it cancels. ANY other
 * complete code counts as duress: the screen looks the same ("All good") but help is called and
 * contacts are alerted, so someone forcing her to cancel can't tell.
 * @param {string} rawPin - Input PIN from keypad
 * @param {string} userId - User identifier
 * @param {string} cancelHash - Saved PIN hash
 * @returns {Promise<'cancel' | 'duress' | null>} null only while the code is incomplete
 */
export async function verifyPin(rawPin, userId, cancelHash) {
  if (!rawPin || rawPin.length < 4 || !userId) {
    return null;
  }
  const calculatedHash = await hashPin(rawPin, userId);
  return calculatedHash === cancelHash ? 'cancel' : 'duress';
}

/**
 * Get or create a persistent local user ID in P3's format (u_ + hex). The same ID salts the
 * PIN hashes, so it must never change once PINs are saved.
 */
export function getOrCreateUserId() {
  let userId = localStorage.getItem('firefly_user_id');
  if (!userId || !/^u_[A-Za-z0-9_-]{1,64}$/.test(userId)) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    userId = 'u_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('firefly_user_id', userId);
  }
  return userId;
}
