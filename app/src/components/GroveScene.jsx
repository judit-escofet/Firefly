import React, { useMemo } from 'react';

// The tree line at the bottom of the welcome, setup and home screens: three layers of trees, a
// dotted path winding up to a cottage with a lit window. The trees come from a seeded random
// generator so the silhouette is irregular (like a real tree line) but the same on every load.
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A conifer: a ragged stack of tiers rather than a clean triangle.
function conifer(x, base, h, w, r) {
  const tiers = 3 + Math.floor(r() * 3);
  const pts = [[x - w * 0.08, base]];
  for (let i = 0; i < tiers; i++) {
    const y = base - (h * (i + 0.15)) / tiers;
    const hw = (w / 2) * (1 - i / (tiers + 0.6)) * (0.85 + r() * 0.3);
    pts.push([x - hw, y], [x - hw * 0.45, y - h / tiers / 2.2]);
  }
  pts.push([x + (r() - 0.5) * 3, base - h]);
  for (let i = tiers - 1; i >= 0; i--) {
    const y = base - (h * (i + 0.15)) / tiers;
    const hw = (w / 2) * (1 - i / (tiers + 0.6)) * (0.85 + r() * 0.3);
    pts.push([x + hw * 0.45, y - h / tiers / 2.2], [x + hw, y]);
  }
  pts.push([x + w * 0.08, base]);
  return `M${pts.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join('L')}Z`;
}

// A round, lumpy canopy (a few overlapping circles) on a short trunk.
function broadleaf(x, base, h, r) {
  const blobs = [];
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    blobs.push({ cx: x + (r() - 0.5) * h * 0.55, cy: base - h * (0.55 + r() * 0.3), r: h * (0.2 + r() * 0.14) });
  }
  return { trunk: `M${x - 1.5} ${base}L${x - 1} ${base - h * 0.5}L${x + 1} ${base - h * 0.5}L${x + 1.5} ${base}Z`, blobs };
}

function layer(seed, { y, minH, maxH, step, colour, broadleafChance, clear = null }) {
  const r = rng(seed);
  const shapes = [];
  for (let x = -10; x < 420; x += step * (0.6 + r() * 0.8)) {
    const h = minH + r() * (maxH - minH);
    if (clear && x > clear[0] && x < clear[1]) continue; // a clearing for the path and the cottage
    if (r() < broadleafChance) shapes.push({ kind: 'b', ...broadleaf(x, y + r() * 4, h, r) });
    else shapes.push({ kind: 'c', d: conifer(x, y + r() * 4, h, h * (0.42 + r() * 0.18), r) });
  }
  return { colour, shapes, y };
}

export default function GroveScene({ litWindow = false, className = '' }) {
  const layers = useMemo(
    () => [
      layer(7, { y: 150, minH: 26, maxH: 48, step: 13, colour: '#16271f', broadleafChance: 0.25 }),
      layer(23, { y: 180, minH: 34, maxH: 66, step: 17, colour: '#112019', broadleafChance: 0.35, clear: [276, 318] }),
      layer(41, { y: 214, minH: 46, maxH: 92, step: 24, colour: '#0b1510', broadleafChance: 0.3, clear: [120, 330] }),
    ],
    [],
  );

  const grass = useMemo(() => {
    const r = rng(99);
    const blades = [];
    for (let x = 0; x < 400; x += 3 + r() * 5) {
      const h = 4 + r() * 9;
      const lean = (r() - 0.5) * 6;
      blades.push(`M${x.toFixed(1)} 222Q${(x + lean / 2).toFixed(1)} ${(222 - h / 2).toFixed(1)} ${(x + lean).toFixed(1)} ${(222 - h).toFixed(1)}`);
    }
    return blades.join('');
  }, []);

  return (
    <svg viewBox="0 0 400 222" preserveAspectRatio="xMidYMax slice" aria-hidden="true" className={`w-full ${className}`}>
      <defs>
        <radialGradient id="windowGlow">
          <stop offset="0%" stopColor="#ffd27a" stopOpacity={litWindow ? 0.75 : 0.5} />
          <stop offset="100%" stopColor="#ffd27a" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* far hills */}
      <path d="M0 150 C60 128 110 140 160 132 S260 118 310 130 S380 126 400 134 L400 222 L0 222Z" fill="#142219" />

      {layers.slice(0, 2).map((l, i) => (
        <g key={i} fill={l.colour}>
          {l.shapes.map((s, j) =>
            s.kind === 'c' ? <path key={j} d={s.d} /> : (
              <g key={j}>
                <path d={s.trunk} />
                {s.blobs.map((b, k) => <circle key={k} cx={b.cx} cy={b.cy} r={b.r} />)}
              </g>
            ),
          )}
          <rect x="0" y={l.y} width="400" height={222 - l.y} />
        </g>
      ))}

      {/* the cottage, tucked into the middle row */}
      <g transform="translate(288 156)">
        <circle cx="10" cy="10" r={litWindow ? 30 : 22} fill="url(#windowGlow)" />
        <path d="M-2 10 L10 -1 L22 10Z" fill="#0d1813" />
        <rect x="0" y="9" width="20" height="15" fill="#0d1813" />
        <rect x="12" y="-2" width="3" height="7" fill="#0d1813" />
        <rect x="4" y="13" width="5" height="5" rx="0.5" fill="#ffd27a" opacity={litWindow ? 1 : 0.85} />
        <rect x="12" y="15" width="5" height="9" fill={litWindow ? '#e2a23b' : '#0a120e'} />
      </g>

      {/* the path home */}
      <path d="M150 222 C170 206 232 204 236 192 S262 182 296 180" fill="none" stroke="#ffd27a" strokeOpacity="0.55"
        strokeWidth="1.6" strokeLinecap="round" strokeDasharray="0.1 6" />

      <g fill={layers[2].colour}>
        {layers[2].shapes.map((s, j) =>
          s.kind === 'c' ? <path key={j} d={s.d} /> : (
            <g key={j}>
              <path d={s.trunk} />
              {s.blobs.map((b, k) => <circle key={k} cx={b.cx} cy={b.cy} r={b.r} />)}
            </g>
          ),
        )}
      </g>
      <path d={grass} stroke="#0b1510" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="0" y="218" width="400" height="4" fill="#0b1510" />
    </svg>
  );
}
