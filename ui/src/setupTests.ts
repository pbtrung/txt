import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement ResizeObserver -- React Aria's Virtualizer (the
// Library screen's book list) observes its scroll container with one.
// Tests that render it mock the Virtualizer wrapper directly instead
// of relying on this to produce real measurements; it only exists so an
// unmocked render doesn't throw "ResizeObserver is not defined".
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement matchMedia -- ReaderScreen uses it to pick a
// default font size for the viewport. Defaults to "desktop" (no match);
// individual tests can vi.stubGlobal("matchMedia", ...) to simulate mobile.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
