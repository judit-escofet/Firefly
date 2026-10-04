import React, { useEffect, useRef } from 'react';

/**
 * Background fireflies. Real fireflies don't twinkle like stars: they're dark most of the time,
 * then glow for about half a second and fade, at irregular intervals, while drifting low among
 * the trees. So: a dozen or so warm dots, mostly in the lower part of the screen, each with its
 * own slow wander and its own blink rhythm. With reduced motion, a few dim dots that stay still.
 */
export default function ParticleCanvas({ count, className = '' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let raf = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      width = r.width;
      height = r.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const n = count ?? Math.max(8, Math.min(18, Math.round((width * height) / 26000)));
    const now = performance.now();
    const flies = Array.from({ length: n }, () => ({
      // Biased towards the lower 60% of the screen, where the trees are.
      x: Math.random() * width,
      y: height * (0.35 + 0.62 * Math.sqrt(Math.random())),
      phase: Math.random() * Math.PI * 2,
      speed: 0.00015 + Math.random() * 0.00025,
      range: 14 + Math.random() * 26,
      size: 1.2 + Math.random() * 1.3,
      nextBlink: now + Math.random() * 5000,
      blinkLen: 450 + Math.random() * 500,
    }));

    const draw = (t) => {
      ctx.clearRect(0, 0, width, height);
      for (const f of flies) {
        let glow;
        if (reduced) glow = 0.35;
        else {
          if (t > f.nextBlink + f.blinkLen) f.nextBlink = t + 1800 + Math.random() * 4800;
          const k = (t - f.nextBlink) / f.blinkLen; // 0..1 during a blink
          glow = k >= 0 && k <= 1 ? Math.sin(k * Math.PI) : 0;
          glow = 0.06 + 0.94 * glow;
        }
        const x = f.x + Math.sin(t * f.speed + f.phase) * f.range;
        const y = f.y + Math.cos(t * f.speed * 0.7 + f.phase * 1.3) * f.range * 0.6;
        if (glow > 0.15) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, f.size * 9);
          g.addColorStop(0, `rgba(255, 214, 120, ${0.38 * glow})`);
          g.addColorStop(1, 'rgba(255, 214, 120, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, f.size * 9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(255, 236, 170, ${glow})`;
        ctx.beginPath();
        ctx.arc(x, y, f.size, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [count]);

  return <canvas ref={canvasRef} aria-hidden="true" className={`absolute inset-0 w-full h-full pointer-events-none ${className}`} />;
}
