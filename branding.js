// Loads the configurable branding (logo URL + colour palette) from /branding
// and applies it: CSS custom properties for the theme, and the logo image src.
// Fonts are intentionally not configurable.
(function () {
  function mix(hex, target, amount) {
    const h = (hex || "").replace("#", "");
    if (h.length !== 6) return hex;
    const r = parseInt(h.substr(0, 2), 16);
    const g = parseInt(h.substr(2, 2), 16);
    const b = parseInt(h.substr(4, 2), 16);
    const tr = (target >> 16) & 255, tg = (target >> 8) & 255, tb = target & 255;
    const m = (c, t) => Math.round(c + (t - c) * amount);
    const to2 = n => n.toString(16).padStart(2, "0");
    return "#" + to2(m(r, tr)) + to2(m(g, tg)) + to2(m(b, tb));
  }
  const lighten = (hex, a) => mix(hex, 0xffffff, a);
  const darken = (hex, a) => mix(hex, 0x000000, a);
  const isHex = v => /^#[0-9a-fA-F]{6}$/.test(v || "");

  function applyTheme(theme) {
    if (!theme) return;
    const docEl = document.documentElement;
    const s = docEl.style;
    // Suppress transitions while swapping the variables, so transitioned
    // properties (e.g. button background) take the new values immediately.
    docEl.classList.add("branding-swap");
    if (isHex(theme.primary)) {
      s.setProperty("--blue", theme.primary);
      s.setProperty("--blue-lt", lighten(theme.primary, 0.88));
    }
    if (isHex(theme.accent)) {
      s.setProperty("--cyan", theme.accent);
      s.setProperty("--cyan-dark", darken(theme.accent, 0.4));
      s.setProperty("--cyan-lt", lighten(theme.accent, 0.86));
    }
    if (isHex(theme.dark)) {
      s.setProperty("--navy", theme.dark);
      s.setProperty("--navy2", lighten(theme.dark, 0.15));
    }
    if (isHex(theme.bg)) {
      s.setProperty("--bg2", theme.bg);
      s.setProperty("--bg3", darken(theme.bg, 0.04));
    }
    if (isHex(theme.text)) s.setProperty("--text", theme.text);
    void docEl.offsetWidth; // reflow so values settle without a transition
    requestAnimationFrame(() => docEl.classList.remove("branding-swap"));
  }

  function applyLogo(logoUrl) {
    if (!logoUrl) return;
    document.querySelectorAll(".brand-logo, .login-logo").forEach(img => {
      const fallback = img.getAttribute("src"); // bundled default
      img.onerror = () => { img.onerror = null; img.src = fallback; };
      img.src = logoUrl;
    });
  }

  function showDemo(demo) {
    if (!demo) return;
    const hint = document.getElementById("demo-hint"); // login page
    if (hint) hint.style.display = "block";
    const container = document.querySelector(".container");
    if (container && !document.getElementById("demo-banner")) {
      const b = document.createElement("div");
      b.id = "demo-banner";
      b.className = "demo-banner";
      b.textContent = "Demo-Umgebung — Änderungen am Admin sind deaktiviert, Daten werden nachts zurückgesetzt.";
      container.insertBefore(b, container.firstChild);
    }
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  fetch("/branding")
    .then(r => (r.ok ? r.json() : null))
    .then(b => {
      if (!b) return;
      applyTheme(b.theme);
      whenReady(() => { applyLogo(b.logoUrl); showDemo(b.demo); });
    })
    .catch(() => {});
})();
