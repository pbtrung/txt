import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement window.matchMedia at all (throws "matchMedia is
// not a function") -- this stub evaluates min-width/max-width against
// window.innerWidth (jsdom's default: 1024, a desktop-sized viewport) so
// code that branches on viewport size (theme.ts's initTheme,
// ReaderScreen's default font size) gets real, if static, behavior in
// jsdom-environment tests rather than either a crash or an always-false
// no-op. Guarded on `typeof window` since most test files run under
// vitest's default "node" environment, where there's no window at all.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => {
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const width = window.innerWidth;
    const matches = (!min || width >= parseFloat(min[1])) && (!max || width <= parseFloat(max[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
}
