import { describe, expect, it } from "vitest";
import { toBase32Crockford } from "./base32Crockford";

describe("toBase32Crockford", () => {
  // Cross-checked against txt/random_token.py's to_base32_crockford directly
  // (python3 -c "from txt.random_token import to_base32_crockford; ...") --
  // not a value made up for this test.
  it("matches txt/random_token.py's own output for known 32-byte inputs", () => {
    const sequential = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    expect(toBase32Crockford(sequential)).toBe("000g40r40m30e209185gr38e1w8124gk2gahc5rr34d1p70x3rfg");

    const hex = "d35adb3f5181e19daf1da5e344f61bc8ab890dd714efadefd67091dab692d445";
    const random = Uint8Array.from(hex.match(/.{2}/g)!.slice(0, 32).map((b) => parseInt(b, 16)));
    expect(toBase32Crockford(random)).toBe("tdddpfthg7gsvbrxmqhm9xgvs2nrj3eq2kqtvvype28xndmjth2g");
  });

  it("produces 52 characters for a 32-byte input", () => {
    expect(toBase32Crockford(new Uint8Array(32)).length).toBe(52);
  });

  it("returns an empty string for empty input", () => {
    expect(toBase32Crockford(new Uint8Array(0))).toBe("");
  });
});
