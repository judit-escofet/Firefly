// Distances for people in the US: miles, or feet under a tenth of a mile. Internally everything
// stays in metres (the API contract); only what's shown or spoken is converted.

const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

// → { value: '0.6', unit: 'mi' } or { value: '300', unit: 'ft' }
export function formatDistance(meters) {
  const m = Math.max(0, Number(meters) || 0);
  const miles = m / M_PER_MILE;
  if (miles >= 0.1) return { value: miles.toFixed(1), unit: 'mi' };
  return { value: String(Math.round((m * FT_PER_M) / 10) * 10), unit: 'ft' };
}

// For the firefly to say out loud: "0.6 miles", "1 mile", "about 300 feet".
export function spokenDistance(meters) {
  const { value, unit } = formatDistance(meters);
  if (unit === 'ft') return `about ${value} feet`;
  return value === '1.0' ? '1 mile' : `${value.replace(/\.0$/, '')} miles`;
}
