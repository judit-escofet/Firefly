/**
 * Screen Wake Lock Management
 * Ensures the screen stays on during a walk so the user has immediate access
 * to Firefly without the phone sleeping.
 */

let wakeLockSentinel = null;
let shouldBeActive = false;
let statusListeners = new Set();

function notifyListeners(status) {
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (e) {
      console.error('Wake lock listener error:', e);
    }
  }
}

async function reacquire() {
  if (shouldBeActive && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      notifyListeners({ active: true, supported: true });
      
      wakeLockSentinel.addEventListener('release', () => {
        if (shouldBeActive) {
          notifyListeners({ active: false, supported: true });
        }
      });
    } catch (err) {
      console.warn('Wake lock reacquire failed:', err);
      notifyListeners({ active: false, supported: true, error: err.message });
    }
  }
}

// Re-acquire automatically when page becomes visible again
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && shouldBeActive) {
      reacquire();
    }
  });
}

export const wakeLockService = {
  isSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  },

  async enable() {
    shouldBeActive = true;
    if (!this.isSupported()) {
      notifyListeners({ active: false, supported: false });
      return false;
    }

    try {
      if (wakeLockSentinel) {
        await wakeLockSentinel.release();
      }
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      notifyListeners({ active: true, supported: true });

      wakeLockSentinel.addEventListener('release', () => {
        if (!shouldBeActive) {
          notifyListeners({ active: false, supported: true });
        }
      });
      return true;
    } catch (err) {
      console.warn('Screen Wake Lock request failed:', err);
      notifyListeners({ active: false, supported: true, error: err.message });
      return false;
    }
  },

  async disable() {
    shouldBeActive = false;
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch (err) {
        // Ignored
      }
      wakeLockSentinel = null;
    }
    notifyListeners({ active: false, supported: this.isSupported() });
  },

  subscribe(callback) {
    statusListeners.add(callback);
    callback({
      active: !!wakeLockSentinel,
      supported: this.isSupported(),
    });
    return () => statusListeners.delete(callback);
  }
};
