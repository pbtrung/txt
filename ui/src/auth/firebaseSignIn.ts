// Firebase REST authentication without the full client SDK. ID and refresh
// tokens live only in this in-memory session; nothing is persisted by the UI.
import { objectRecord, stringField } from "../util/validation";

const SIGN_IN_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const REFRESH_URL = "https://securetoken.googleapis.com/v1/token";
const REFRESH_SKEW_MS = 60_000;

export interface FirebaseTokenProvider {
  getIdToken(forceRefresh?: boolean, signal?: AbortSignal): Promise<string>;
}

export class FirebaseSession implements FirebaseTokenProvider {
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    private readonly apiKey: string,
    readonly uid: string,
    private idToken: string,
    private refreshToken: string,
    private expiresAt: number,
  ) {}

  async getIdToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && Date.now() + REFRESH_SKEW_MS < this.expiresAt) {
      return this.idToken;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(signal).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    });
    const response = await fetch(
      `${REFRESH_URL}?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Firebase token refresh failed: ${response.status}`);
    }
    const data = objectRecord(await response.json(), "Firebase refresh response");
    this.idToken = stringField(data, "id_token", "Firebase refresh response");
    this.refreshToken = stringField(data, "refresh_token", "Firebase refresh response");
    this.expiresAt = expiryFromNow(data, "Firebase refresh response", "expires_in");
    return this.idToken;
  }
}

export async function signIn(
  apiKey: string,
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<FirebaseSession> {
  const response = await fetch(`${SIGN_IN_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal,
  });
  if (!response.ok) throw new Error(`Firebase sign-in failed: ${response.status}`);
  const data = objectRecord(await response.json(), "Firebase sign-in response");
  return new FirebaseSession(
    apiKey,
    stringField(data, "localId", "Firebase sign-in response"),
    stringField(data, "idToken", "Firebase sign-in response"),
    stringField(data, "refreshToken", "Firebase sign-in response"),
    expiryFromNow(data, "Firebase sign-in response", "expiresIn"),
  );
}

function expiryFromNow(
  data: Record<string, unknown>,
  label: string,
  field: string,
): number {
  const raw = stringField(data, field, label);
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${label} has an invalid ${field}`);
  }
  return Date.now() + seconds * 1000;
}
