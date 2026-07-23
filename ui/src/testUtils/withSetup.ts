// The standard documented Vue pattern for unit-testing a composable in
// isolation, in lieu of an official Vue equivalent to
// @testing-library/react's renderHook: mounts a throwaway component whose
// setup() just calls the composable and captures its return value. Returns
// the app instance too so callers can app.unmount() when a composable
// registers onUnmounted() cleanup that matters for the test (most don't).

import { createApp, type App } from "vue";

export interface WithSetupResult<T> {
  result: T;
  app: App;
}

export function withSetup<T>(composable: () => T): WithSetupResult<T> {
  let result!: T;
  const app = createApp({
    setup() {
      result = composable();
      return () => null;
    },
  });
  // No real page needed -- mounting into a detached element still runs
  // setup()/onMounted() correctly.
  app.mount(document.createElement("div"));
  return { result, app };
}
