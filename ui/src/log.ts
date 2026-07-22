// Verbose diagnostic logging, on by default -- the Unlock screen is where
// the vault's own log-in steps and every db.execute() call get logged
// (state/VaultContext.tsx, data/db.ts), useful for debugging a stuck/slow
// unlock or an unexpected query without having to opt in first. Load the
// app with `?verbose=0` to turn it off for that page load instead.
//
// The flag lives in memory only, read once from the URL when this module
// first loads -- it resets on reload, same as everything else in this app
// (see VaultContext.tsx's own no-persistence design). Toggle it mid-session
// with setVerbose() instead of reloading with a new query string if you
// don't want to lose an in-progress session.

function initialVerbose(): boolean {
  if (typeof location === "undefined") return true;
  return new URLSearchParams(location.search).get("verbose") !== "0";
}

let verboseEnabled = initialVerbose();

export function isVerbose(): boolean {
  return verboseEnabled;
}

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function verbose(...args: unknown[]): void {
  if (verboseEnabled) {
    console.log("[verbose]", ...args);
  }
}
