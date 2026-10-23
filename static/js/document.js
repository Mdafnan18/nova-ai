(() => {
  "use strict";

  const MAX_FILE_BYTES = 200 * 1024; // files bigger than this are refused before reading
  const ALLOWED_TYPES = [".txt", ".md"];

  const head = document.querySelector(".chat-head");
  const clearBtn = document.getElementById("clear-btn");
  if (!head) {
    return;
  }

  let maxChars = 6000;
  let hasDocument = false;

  /* ----- Talking to the server ----- */

  async function request(path, options) {
    const response = await fetch(path, options);

    let data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data && data.error ? data.error : "The server returned an error (" + response.status + ").");
    }
    return data;
  }

  function friendly(error) {
    if (error instanceof TypeError) {
      return "I cannot reach the server. Is python app.py still running?";
    }
    return error.message;
  }

  /* ----- The panel (built here, so index.html stays unchanged) ----- */

  const panel = document.createElement("div");
  panel.className = "doc-panel";
  panel.hidden = true; // it only appears when the server supports documents

  const infoRow = document.createElement("div");
  infoRow.className = "doc-row";

  const title = document.createElement("span");
  title.className = "doc-title";
  title.textContent = "Document";

  const status = document.createElement("span");
  status.className = "doc-status";
  status.setAttribute("role", "status");

  infoRow.append(title, status);

  const actions = document.createElement("div");
  actions.className = "doc-actions";

  const chooseBtn = document.createElement("button");
  chooseBtn.type = "button";
  chooseBtn.className = "chip";
  chooseBtn.textContent = "Choose file";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "chip";
  removeBtn.textContent = "Remove";
  removeBtn.hidden = true;

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".txt,.md,text/plain,text/markdown";
  fileInput.hidden = true;
  fileInput.setAttribute("aria-label", "Choose a text file to ask questions about");

  actions.append(chooseBtn, removeBtn, fileInput);
  panel.append(infoRow, actions);
  head.insertAdjacentElement("afterend", panel);

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(isError));
  }

  function showDocument(info) {
    hasDocument = Boolean(info);
    removeBtn.hidden = !hasDocument;

    if (info) {
      setStatus("Using " + info.name + " (" + info.chars + " characters). Ask a question about it.", false);
    } else {
      setStatus("No document. Choose a .txt or .md file to ask questions about it.", false);
    }
  }

  async function refresh() {
    try {
      const data = await request("/api/document", { method: "GET" });

      if (!data.enabled) {
        panel.hidden = true; // demo mode: documents are turned off
        return;
      }
      if (Number.isInteger(data.max_chars)) {
        maxChars = data.max_chars;
      }
      panel.hidden = false;
      showDocument(data.document);
    } catch (error) {
      panel.hidden = true;
    }
  }

  /* ----- Choosing a file ----- */

  async function handleFile(file) {
    const lowerName = file.name.toLowerCase();

    if (!ALLOWED_TYPES.some((type) => lowerName.endsWith(type))) {
      setStatus("Only .txt and .md files are supported.", true);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setStatus("This file is too big. Please use a smaller text file.", true);
      return;
    }

    chooseBtn.disabled = true;
    removeBtn.disabled = true;
    setStatus("Reading " + file.name + "...", false);

    try {
      const text = (await file.text()).trim();

      if (!text) {
        throw new Error("The file is empty.");
      }
      if (text.length > maxChars) {
        throw new Error(
          "This file has " + text.length + " characters. The limit is " + maxChars + ". Please use a shorter file."
        );
      }

      const data = await request("/api/document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, text }),
      });
      showDocument({ name: data.name, chars: data.chars });
    } catch (error) {
      const note = hasDocument ? " Your earlier document is still in use." : "";
      setStatus(friendly(error) + note, true);
    } finally {
      chooseBtn.disabled = false;
      removeBtn.disabled = false;
      fileInput.value = ""; // lets you choose the same file again later
    }
  }

  /* ----- Events ----- */

  chooseBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      handleFile(file);
    }
  });

  removeBtn.addEventListener("click", async () => {
    removeBtn.disabled = true;
    try {
      await request("/api/document/clear", { method: "POST" });
      showDocument(null);
    } catch (error) {
      setStatus(friendly(error), true);
    } finally {
      removeBtn.disabled = false;
    }
  });

  // "Clear chat" also removes the document on the server, so we update the panel too.
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (clearBtn.disabled) {
        return;
      }
      showDocument(null);
      window.setTimeout(refresh, 1200); // double-check with the server a moment later
    });
  }

  refresh();
})();