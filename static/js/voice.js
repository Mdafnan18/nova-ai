(() => {
  "use strict";

  const chat = window.NovaChat;
  if (!chat) {
    return; // app.js did not load, so there is nothing to connect to
  }

  const micBtn = document.getElementById("mic-btn");
  const voiceToggle = document.getElementById("voice-toggle");
  const voiceNote = document.getElementById("voice-note");
  const input = document.getElementById("chat-input");
  const formError = document.getElementById("form-error");
  const form = document.getElementById("chat-form");
  const clearBtn = document.getElementById("clear-btn");
  const promptButtons = document.querySelectorAll(".prompts [data-prompt]");

  const synth = window.speechSynthesis;
  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canSpeak = Boolean(synth) && "SpeechSynthesisUtterance" in window;
  const canListen = Boolean(SpeechRecognitionClass);

  const NAME_KEY = "nova-voice-name";
  const RATE_KEY = "nova-voice-rate";
  const SAMPLE_TEXT = "Hi, I'm NOVA. This is how I sound.";

  const ERROR_MESSAGES = {
    "not-allowed":
      "Microphone access is blocked. Click the lock icon in the address bar, allow Microphone, then reload the page. You can still type.",
    "service-not-allowed":
      "Microphone access is blocked. Click the lock icon in the address bar, allow Microphone, then reload the page. You can still type.",
    "no-speech": "I did not hear anything. Try again, or type your message.",
    "audio-capture": "I cannot find a microphone. Check that one is connected, or type your message.",
    network:
      "Voice input needs an internet connection, because the browser sends your voice to an online service. You can still type.",
    "language-not-supported": "This browser cannot do voice input in your language. You can still type.",
  };

  function showError(message) {
    formError.textContent = message;
  }

  function settleIdle() {
    if (!chat.isBusy()) {
      chat.setState("idle");
    }
  }

  /* ----- Saved settings (kept in this browser) ----- */

  function readSetting(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeSetting(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Saving is optional. The setting still works for this visit.
    }
  }

  function savedRate() {
    const value = Number.parseFloat(readSetting(RATE_KEY));
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.min(1.4, Math.max(0.7, value));
  }

  /* ----- Voice on/off setting ----- */

  let voiceOn = true;
  try {
    voiceOn = window.localStorage.getItem("nova-voice") !== "off";
  } catch (error) {
    voiceOn = true;
  }

  function renderVoiceToggle() {
    voiceToggle.setAttribute("aria-pressed", String(voiceOn));
    voiceToggle.textContent = voiceOn ? "Voice: On" : "Voice: Off";
  }

  /* ----- Spoken replies (text to speech) ----- */

  let voice = null; // the automatic best match
  let speakToken = 0;
  let resolveCurrent = null;

  function pickVoice() {
    const pageLang = (navigator.language || "en-US").toLowerCase();
    let best = null;
    let bestScore = -1;

    synth.getVoices().forEach((candidate) => {
      const lang = (candidate.lang || "").toLowerCase();
      if (!lang.startsWith("en")) {
        return;
      }
      const name = (candidate.name || "").toLowerCase();
      let score = 1;
      if (lang === pageLang) {
        score += 3;
      }
      if (lang === "en-us") {
        score += 1;
      }
      if (name.includes("natural")) {
        score += 3;
      }
      if (name.includes("google")) {
        score += 1;
      }
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    voice = best;
  }

  // The voice you chose in Voice settings, or the automatic one.
  function activeVoice() {
    const name = readSetting(NAME_KEY);
    if (name) {
      const found = synth.getVoices().find((candidate) => candidate.name === name);
      if (found) {
        return found;
      }
    }
    return voice;
  }

  // Long sentences can cut off in some browsers, so we speak short chunks one after another.
  function splitIntoChunks(text) {
    const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let current = "";

    sentences.forEach((original) => {
      let sentence = original;

      while (sentence.length > 220) {
        let cut = sentence.lastIndexOf(" ", 200);
        if (cut < 50) {
          cut = 200;
        }
        if (current) {
          chunks.push(current.trim());
          current = "";
        }
        chunks.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut);
      }

      if (current && (current + sentence).length > 180) {
        chunks.push(current.trim());
        current = "";
      }
      current += sentence;
    });

    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks.filter(Boolean);
  }

  function stopSpeaking() {
    speakToken += 1;
    if (canSpeak) {
      synth.cancel();
    }
    if (resolveCurrent) {
      const done = resolveCurrent;
      resolveCurrent = null;
      done();
    }
  }

  function speak(text) {
    return new Promise((resolve) => {
      stopSpeaking();

      const myToken = speakToken;
      const chunks = splitIntoChunks(text);
      let index = 0;
      let watchdog = 0;

      resolveCurrent = resolve;

      function finish() {
        window.clearTimeout(watchdog);
        if (resolveCurrent === resolve) {
          resolveCurrent = null;
        }
        resolve();
      }

      function next() {
        if (myToken !== speakToken) {
          return; // someone stopped the speech
        }
        if (index >= chunks.length) {
          finish();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        index += 1;

        const chosen = activeVoice();
        if (chosen) {
          utterance.voice = chosen;
          utterance.lang = chosen.lang;
        } else {
          utterance.lang = navigator.language || "en-US";
        }
        utterance.rate = savedRate();
        utterance.pitch = 1;

        utterance.onend = next;
        utterance.onerror = () => {
          if (myToken === speakToken) {
            finish();
          }
        };

        synth.speak(utterance);
      }

      // Safety net: never let NOVA get stuck "speaking" if the browser forgets to tell us it finished.
      // A slow speed needs more time, so the time limit grows with it.
      watchdog = window.setTimeout(() => {
        if (myToken === speakToken) {
          stopSpeaking();
        }
      }, Math.min(120000, 8000 + (text.length * 90) / savedRate()));

      next();
    });
  }

  /* ----- Voice input (speech to text) ----- */

  let recognition = null;
  let listening = false;
  let cancelled = false;
  let hadError = false;
  let finalText = "";

  function stopListening(cancel) {
    if (!recognition) {
      return;
    }
    cancelled = cancel;
    try {
      if (cancel) {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch (error) {
      // The recognizer was already stopped. Nothing to do.
    }
  }

  function handleRecognitionError(code) {
    if (code === "aborted") {
      return;
    }
    hadError = true;
    showError(ERROR_MESSAGES[code] || "Voice input stopped (" + code + "). You can still type your message.");

    if (code === "no-speech") {
      settleIdle();
      return;
    }

    chat.setState("error");
    window.setTimeout(() => {
      if (!listening) {
        settleIdle();
      }
    }, 2500);
  }

  function startListening() {
    if (chat.isBusy() || listening) {
      return;
    }

    stopSpeaking();
    showError("");
    finalText = "";
    cancelled = false;
    hadError = false;

    recognition = new SpeechRecognitionClass();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add("is-listening");
      micBtn.setAttribute("aria-pressed", "true");
      micBtn.setAttribute("aria-label", "Stop listening");
      chat.setState("listening");
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += piece;
        } else {
          interim += piece;
        }
      }
      input.value = (finalText + interim).trim();
      input.dispatchEvent(new Event("input")); // lets app.js update the counter and box size
    };

    recognition.onerror = (event) => {
      handleRecognitionError(event.error);
    };

    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("is-listening");
      micBtn.setAttribute("aria-pressed", "false");
      micBtn.setAttribute("aria-label", "Start voice input");

      const text = (finalText || input.value).trim();
      recognition = null;

      if (hadError) {
        return;
      }
      if (cancelled) {
        settleIdle();
        return;
      }
      if (text) {
        chat.sendMessage(text);
      } else {
        settleIdle();
        showError("I did not hear anything. Try again, or type your message.");
      }
    };

    try {
      recognition.start();
    } catch (error) {
      recognition = null;
      showError("Voice input could not start. You can still type your message.");
      settleIdle();
    }
  }

  /* ----- Voice settings panel (voice list, speed, test) ----- */

  function setupVoicePanel() {
    const head = document.querySelector(".chat-head");
    const actions = document.querySelector(".head-actions");
    if (!head || !actions) {
      return;
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "chip";
    toggleBtn.id = "voice-settings-btn";
    toggleBtn.textContent = "Voice settings";
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.setAttribute("aria-controls", "voice-panel");
    actions.insertBefore(toggleBtn, clearBtn.parentNode === actions ? clearBtn : null);

    const panel = document.createElement("div");
    panel.className = "voice-panel";
    panel.id = "voice-panel";
    panel.hidden = true;

    const voiceRow = document.createElement("div");
    voiceRow.className = "voice-row";
    const voiceLabel = document.createElement("label");
    voiceLabel.setAttribute("for", "voice-select");
    voiceLabel.textContent = "Voice";
    const select = document.createElement("select");
    select.id = "voice-select";
    voiceRow.append(voiceLabel, select);

    const rateRow = document.createElement("div");
    rateRow.className = "voice-row";
    const rateLabel = document.createElement("label");
    rateLabel.setAttribute("for", "voice-rate");
    const rateValue = document.createElement("span");
    rateValue.className = "voice-rate-value";
    rateLabel.append("Speed: ", rateValue);
    const range = document.createElement("input");
    range.type = "range";
    range.id = "voice-rate";
    range.min = "0.7";
    range.max = "1.4";
    range.step = "0.1";
    rateRow.append(rateLabel, range);

    const buttons = document.createElement("div");
    buttons.className = "voice-actions";
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "chip";
    testBtn.textContent = "Test voice";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "chip";
    resetBtn.textContent = "Reset";
    buttons.append(testBtn, resetBtn);

    panel.append(voiceRow, rateRow, buttons);
    head.insertAdjacentElement("afterend", panel);

    function showRate() {
      rateValue.textContent = Number(range.value).toFixed(1) + "x";
    }

    function populateVoices() {
      const all = synth.getVoices();
      const english = all.filter((candidate) => (candidate.lang || "").toLowerCase().startsWith("en"));
      const list = english.length > 0 ? english : all;
      const saved = readSetting(NAME_KEY) || "";

      select.replaceChildren();

      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "Automatic (best match)";
      select.append(auto);

      list.forEach((candidate) => {
        const option = document.createElement("option");
        option.value = candidate.name;
        option.textContent = candidate.name + " (" + candidate.lang + ")";
        select.append(option);
      });

      select.value = list.some((candidate) => candidate.name === saved) ? saved : "";
    }

    toggleBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggleBtn.setAttribute("aria-expanded", String(!panel.hidden));
    });

    select.addEventListener("change", () => {
      writeSetting(NAME_KEY, select.value);
    });

    range.addEventListener("input", () => {
      writeSetting(RATE_KEY, range.value);
      showRate();
    });

    testBtn.addEventListener("click", () => {
      if (chat.isBusy() || listening) {
        return;
      }
      chat.setState("speaking");
      speak(SAMPLE_TEXT).then(settleIdle);
    });

    resetBtn.addEventListener("click", () => {
      writeSetting(NAME_KEY, "");
      writeSetting(RATE_KEY, "1");
      select.value = "";
      range.value = "1";
      showRate();
    });

    range.value = String(savedRate());
    showRate();
    populateVoices();

    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", populateVoices);
    }
  }

  /* ----- Connect everything ----- */

  const notes = [];

  if (!canListen) {
    micBtn.hidden = true;
    notes.push("Voice input is not supported in this browser. Use Chrome or Edge on a computer, or type your message.");
  }

  if (!canSpeak) {
    voiceOn = false;
    voiceToggle.hidden = true;
    notes.push("Spoken replies are not supported in this browser.");
  }

  if (notes.length > 0) {
    voiceNote.textContent = notes.join(" ");
    voiceNote.hidden = false;
  }

  renderVoiceToggle();

  if (canSpeak) {
    pickVoice();
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", pickVoice);
    }
    setupVoicePanel();
  }

  // app.js calls this when a reply arrives. Returning a promise makes the avatar "speak" until it resolves.
  chat.setReplyHandler((reply) => {
    if (!canSpeak || !voiceOn) {
      return null;
    }
    return speak(reply);
  });

  voiceToggle.addEventListener("click", () => {
    voiceOn = !voiceOn;
    writeSetting("nova-voice", voiceOn ? "on" : "off");
    renderVoiceToggle();
    if (!voiceOn) {
      stopSpeaking(); // switching voice off also stops NOVA in the middle of a sentence
    }
  });

  micBtn.addEventListener("click", () => {
    if (listening) {
      stopListening(false);
    } else {
      startListening();
    }
  });

  clearBtn.addEventListener("click", () => {
    stopSpeaking();
    stopListening(true);
  });

  form.addEventListener("submit", () => {
    stopListening(true);
  });

  promptButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      stopListening(true);
    });
  });

  window.addEventListener("pagehide", () => {
    stopSpeaking();
    stopListening(true);
  });
})();