// Mock mode (?mock=1): a walk near the GirlHacks venue (NJIT, Newark) that works with Wi-Fi
// off, and a demo profile. P1's companion and P2's guardian run for real in mock mode (a
// played scream still works); only the network calls are replaced.

// ~750 m from NJIT's campus (Warren St) towards the team plan's demo destination.
export const MOCK_ROUTE = [
  [40.7425, -74.1781],
  [40.74195, -74.17745],
  [40.74135, -74.17665],
  [40.7408, -74.1759],
  [40.74025, -74.17505],
  [40.73975, -74.1742],
  [40.7394, -74.1734],
  [40.73915, -74.1726],
  [40.739, -74.172],
];

export const MOCK_HOME = { lat: 40.739, lng: -74.172, label: 'Home (demo)' };

export const MOCK_PROFILE = {
  name: 'Priya',
  contacts: [
    { id: 'c1', name: 'Mom', phone: '+15551234567' },
    { id: 'c2', name: 'Maya', phone: '+15559876543' },
  ],
  code_phrase: 'i think i left the oven on',
  cancel_pin: '1234',
  duress_pin: '9999',
  news_interests: ['tech', 'music', 'basketball'],
  home: MOCK_HOME,
};

export function isMockModeEnabled() {
  if (typeof window === 'undefined') return true;
  const q = new URLSearchParams(window.location.search).get('mock');
  if (q === '1' || q === 'true') return true;
  if (q === '0') return false;
  try {
    return localStorage.getItem('firefly_mock_mode') === 'true';
  } catch {
    return false;
  }
}

export function setMockMode(enabled) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('firefly_mock_mode', enabled ? 'true' : 'false');
  } catch {}
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set('mock', '1');
  else url.searchParams.delete('mock');
  window.history.replaceState({}, '', url.toString());
}
