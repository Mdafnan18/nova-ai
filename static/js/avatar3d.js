(() => {
  "use strict";

  const THREE_URL = "/static/vendor/three/three.module.js";
  const STORAGE_KEY = "nova-avatar3d";
  const HEAD_RADIUS = 1.45;

  const avatarEl = document.getElementById("avatar");
  const stateRow = document.querySelector(".state-preview");
  if (!avatarEl || !stateRow) {
    return;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // How each avatar state looks and moves in 3D.
  const STATE_STYLE = {
    idle: { color: "cyan", spin: 0.25, pulse: 0.8, pulseSize: 0.015 },
    listening: { color: "green", spin: 0.5, pulse: 2.2, pulseSize: 0.04 },
    thinking: { color: "purple", spin: 1.6, pulse: 2.5, pulseSize: 0.02 },
    speaking: { color: "cyan", spin: 0.9, pulse: 3.5, pulseSize: 0.03 },
    error: { color: "pink", spin: 0.05, pulse: 1.0, pulseSize: 0.01 },
  };

  /* ----- Remembered choice (kept in this browser) ----- */

  function readSetting() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function writeSetting(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      // Saving is optional. The choice still works for this visit.
    }
  }

  /* ----- The button and the place for the 3D picture (built here, so index.html stays small) ----- */

  const holder = document.createElement("div");
  holder.className = "avatar3d";
  holder.hidden = true;
  holder.setAttribute("role", "img");
  holder.setAttribute("aria-label", "NOVA 3D avatar");
  avatarEl.insertAdjacentElement("afterend", holder);

  const picker = document.createElement("div");
  picker.className = "view-picker";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "chip";
  toggle.textContent = "3D avatar: Off";
  toggle.setAttribute("aria-pressed", "false");

  const note = document.createElement("p");
  note.className = "view-note";
  note.setAttribute("role", "status");

  picker.append(toggle, note);
  stateRow.insertAdjacentElement("afterend", picker);

  function setNote(message, isError) {
    note.textContent = message;
    note.classList.toggle("is-error", Boolean(isError));
  }

  function renderToggle() {
    toggle.textContent = enabled ? "3D avatar: On" : "3D avatar: Off";
    toggle.setAttribute("aria-pressed", String(enabled));
  }

  /* ----- Variables for the 3D scene ----- */

  let THREE = null; // the Three.js library, loaded only when you switch 3D on
  let ready = false; // the scene has been built
  let enabled = false; // the 3D view is switched on
  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let time = 0;
  let state = currentState();
  let stateSince = 0;
  let spinSpeed = 0.25;
  let blinkAt = 3;
  let blinkUntil = 0;
  let openAmount = 0;
  let resizeWatcher = null;

  let renderer = null;
  let scene = null;
  let camera = null;
  let root = null;
  let head = null;
  let glow = null;
  let eyes = null;
  let mouth = null;
  let particleSystem = null;
  let particleMaterial = null;
  let accentLight = null;
  let current = null;
  let target = null;

  const eyeMeshes = [];
  const rings = [];
  const colors = {};
  const look = { x: 0, y: 0 };
  const lookTarget = { x: 0, y: 0 };

  function currentState() {
    return avatarEl.dataset.state || "idle";
  }

  /* ----- Colors: we ask the page for the real theme colors ----- */

  function cssColor(variable, fallback) {
    const probe = document.createElement("span");
    probe.style.color = "var(" + variable + ")";
    document.body.append(probe);
    const value = window.getComputedStyle(probe).color;
    probe.remove();
    return /^rgb/.test(value) ? new THREE.Color(value) : new THREE.Color(fallback);
  }

  function readColors() {
    colors.cyan = cssColor("--cyan", "#22e4ff");
    colors.purple = cssColor("--purple", "#9b5cff");
    colors.green = cssColor("--green", "#34f5c5");
    colors.pink = cssColor("--pink", "#ff4d6d");
  }

  function applyColor(color) {
    head.material.emissive.copy(color);
    head.material.color.copy(colors.purple).multiplyScalar(0.5);
    glow.material.color.copy(color);
    accentLight.color.copy(color);
    particleMaterial.color.copy(color);

    rings.forEach((ring) => {
      const ringColor = ring.accent ? color : colors.purple;
      ring.material.color.copy(ringColor);
      ring.dotMaterial.color.copy(ringColor);
    });
  }

  /* ----- Building the scene ----- */

  function pointOnHead(x, y, offset) {
    const z = Math.sqrt(Math.max(0, HEAD_RADIUS * HEAD_RADIUS - x * x - y * y)) + offset;
    return new THREE.Vector3(x, y, z);
  }

  function buildScene() {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      throw new Error("Your browser or graphics card cannot show 3D. The normal avatar stays on.");
    }

    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 8.5);

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(3, 4, 6);
    scene.add(keyLight);

    accentLight = new THREE.DirectionalLight(0xffffff, 1.6);
    accentLight.position.set(-4, -2, 3);
    scene.add(accentLight);

    root = new THREE.Group();
    scene.add(root);

    // The head
    head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_RADIUS, 48, 48),
      new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.15, emissiveIntensity: 0.45 })
    );
    root.add(head);

    // A soft glow around the head
    glow = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_RADIUS * 1.14, 32, 32),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.14,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    root.add(glow);

    // The face (children of the head, so it turns with the head)
    const faceMaterial = new THREE.MeshBasicMaterial({ color: 0xf2feff });

    eyes = new THREE.Group();
    head.add(eyes);
    [-1, 1].forEach((side) => {
      const eye = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.14, 4, 12), faceMaterial);
      eye.position.copy(pointOnHead(side * 0.48, 0.2, 0.02));
      eyes.add(eye);
      eyeMeshes.push(eye);
    });

    mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.26, 4, 12), faceMaterial);
    mouth.position.copy(pointOnHead(0, -0.42, 0.02));
    mouth.rotation.z = Math.PI / 2;
    head.add(mouth);

    // Three tilted rings, each with an orbiting dot
    const ringSettings = [
      { radius: 2.05, tiltX: 1.15, tiltY: 0.0, dir: 1, accent: true },
      { radius: 2.3, tiltX: 0.45, tiltY: 0.9, dir: -1, accent: false },
      { radius: 2.55, tiltX: 1.45, tiltY: -0.6, dir: 1, accent: true },
    ];

    ringSettings.forEach((setting, index) => {
      const pivot = new THREE.Group();
      pivot.rotation.set(setting.tiltX, setting.tiltY, 0);

      const spinner = new THREE.Group();
      const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(setting.radius, 0.016, 12, 160), material);

      const dotMaterial = new THREE.MeshBasicMaterial();
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), dotMaterial);
      dot.position.set(setting.radius, 0, 0);

      spinner.add(ring, dot);
      pivot.add(spinner);
      root.add(pivot);

      rings.push({
        spinner,
        material,
        dotMaterial,
        dir: setting.dir,
        accent: setting.accent,
        speedFactor: 1 + index * 0.35,
      });
    });

    // Floating particles around everything
    const count = 140;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 2.9 + Math.random() * 1.2;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    particleMaterial = new THREE.PointsMaterial({
      size: 0.06,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    particleSystem = new THREE.Points(geometry, particleMaterial);
    root.add(particleSystem);

    current = colors.cyan.clone();
    target = colors.cyan.clone();
    applyColor(current);

    holder.append(renderer.domElement);
  }

  /* ----- Moving the scene (called many times per second) ----- */

  function update(dt) {
    const style = STATE_STYLE[state] || STATE_STYLE.idle;
    const quick = dt === 0 ? 1 : Math.min(1, dt * 6);
    const slow = dt === 0 ? 1 : Math.min(1, dt * 3);

    // Colors glide to the color of the current state
    target.copy(colors[style.color]);
    current.lerp(target, quick);
    applyColor(current);

    // Rings and particles
    spinSpeed += (style.spin - spinSpeed) * slow;
    rings.forEach((ring) => {
      ring.spinner.rotation.z += dt * spinSpeed * ring.dir * ring.speedFactor;
    });
    particleSystem.rotation.y += dt * 0.05 * (1 + spinSpeed);

    // The glowing heartbeat
    const beat = Math.sin(time * style.pulse * 2);
    head.scale.setScalar(1 + beat * style.pulseSize);
    glow.material.opacity = 0.14 + beat * 0.05;

    // Where the head looks
    look.x += (lookTarget.x - look.x) * quick;
    look.y += (lookTarget.y - look.y) * quick;
    const sway = state === "thinking" ? Math.sin(time * 1.6) * 0.25 : 0;
    head.rotation.y = look.x * 0.5 + sway;
    head.rotation.x = -look.y * 0.3;

    // Floating up and down, and a short shake for errors
    root.position.y = Math.sin(time * 1.2) * 0.06;
    const sinceChange = time - stateSince;
    root.position.x =
      state === "error" && sinceChange < 0.6 ? Math.sin(time * 55) * 0.05 * (1 - sinceChange / 0.6) : 0;

    // Eyes
    if (time > blinkAt) {
      blinkUntil = time + 0.14;
      blinkAt = time + 3 + Math.random() * 3;
    }
    const blinking = time < blinkUntil;
    const eyeOpen = state === "listening" ? 1.25 : state === "thinking" ? 0.7 : 1;
    eyeMeshes.forEach((eye) => {
      eye.scale.y = blinking ? 0.1 : eyeOpen;
    });
    eyes.position.x = state === "thinking" ? Math.sin(time * 2) * 0.06 : 0;

    // Mouth
    let openTarget = 0;
    if (state === "speaking") {
      openTarget = Math.abs(Math.sin(time * 11)) * Math.abs(Math.sin(time * 6.7));
    }
    openAmount += (openTarget - openAmount) * (dt === 0 ? 1 : Math.min(1, dt * 18));
    mouth.scale.x = 1 + openAmount * 4.5;
    mouth.scale.y = state === "thinking" ? 0.5 : state === "error" ? 0.7 : 1;
  }

  function renderOnce() {
    update(0);
    renderer.render(scene, camera);
  }

  function frame() {
    if (!running) {
      return;
    }
    rafId = window.requestAnimationFrame(frame);

    const now = window.performance.now() / 1000;
    const dt = Math.min(now - lastTime, 0.05);
    lastTime = now;
    time += dt;

    update(dt);
    renderer.render(scene, camera);
  }

  function start() {
    if (running || !ready || !enabled) {
      return;
    }
    if (reduceMotion.matches) {
      renderOnce(); // one still picture, no movement
      return;
    }
    running = true;
    lastTime = window.performance.now() / 1000;
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    window.cancelAnimationFrame(rafId);
  }

  function resize() {
    if (!ready) {
      return;
    }
    const size = Math.max(160, Math.floor(holder.clientWidth));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    if (!running) {
      renderOnce();
    }
  }

  /* ----- Mouse following ----- */

  function onPointerMove(event) {
    if (reduceMotion.matches) {
      return;
    }
    const box = holder.getBoundingClientRect();
    const dx = (event.clientX - (box.left + box.width / 2)) / (window.innerWidth / 2);
    const dy = (event.clientY - (box.top + box.height / 2)) / (window.innerHeight / 2);
    lookTarget.x = Math.max(-1, Math.min(1, dx));
    lookTarget.y = Math.max(-1, Math.min(1, dy));
  }

  function onPointerLeave() {
    lookTarget.x = 0;
    lookTarget.y = 0;
  }

  /* ----- Switching 3D on and off ----- */

  async function ensureScene() {
    if (ready) {
      return;
    }

    try {
      THREE = await import(THREE_URL);
    } catch (error) {
      throw new Error("The 3D file is missing. Download three.module.js as shown in the setup steps.");
    }

    readColors();
    buildScene(); // this can throw "cannot show 3D" if the graphics card does not support it
    ready = true;
  }

  async function enable() {
    toggle.disabled = true;
    setNote("Loading 3D...", false);

    try {
      await ensureScene();
      readColors();

      enabled = true;
      avatarEl.hidden = true;
      holder.hidden = false;
      holder.setAttribute("aria-label", "NOVA 3D avatar, " + state);

      if (!resizeWatcher && typeof window.ResizeObserver === "function") {
        resizeWatcher = new window.ResizeObserver(() => {
          if (enabled) {
            resize();
          }
        });
        resizeWatcher.observe(holder);
      }

      resize();
      document.addEventListener("pointermove", onPointerMove);
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
      start();

      writeSetting("on");
      setNote("", false);
    } catch (error) {
      enabled = false;
      avatarEl.hidden = false;
      holder.hidden = true;
      writeSetting("off");
      setNote(error.message, true);
    } finally {
      renderToggle();
      toggle.disabled = false;
    }
  }

  function disable() {
    stop();
    document.removeEventListener("pointermove", onPointerMove);
    document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    lookTarget.x = 0;
    lookTarget.y = 0;

    enabled = false;
    holder.hidden = true;
    avatarEl.hidden = false;
    writeSetting("off");
    setNote("", false);
    renderToggle();
  }

  function onContextLost(event) {
    event.preventDefault();
    disable();
    setNote("The 3D view stopped because the graphics card was reset. The normal avatar is back.", true);
  }

  /* ----- Events ----- */

  toggle.addEventListener("click", () => {
    if (enabled) {
      disable();
    } else {
      enable();
    }
  });

  // Follow the state of the normal avatar (app.js and voice.js already keep it up to date).
  new MutationObserver(() => {
    state = currentState();
    stateSince = time;
    holder.setAttribute("aria-label", "NOVA 3D avatar, " + state);
    if (ready && enabled && !running) {
      renderOnce();
    }
  }).observe(avatarEl, { attributes: true, attributeFilter: ["data-state"] });

  // Follow the color theme.
  new MutationObserver(() => {
    if (ready) {
      readColors();
      if (enabled && !running) {
        renderOnce();
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Save battery: pause while the tab is hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  if (readSetting() === "on") {
    enable();
  }
})();