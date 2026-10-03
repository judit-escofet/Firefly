import React, { useEffect, useRef } from 'react';

/**
 * Interactive Mythical Stardust & Aurora Particle Canvas
 * Provides an ethereal, luminous background of glowing celestial particles
 * that gently respond to mouse and touch interactions.
 */
export default function ParticleCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let isRunning = true;

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Particle pool
    const particleColors = [
      'rgba(254, 240, 138, ',  // metallic gold light
      'rgba(242, 204, 87, ',   // honeysuckle gold
      'rgba(233, 213, 255, ',  // ethereal lavender
      'rgba(167, 243, 208, ',  // soft mint
      'rgba(251, 207, 232, ',  // ethereal rose
    ];

    const particleCount = Math.min(65, Math.floor((width * height) / 12000));
    const particles = [];

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: Math.random() * 2.2 + 0.8,
        colorBase: particleColors[Math.floor(Math.random() * particleColors.length)],
        alpha: Math.random() * 0.7 + 0.2,
        alphaSpeed: (Math.random() * 0.02 + 0.008) * (Math.random() > 0.5 ? 1 : -1),
        vx: (Math.random() - 0.5) * 0.5,
        vy: -Math.random() * 0.6 - 0.2, // Gentle upward drift
        originX: Math.random() * width,
      });
    }

    // Interactive pointer
    const pointer = {
      x: -1000,
      y: -1000,
      radius: 120,
    };

    const handlePointerMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      pointer.x = clientX;
      pointer.y = clientY;
    };

    const handlePointerLeave = () => {
      pointer.x = -1000;
      pointer.y = -1000;
    };

    window.addEventListener('mousemove', handlePointerMove, { passive: true });
    window.addEventListener('touchmove', handlePointerMove, { passive: true });
    window.addEventListener('mouseleave', handlePointerLeave, { passive: true });

    const handleResize = () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };

    window.addEventListener('resize', handleResize);

    // Animation Loop
    function render() {
      if (!isRunning) return;

      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Move particle
        p.x += p.vx;
        p.y += p.vy;

        // Pulse alpha
        p.alpha += p.alphaSpeed;
        if (p.alpha >= 0.85 || p.alpha <= 0.15) {
          p.alphaSpeed *= -1;
        }

        // Mouse interaction: gentle repulsion / swirl
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < pointer.radius) {
          const force = (1 - dist / pointer.radius) * 1.5;
          p.x += (dx / dist) * force * 2;
          p.y += (dy / dist) * force * 2;
        }

        // Wrap around edges
        if (p.y < -10) {
          p.y = height + 10;
          p.x = Math.random() * width;
        }
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;

        // Draw particle with soft halo
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `${p.colorBase}${p.alpha})`;
        ctx.shadowColor = `${p.colorBase}0.8)`;
        ctx.shadowBlur = p.radius * 4;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      animationFrameId = requestAnimationFrame(render);
    }

    render();

    return () => {
      isRunning = false;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('mouseleave', handlePointerLeave);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-0"
      style={{ opacity: 0.85 }}
    />
  );
}
