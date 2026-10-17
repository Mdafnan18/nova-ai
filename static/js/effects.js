(() => {
  "use strict";

  const canvas = document.getElementById("particles");
  const avatar = document.getElementById("avatar");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ----- Eyes follow the mouse ----- */

  function setupEyeTracking() {
    if (!avatar) {
      return;
    }

    const MAX_MOVE = 7; // pixels

    document.addEventListener("pointermove", (event) => {
      if (reduceMotion.matches) {
        return;
      }
      const box = avatar.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const dx = Math.max(-1, Math.min(1, (event.clientX - centerX) / (window.innerWidth / 2)));
      const dy = Math.max(-1, Math.min(1, (event.clientY - centerY) / (window.innerHeight / 2)));
      avatar.style.setProperty("--look-x", (dx * MAX_MOVE).toFixed(1) + "px");
      avatar.style.setProperty("--look-y", (dy * MAX_MOVE).toFixed(1) + "px");
    });

    document.addEventListener("pointerleave", () => {
      avatar.style.setProperty("--look-x", "0px");
      avatar.style.setProperty("--look-y", "0px");
    });
  }

  /* ----- Floating particles ----- */

  function setupParticles() {
    if (!canvas || !canvas.getContext) {
      return;
    }

    const ctx = canvas.getContext("2d");

    // Each state has two colors (red, green, blue) and a speed.
    const PALETTES = {
      idle: ["34,228,255", "155,92,255"],
      listening: ["52,245,197", "34,228,255"],
      thinking: ["155,92,255", "110,80,255"],
      speaking: ["34,228,255", "155,92,255"],
      error: ["255,77,109", "155,92,255"],
    };
    const SPEEDS = { idle: 1, listening: 1.4, thinking: 2.2, speaking: 1.8, error: 0.5 };

    let width = 0;
    let height = 0;
    let particles = [];
    let state = avatar ? avatar.dataset.state || "idle" : "idle";
    let running = false;
    let frameId = 0;
    let lastTime = 0;

    function targetCount() {
      const count = Math.round((width * height) / 22000);
      return Math.max(24, Math.min(count, 90));
    }

    function makeParticle(anywhere) {
      return {
        x: Math.random() * width,
        y: anywhere ? Math.random() * height : height + 10,
        radius: 0.8 + Math.random() * 2.2,
        speed: 8 + Math.random() * 22,
        drift: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        tone: Math.random() < 0.5 ? 0 : 1,
        alpha: 0.25 + Math.random() * 0.55,
      };
    }

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      const target = targetCount();
      while (particles.length < target) {
        particles.push(makeParticle(true));
      }
      particles.length = Math.min(particles.length, target);

      if (reduceMotion.matches) {
        step(0);
      }
    }

    function step(dt) {
      const palette = PALETTES[state] || PALETTES.idle;
      const speedBoost = SPEEDS[state] || 1;

      ctx.clearRect(0, 0, width, height);
      ctx.shadowBlur = 10;

      for (let i = 0; i < particles.length; i += 1) {
        let p = particles[i];

        p.y -= p.speed * speedBoost * dt;
        p.phase += dt * 0.8;
        p.x += (p.drift + Math.sin(p.phase) * 8) * dt;

        if (p.y < -10 || p.x < -10 || p.x > width + 10) {
          p = makeParticle(false);
          particles[i] = p;
        }

        const twinkle = 0.65 + 0.35 * Math.sin(p.phase * 2.3);
        const color = palette[p.tone];

        ctx.beginPath();
        ctx.fillStyle = "rgba(" + color + "," + (p.alpha * twinkle).toFixed(3) + ")";
        ctx.shadowColor = "rgba(" + color + ",0.9)";
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function loop(now) {
      if (!running) {
        return;
      }
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      step(dt);
      frameId = requestAnimationFrame(loop);
    }

    function start() {
      if (running) {
        return;
      }
      if (reduceMotion.matches) {
        step(0); // one still picture, no movement
        return;
      }
      running = true;
      lastTime = performance.now();
      frameId = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(frameId);
    }

    // Change particle colors and speed when the avatar state changes.
    if (avatar) {
      new MutationObserver(() => {
        state = avatar.dataset.state || "idle";
        if (reduceMotion.matches) {
          step(0);
        }
      }).observe(avatar, { attributes: true, attributeFilter: ["data-state"] });
    }

    // Save battery: pause when the tab is hidden.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    });

    reduceMotion.addEventListener("change", () => {
      stop();
      start();
    });

    window.addEventListener("resize", resize);

    resize();
    start();
  }

  setupEyeTracking();
  setupParticles();
})();