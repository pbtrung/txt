import { importPKCS8, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { __setCertCacheForTests, verifyFirebaseIdToken } from "../firebaseAuth";

// A real, throwaway self-signed cert/key pair (openssl req -x509), used to
// exercise the actual RS256/X.509 verification path end to end rather than
// mocking it away -- matches this project's real-building-blocks testing
// philosophy on the Python side.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUKtIoQ1oSjobZm6VX2PgsXnig0E0wDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdGVzdC1maXJlYmFzZTAgFw0yNjA4MTQxMzUxMTFaGA8y
MTI2MDcyMTEzNTExMVowGDEWMBQGA1UEAwwNdGVzdC1maXJlYmFzZTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBANI885n+uyoLfT4Uni/u8PcO8OX++Rzh
DwIuk4+xUuzxOF0abahCELGONlTMZYylaJfKLC7gpx/CbVg8vvazEGz/L1aNzN6k
jsGMxnCOLW1WLBBx6hY+nXV655W4Bge/5GsyDeW1tRq32J1jRkOXtR9RJY5DaAII
S90s9odEfWX5l+w6UejUsp/w6xeyxYfub1/mUhQ2jfuQICm98sUpEph5PkB4waG7
w4XugdCPOhHgvubunK7RCUBs8cXw1N3ZwFxhwQYPTpWBXYZkIPndq+ez35MwmAfn
fSTKtRbKG8BZlglC7QX8bAuIuU+bQo4I1XhwQB9AP6nJbICaVbOvS8kCAwEAAaNT
MFEwHQYDVR0OBBYEFOdyOQB8Rur9AmWz4xVpaUC6lPgZMB8GA1UdIwQYMBaAFOdy
OQB8Rur9AmWz4xVpaUC6lPgZMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBALRtRhk+SstiyhCnCYO8/5UgpPXd1+OQHZyiviiQ2hywLCOASkeV/rwz
2UCJknlI9Hiu7Cbfh1d1Vk//5gO+SjPwLUV+Cl4E33HbbdDTvZ3Wc9zaQJteV59I
QPNCTfzv2kRtY5GJtK/MX1ZUGKobc4if73V2FtA1Mfr+D1p+PyMShyQZ5yrwF0Dm
9MQ7pYl/g5NBo33F9MIWvcGpivaXSU8ix3ltHZt0zhfpvL6Wh7wqiukmNkkdT8Ri
rcnkyjHkZOAopOZp4o7+IXZKOJkRHhrscjMRfnH4i4I/rrwRV3ifzwNujGDW5evL
rntEeVEskc7KTCnUPQvRLxdYjQfmcOc=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDSPPOZ/rsqC30+
FJ4v7vD3DvDl/vkc4Q8CLpOPsVLs8ThdGm2oQhCxjjZUzGWMpWiXyiwu4Kcfwm1Y
PL72sxBs/y9WjczepI7BjMZwji1tViwQceoWPp11eueVuAYHv+RrMg3ltbUat9id
Y0ZDl7UfUSWOQ2gCCEvdLPaHRH1l+ZfsOlHo1LKf8OsXssWH7m9f5lIUNo37kCAp
vfLFKRKYeT5AeMGhu8OF7oHQjzoR4L7m7pyu0QlAbPHF8NTd2cBcYcEGD06VgV2G
ZCD53avns9+TMJgH530kyrUWyhvAWZYJQu0F/GwLiLlPm0KOCNV4cEAfQD+pyWyA
mlWzr0vJAgMBAAECggEAHVLdE2yhRHMHzAHqMntcZslRtnLC4lFN25sNf+xWya+3
kdze0KouU+WnFFrSCzUDCrDrSrqQ9PAUeks2w4gkUV+ihasPmTpQoxR0lTxvf6GW
UdDhuqqPIdS7unlJdglA3ebEY3bdxNVBxGoVYdYmMDEMUPR77FSl6DqeRC28Y92U
pqZuIt8b+3z0Ymydjfwvp7VACuxzgsVZjUERKdC6y0wxjacPjJa13P7y/g8mcwnF
XXvdR6yJIDWGowq392BsSZiW/TiQmXubd9j3jBwLBPNunRd1vSwxThxf/hQAk+k3
D8Wrv+FYFlE9ZLQYUHknM/Fi/+EYc2vT3emq0u44EQKBgQDrhW7bfACmEpVx1gD7
j7ECXebRfICvKMtASmryxiGC7AlXx6vJvtInLHnVFYfrJEPU4H7/RCf+SGNF4NV1
xX435XXYpArfeQQvwaAY2qHlpOvkGth+d9zbGVVTVeE3XIV+wvKZ0AABNKn9ycED
ksM7nwRjebw+cA+AJPdBgKHj1QKBgQDkhLsHfHLYardO0UBsKWzZeg+j/Kg4Luli
h61Vqz1QqPb50/98I5kxmZgTAdKr37AdYWRc/Q0c3yaFigzrmNY1F1BDhMjtTbeZ
mxTC1XMxsNvg5/HbF552LeobTnqIB5VjDvQ6TGNPp8Fc1lPDH9y6jqhbFbQqUsiX
FoEIBzjmJQKBgQDbZIO870lHan5N+XUW4WaZdtGCCUFyaUTUkb4IgupKpAeb/oMX
PqtTFIo1JYZkU3bggXOr5FiA9fuL54HQ4HTQKu7ZLQ5316o/tlWlcVxoqHWZGizb
ulpAutuR8qkGQiiUyZLmFy058k37/InRA1DcZCfZZlglrYuy6jxthx7HNQKBgQCY
6bB1S/NVmeNbnG4tcnLh++mnZBP0tH97bSqx3spCxS2u8wtMuE10gUDfxyJ/3Ejv
ABK2nqY9oZ0XUs9ef4EnOZh99ca19IFdCgcUcNyKbbxUfSC76MwibIrxBsy7Zcey
53jJ4f+6d5jOVKTsNs/vDjLd8GIEyCxt3aMuChcq+QKBgQCMMeius6RBZpHGb/8k
yy2EsstGid1BmxGlyd12IcmXpTpnC5e6uAyNRImI+2YmKtLXQfpurdRreCWFEb4Q
euepzQuRcNjC4rfZvfQ7VvbeB/Bu/voT9FBG/izrTjL0Qd6bj6OAGlWeC17+TECd
JJXO/ckqEuUYuGFjawMvzWiybg==
-----END PRIVATE KEY-----
`;

const PROJECT_ID = "test-project";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const KID = "test-kid";

async function signToken(claims: Record<string, unknown> = {}): Promise<string> {
  const key = await importPKCS8(TEST_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: PROJECT_ID,
    sub: "uid-123",
    iat: now,
    auth_time: now,
    exp: now + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .sign(key);
}

beforeEach(() => {
  __setCertCacheForTests({ [KID]: TEST_CERT });
});

describe("verifyFirebaseIdToken", () => {
  it("accepts a validly signed token and returns its uid", async () => {
    const token = await signToken();
    const result = await verifyFirebaseIdToken(token, PROJECT_ID);
    expect(result.uid).toBe("uid-123");
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({ exp: now - 10 });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow();
  });

  it("rejects the wrong audience", async () => {
    const token = await signToken({ aud: "some-other-project" });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow();
  });

  it("rejects the wrong issuer", async () => {
    const token = await signToken({ iss: "https://securetoken.google.com/wrong" });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow();
  });

  it("rejects a tampered signature", async () => {
    const token = await signToken();
    const tampered = token.slice(0, -4) + "abcd";
    await expect(verifyFirebaseIdToken(tampered, PROJECT_ID)).rejects.toThrow();
  });

  it("rejects iat in the future", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signToken({ iat: future });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow(/iat/);
  });

  it("rejects auth_time in the future", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signToken({ auth_time: future });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow(/auth_time/);
  });

  it("rejects a missing sub claim", async () => {
    const token = await signToken({ sub: undefined });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow(/sub/);
  });

  it("rejects an unknown signing key id", async () => {
    const token = await signToken();
    __setCertCacheForTests({ "different-kid": TEST_CERT });
    await expect(verifyFirebaseIdToken(token, PROJECT_ID)).rejects.toThrow(/key id/);
  });
});
