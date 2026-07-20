// Follows the OS/browser color-scheme preference by stamping data-bs-theme
// on <html> -- theme.css's [data-bs-theme="light"/"dark"] rules then supply
// the brass/gold accent (see docs/ui.md's "Look and feel").

export function initTheme(): void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.setAttribute("data-bs-theme", mql.matches ? "dark" : "light");
  };
  apply();
  mql.addEventListener("change", apply);
}
