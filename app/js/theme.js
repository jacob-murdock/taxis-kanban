/** Apply the color theme before first paint. Classic script: keep it out of
 * the module graph so the pages can run it from `<head>`.
 * `localStorage["taxis-theme"]` is "light", "dark", or absent (system).
 */
(function () {
  var KEY = "taxis-theme";
  var ORDER = ["system", "light", "dark"];

  function read() {
    try {
      var value = localStorage.getItem(KEY);
      if (value === "light" || value === "dark") return value;
    } catch {
      /* Private mode can throw. Fall through to the system theme. */
    }
    return "system";
  }

  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
  }

  function label(mode) {
    if (mode === "light") return "Theme: light";
    if (mode === "dark") return "Theme: dark";
    return "Theme: system";
  }

  apply(read());

  function paint(button, mode) {
    button.textContent = label(mode);
  }

  function onClick() {
    var mode = read();
    var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* Ignore a full or blocked store; the choice still applies this visit. */
    }
    apply(next);
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i += 1) paint(buttons[i], next);
  }

  function bind() {
    var mode = read();
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      paint(button, mode);
      if (button.getAttribute("data-theme-bound") === "true") continue;
      button.setAttribute("data-theme-bound", "true");
      button.addEventListener("click", onClick);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
