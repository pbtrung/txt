import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia -- ReaderScreen uses it to pick a
// default font size for the viewport. Defaults to "desktop" (no match);
// individual tests can vi.stubGlobal("matchMedia", ...) to simulate mobile.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
