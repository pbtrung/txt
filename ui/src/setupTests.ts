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

// jsdom never actually lays anything out, so every element's offsetWidth/
// offsetHeight are 0 (jsdom *does* define these -- as getters that always
// return 0, not just leave them undefined, so a "only patch if missing"
// guard would never fire here) -- @tanstack/virtual-core's default
// element-size reader (getRect(), see its source) reads exactly those two
// properties, not clientHeight or getBoundingClientRect(), to decide which
// rows are "visible" at all. Left unmocked, every virtualized list
// (Library's book/browse lists) computes an empty visible range regardless
// of overscan and renders zero rows in every test. A fixed non-zero size
// (desktop-sized, comfortably more than any test fixture list needs) makes
// small fixture lists render in full like before virtualization existed,
// while still leaving a large synthetic list (e.g. 500 items) rendering
// only a bounded window around it -- the thing that actually proves
// virtualization is working, not just wired up.
if (typeof window !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
}

// jsdom doesn't implement ResizeObserver at all (throws "ResizeObserver is
// not defined") -- @tanstack/react-virtual's default element-measuring
// strategy still creates one (for *future* resizes; the initial size above
// is read synchronously via offsetWidth/offsetHeight before this ever gets
// used), so it needs to exist even though jsdom never actually fires a
// real resize for this stub to forward.
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
