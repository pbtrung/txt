// docs/auth.md §4.2/§4.3: every mutating /v1/* endpoint needs a verified
// ticket and proof, on top of the Access session worker/api.ts already
// checked. This is the one place that plumbing lives so
// worker/documentsEndpoint.ts and worker/bookmarksEndpoint.ts don't each
// re-derive it -- three call sites landing in this same milestone is
// exactly the point past which that would be real duplication.
import { verifyTicket, TicketVerificationError } from "./ownerTicket";
import { verifyProof, ProofVerificationError } from "./ownerProof";
import type { ProofEnvelope } from "./ownerProof";
import { base64Decode } from "./base64";

const TICKET_HEADER = "X-Owner-Ticket";
const PROOF_HEADER = "X-Owner-Proof";

export class ProofRequiredError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProofRequiredError";
  }
}

// docs/auth.md §4.2's status table: ticket problems are uniformly 401;
// proof problems split between 400 (malformed), 401 (expiry), and 403
// (the signature/binding chain actually failing).
function statusForProofError(message: string): number {
  if (/expired|too far in the future/.test(message)) return 401;
  if (/does not match|signature verification failed/.test(message)) return 403;
  return 400;
}

export interface ProofContext {
  bodyJson: Record<string, unknown>;
  userHandle: Uint8Array;
  dbPrefix: string;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ProofRequiredError(400, `missing or invalid ${field}`);
  }
  return value;
}

function requireProofEnvelope(header: string | null): ProofEnvelope {
  if (!header) {
    throw new ProofRequiredError(400, "missing X-Owner-Proof header");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw new ProofRequiredError(400, "malformed X-Owner-Proof header");
  }
  const envelope = parsed as Partial<ProofEnvelope>;
  if (
    envelope.version !== 1 ||
    typeof envelope.expires_at !== "number" ||
    typeof envelope.request_id !== "string" ||
    typeof envelope.signature !== "string"
  ) {
    throw new ProofRequiredError(400, "malformed X-Owner-Proof header");
  }
  return envelope as ProofEnvelope;
}

/** Verifies the ticket and proof of possession for a mutating request
 * (docs/auth.md §4.2), and returns the parsed JSON body plus the decoded
 * `user_handle`/`db_prefix` the request signed over. Throws
 * `ProofRequiredError` with the exact status `docs/auth.md`'s table
 * specifies on any failure. */
export async function requireProof(
  request: Request,
  env: Env,
  url: URL,
): Promise<ProofContext> {
  const ticketToken = request.headers.get(TICKET_HEADER);
  if (!ticketToken) {
    throw new ProofRequiredError(400, "missing X-Owner-Ticket header");
  }
  const proof = requireProofEnvelope(request.headers.get(PROOF_HEADER));

  let ticketClaims;
  try {
    ticketClaims = await verifyTicket(
      ticketToken,
      base64Decode(env.TICKET_SIGNING_KEY),
    );
  } catch (error) {
    if (error instanceof TicketVerificationError) {
      throw new ProofRequiredError(401, error.message);
    }
    throw error;
  }

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  let bodyJson: unknown;
  try {
    bodyJson =
      bodyBytes.length === 0 ? {} : JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw new ProofRequiredError(400, "malformed request body");
  }
  if (typeof bodyJson !== "object" || bodyJson === null) {
    throw new ProofRequiredError(400, "malformed request body");
  }
  const body = bodyJson as Record<string, unknown>;
  const dbPrefix = requireString(body, "db_prefix");
  let userHandle: Uint8Array;
  try {
    userHandle = base64Decode(requireString(body, "user_handle"));
  } catch {
    throw new ProofRequiredError(400, "malformed user_handle");
  }

  try {
    await verifyProof({
      ticketClaims,
      exactCompactTicket: ticketToken,
      proof,
      userHandle,
      dbPrefix,
      method: request.method,
      path: url.pathname,
      body: bodyBytes,
    });
  } catch (error) {
    if (error instanceof ProofVerificationError) {
      throw new ProofRequiredError(statusForProofError(error.message), error.message);
    }
    throw error;
  }

  return { bodyJson: body, userHandle, dbPrefix };
}
