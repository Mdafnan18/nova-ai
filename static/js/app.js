(() => {
  "use strict";

  // Must be longer than the server's own AI timeout (120 seconds).
  const REQUEST_TIMEOUT_MS = 130000;

  let maxLength = 1000;

  const STATES = {
    idle: { label: "Idle", text: "Ready when you are." },
    listening: { label: "Listening", text: "Listening..." },
    thinking: { label: "Thinking", text: "Thinking..." },
    speaking: { label: "Speaking", text: "Speaking..." },
    error: { label: "Error", text: "Something went wrong." },
  };

  const avatar = document.getElementById("avatar");
  const statusText = document.getElementById("status-text");
  const statusPill = document.getElementById("status-pill");
  const pillText = document.getElementById("pill-text");
  const messages = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const clearBtn = document.getElementById("clear-btn");
  const formError = document.getElementById("form-error");
  const charCount = document.getElementById("char-count");
  const notice = document.querySelector(".notice");
  const stateButtons = document.querySelectorAll(".state-preview [data-state]");
  const promptButtons = document.querySelectorAll(".prompts [data-prompt]");

  let busy = false;
  let replyHandler = null; // voice.js plugs in here to speak replies aloud

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  /* ----- Avatar state ----- */

  function setState(state) {
    const info = STATES[state];
    if (!info) {
      return;
    }
    avatar.dataset.state = state;
    avatar.setAttribute("aria-label", "NOVA avatar, " + info.label.toLowerCase());
    statusText.textContent = info.text;
    statusPill.dataset.state = state;
    pillText.textContent = info.label;
    stateButtons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.state === state));
    });
  }

  /* ----- Talking to the Flask backend ----- */

  async function callApi(path, options) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(path, { ...options, signal: controller.signal });

      let data = null;
      try {
        data = await response.json();
      } catch (parseError) {
        data = null;
      }

      if (!response.ok) {
        const message = data && data.error ? data.error : "The server returned an error (" + response.status + ").";
        throw new Error(message);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The server took too long to answer. Please try again.");
      }
      if (error instanceof TypeError) {
        throw new Error("I cannot reach the server. Is python app.py still running?");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function postJson(path, body) {
    return callApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  /* ----- Chat helpers ----- */

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-" + role;

    const who = document.createElement("span");
    who.className = "msg-who";
    who.textContent = role === "user" ? "You" : "NOVA";

    const body = document.createElement("p");
    body.className = "msg-body";
    body.textContent = text; // textContent keeps text safe (no HTML injection)

    wrap.append(who, body);
    messages.append(wrap);
    scrollToBottom();
    return wrap;
  }

  function showTyping() {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-assistant typing";
    wrap.setAttribute("aria-label", "NOVA is thinking");

    for (let i = 0; i < 3; i += 1) {
      wrap.append(document.createElement("span"));
    }

    messages.append(wrap);
    scrollToBottom();
    return wrap;
  }

  function addWelcome() {
    addMessage("assistant", "Hello! I'm NOVA. Try a suggested prompt, type a message, or press the microphone and talk to me.");
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    clearBtn.disabled = value;
    stateButtons.forEach((btn) => {
      btn.disabled = value;
    });
    promptButtons.forEach((btn) => {
      btn.disabled = value;
    });
    document.querySelectorAll("[data-busy-disable]").forEach((element) => {
      element.disabled = value;
    });
  }

  function showFormError(message) {
    formError.textContent = message;
  }

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  function updateCount() {
    charCount.textContent = input.value.length + " / " + maxLength;
  }

  function startSpeakingReply(reply) {
    try {
      return replyHandler ? replyHandler(reply) : null;
    } catch (error) {
      return null;
    }
  }

  /* ----- Backend health check ----- */

  async function checkHealth() {
    try {
      const data = await callApi("/api/health", { method: "GET" });

      if (data && Number.isInteger(data.max_message_chars)) {
        maxLength = data.max_message_chars;
        input.maxLength = maxLength;
        updateCount();
      }

      if (data && typeof data.message === "string") {
        notice.textContent = data.message;
      }

      if (data && data.ai_ready === false) {
        addMessage("assistant", "Heads up: " + data.message);
      }
    } catch (error) {
      notice.textContent = "Backend not reachable. Start it with: python app.py";
      setState("error");
      addMessage("assistant", "Error: " + error.message);
    }
  }

  /* ----- Sending a message ----- */

  async function sendMessage(rawText) {
    const text = rawText.trim();

    if (busy) {
      return;
    }
    if (!text) {
      showFormError("Please type a message first.");
      return;
    }
    if (text.length > maxLength) {
      showFormError("Your message is too long. The limit is " + maxLength + " characters.");
      return;
    }

    showFormError("");
    setBusy(true);
    addMessage("user", text);
    input.value = "";
    autoResize();
    updateCount();
    setState("thinking");

    const typing = showTyping();

    // The first answer can be slow while the AI model loads into memory.
    const slowTimer = window.setTimeout(() => {
      statusText.textContent = "Still thinking... the first answer can be slow.";
    }, 6000);

    try {
      const data = await postJson("/api/chat", { message: text });
      window.clearTimeout(slowTimer);
      typing.remove();

      const reply = data && typeof data.reply === "string" ? data.reply : "";
      if (!reply) {
        throw new Error("The server sent an empty answer.");
      }

      addMessage("assistant", reply);
      setState("speaking");

      // If voice is on, wait until NOVA has finished speaking. Otherwise wait a short moment.
      const speaking = startSpeakingReply(reply);
      if (speaking && typeof speaking.then === "function") {
        await speaking;
      } else {
        await wait(Math.min(1200 + reply.length * 30, 8000));
      }
      setState("idle");
    } catch (error) {
      window.clearTimeout(slowTimer);
      typing.remove();
      addMessage("assistant", "Error: " + error.message);
      setState("error");

      if (!input.value) {
        input.value = text; // put the message back so you can try again
        autoResize();
        updateCount();
      }

      await wait(2500);
      setState("idle");
    } finally {
      window.clearTimeout(slowTimer);
      setBusy(false);
      input.focus();
    }
  }

  /* ----- Events ----- */

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(input.value);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener("input", () => {
    autoResize();
    updateCount();
    showFormError("");
  });

  clearBtn.addEventListener("click", async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await postJson("/api/clear", {});
    } catch (error) {
      // Even if the server is unreachable, we still clear the screen.
    }
    setBusy(false);
    messages.replaceChildren();
    showFormError("");
    setState("idle");
    addWelcome();
  });

  promptButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      sendMessage(btn.dataset.prompt);
    });
  });

  stateButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!busy) {
        setState(btn.dataset.state);
      }
    });
  });

  /* ----- Share a few functions with voice.js ----- */

  window.NovaChat = {
    setState,
    sendMessage,
    isBusy: () => busy,
    setReplyHandler: (handler) => {
      replyHandler = typeof handler === "function" ? handler : null;
    },
  };

  /* ----- Restore the conversation after a page reload ----- */

  async function restoreHistory() {
    try {
      const data = await callApi("/api/history", { method: "GET" });
      const saved = data && Array.isArray(data.messages) ? data.messages : [];

      saved.forEach((item) => {
        if (item && typeof item.content === "string" && (item.role === "user" || item.role === "assistant")) {
          addMessage(item.role, item.content);
        }
      });

      if (saved.length > 0) {
        return;
      }
    } catch (error) {
      // If the saved messages cannot be loaded, we simply start with the welcome message.
    }

    addWelcome();
  }

  /* ----- Start ----- */

  setState("idle");
  updateCount();
  restoreHistory().then(checkHealth);
})();
