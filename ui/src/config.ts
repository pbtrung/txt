// The deployed Worker's own URL isn't a secret (docs/auth.md §8: the
// database URL, and by extension the Worker endpoint that hands it out,
// needs no protection -- access control rests on the token, not on
// obscurity), so it's a Vite build-time env var, not part of creds.json.
export const WORKER_URL: string = import.meta.env.VITE_WORKER_URL ?? "http://localhost:8787";
