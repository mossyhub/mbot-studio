import React, { useState, useEffect, useCallback, useRef } from 'react';
import './Celebrations.css';

/**
 * Confetti & celebration overlay.
 * Renders canvas-based confetti burst on demand.
 * Also shows achievement toast notifications.
 */

// ─── Confetti Canvas ─────────────────────────────────────────

function ConfettiCanvas({ active, onDone }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!active) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#6366f1', '#f59e0b', '#ef4444', '#10b981', '#06b6d4', '#ec4899', '#8b5cf6', '#f97316'];
    const particles = [];

    // Create particles
    for (let i = 0; i < 120; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 200,
        y: canvas.height / 2,
        vx: (Math.random() - 0.5) * 16,
        vy: Math.random() * -18 - 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 8 + 3,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.3 + Math.random() * 0.2,
        shape: Math.random() > 0.5 ? 'rect' : 'circle',
        opacity: 1,
      });
    }

    let frame;
    let elapsed = 0;
    const maxDuration = 2500;

    function animate() {
      elapsed += 16;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let alive = 0;
      for (const p of particles) {
        p.x += p.vx;
        p.vy += p.gravity;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        p.vx *= 0.99;
        p.opacity = Math.max(0, 1 - elapsed / maxDuration);

        if (p.y < canvas.height + 50 && p.opacity > 0) {
          alive++;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.globalAlpha = p.opacity;
          ctx.fillStyle = p.color;

          if (p.shape === 'rect') {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }

      if (alive > 0 && elapsed < maxDuration) {
        frame = requestAnimationFrame(animate);
      } else {
        onDone?.();
      }
    }

    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [active, onDone]);

  if (!active) return null;

  return <canvas ref={canvasRef} className="confetti-canvas" />;
}

// ─── Achievement Toast ───────────────────────────────────────

function AchievementToast({ badge, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
  }, [onDone]);

  if (!badge) return null;

  return (
    <div className="achievement-toast" onClick={onDone}>
      <div className="achievement-toast-icon">{badge.icon}</div>
      <div className="achievement-toast-content">
        <div className="achievement-toast-title">🏆 Achievement Unlocked!</div>
        <div className="achievement-toast-name">{badge.name}</div>
        <div className="achievement-toast-desc">{badge.description}</div>
      </div>
    </div>
  );
}

// ─── Main Celebrations Component ─────────────────────────────

export default function Celebrations({ celebrationQueue, onCelebrationDone }) {
  const [showConfetti, setShowConfetti] = useState(false);
  const [currentToast, setCurrentToast] = useState(null);
  const [toastQueue, setToastQueue] = useState([]);

  // Process incoming celebrations
  useEffect(() => {
    if (!celebrationQueue || celebrationQueue.length === 0) return;

    const latest = celebrationQueue[celebrationQueue.length - 1];

    if (latest.type === 'confetti') {
      setShowConfetti(true);
    }

    if (latest.badge) {
      setToastQueue(prev => [...prev, latest.badge]);
    }

    onCelebrationDone?.();
  }, [celebrationQueue, onCelebrationDone]);

  // Show toasts one at a time
  useEffect(() => {
    if (!currentToast && toastQueue.length > 0) {
      setCurrentToast(toastQueue[0]);
      setToastQueue(prev => prev.slice(1));
    }
  }, [currentToast, toastQueue]);

  const handleConfettiDone = useCallback(() => {
    setShowConfetti(false);
  }, []);

  const handleToastDone = useCallback(() => {
    setCurrentToast(null);
  }, []);

  return (
    <>
      <ConfettiCanvas active={showConfetti} onDone={handleConfettiDone} />
      {currentToast && <AchievementToast badge={currentToast} onDone={handleToastDone} />}
    </>
  );
}
