// Shared by every endpoint that needs "is this a genuine, non-expired
// Firebase ID token for this project" and nothing else -- keys.ts and
// r2Token.ts both start here before doing their own, different, ctl-backed
// authorization (docs/auth.md §5 step 1).
import { verifyFirebaseIdToken } from "./firebaseAuth";

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export interface VerifiedIdentity {
  uid: string;
  idToken: string;
}

export async function verifiedIdentity(
  request: Request,
  projectId: string,
): Promise<VerifiedIdentity | null> {
  const idToken = bearerToken(request);
  if (!idToken) return null;
  try {
    return { uid: (await verifyFirebaseIdToken(idToken, projectId)).uid, idToken };
  } catch {
    return null;
  }
}

export async function verifiedUid(
  request: Request,
  projectId: string,
): Promise<string | null> {
  return (await verifiedIdentity(request, projectId))?.uid ?? null;
}
