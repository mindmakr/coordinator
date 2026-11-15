// The theme switch's memory, run in <head> before the first paint (live pages only: a
// static page runs no script, and its switch works by CSS alone). Applies the stored
// choice as <html data-theme>, checks its radio once the page is parsed, and stores a
// new choice. Storage blocked or broken: the system theme, nothing remembered.
(() => {
  const KEY = 'coordinator.theme';
  const CHOICES = ['system', 'light', 'dark'];
  const root = document.documentElement;
  let theme = 'system';
  try { const v = localStorage.getItem(KEY); if (CHOICES.includes(v)) theme = v; } catch { /* no storage */ }
  root.dataset.theme = theme;
  const bind = () => {
    const radio = document.getElementById(`theme-${theme}`);
    if (radio) radio.checked = true;
    document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
      if (!CHOICES.includes(r.value)) return;
      root.dataset.theme = r.value;
      try { localStorage.setItem(KEY, r.value); } catch { /* no storage: this page only */ }
    }));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
