(() => {
  "use strict";

  const THEMES = [
    { id: "cyber", label: "Cyber" },
    { id: "aurora", label: "Aurora" },
    { id: "sunset", label: "Sunset" },
    { id: "nebula", label: "Nebula" },
  ];
  const STORAGE_KEY = "nova-theme";

  const root = document.documentElement;
  const card = document.querySelector(".avatar-card");
  if (!card) {
    return;
  }

  function readSavedTheme() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return THEMES.some((theme) => theme.id === saved) ? saved : "cyber";
    } catch (error) {
      return "cyber";
    }
  }

  function saveTheme(id) {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch (error) {
      // Saving is optional. The theme still works for this visit.
    }
  }

  const picker = document.createElement("div");
  picker.className = "theme-picker";
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Avatar color theme");

  const label = document.createElement("p");
  label.className = "theme-label";
  label.textContent = "Avatar theme";
  picker.append(label);

  const buttons = THEMES.map((theme) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip theme-chip";
    button.dataset.themeId = theme.id;
    button.textContent = theme.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      applyTheme(theme.id, true);
    });
    picker.append(button);
    return button;
  });

  function applyTheme(id, persist) {
    if (id === "cyber") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", id);
    }

    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.themeId === id));
    });

    if (persist) {
      saveTheme(id);
    }
  }

  card.append(picker);
  applyTheme(readSavedTheme(), false);
})();