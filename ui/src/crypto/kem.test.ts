import { describe, expect, it } from "vitest";

import * as kem from "./kem";
import fixtures from "./__fixtures__/vectors.json";
import { base64ToBytes, bytesToHex } from "./testUtil";

describe("kem", () => {
  it("unwrap() recovers a payload wrapped by txt/crypto.py's Kem.wrap", async () => {
    const { sk, payload, saltKemCt, blob } = fixtures.kemWrap;
    const result = await kem.unwrap(base64ToBytes(sk), base64ToBytes(saltKemCt), base64ToBytes(blob));
    expect(bytesToHex(result)).toBe(bytesToHex(base64ToBytes(payload)));
  });

  it("round-trips keypair -> wrap -> unwrap", async () => {
    const { pk, sk } = await kem.keypair();
    expect(pk.length).toBe(1624);
    expect(sk.length).toBe(3224);

    const payload = crypto.getRandomValues(new Uint8Array(64));
    const { saltKemCt, blob } = await kem.wrap(pk, payload);
    const recovered = await kem.unwrap(sk, saltKemCt, blob);
    expect(bytesToHex(recovered)).toBe(bytesToHex(payload));
  });

  it("encapsulate/decapsulate agree on the raw shared secret", async () => {
    const { pk, sk } = await kem.keypair();
    const { ct, ss: ss1 } = await kem.encapsulate(pk);
    const ss2 = await kem.decapsulate(sk, ct);
    expect(bytesToHex(ss2)).toBe(bytesToHex(ss1));
    expect(ss1.length).toBe(88);
  });

  it("unwrap() fails with the wrong private key", async () => {
    const { pk } = await kem.keypair();
    const { sk: wrongSk } = await kem.keypair();
    const payload = crypto.getRandomValues(new Uint8Array(64));
    const { saltKemCt, blob } = await kem.wrap(pk, payload);
    await expect(kem.unwrap(wrongSk, saltKemCt, blob)).rejects.toThrow();
  });
});
