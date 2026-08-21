local t = require("tests.testlib")
local sodium = require("txt.sodium")

local function key(fill)
  return string.rep(fill, sodium.KEY_BYTES)
end

local function nonce(fill)
  return string.rep(fill, sodium.NONCE_BYTES)
end

t.test("seal and open round-trip a plaintext under matching key/nonce/aad", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  t.equal(sodium.open(key("k"), nonce("n"), sealed, "aad"), "object/path")
end)

t.test("seal appends a fixed-size tag to the ciphertext", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  t.equal(#sealed, #"object/path" + sodium.TAG_BYTES)
end)

t.test("open round-trips an empty plaintext", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "", "aad"))
  t.equal(#sealed, sodium.TAG_BYTES)
  t.equal(sodium.open(key("k"), nonce("n"), sealed, "aad"), "")
end)

t.test("open rejects a mismatched key", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  t.falsy(sodium.open(key("x"), nonce("n"), sealed, "aad"))
end)

t.test("open rejects a mismatched nonce", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  t.falsy(sodium.open(key("k"), nonce("z"), sealed, "aad"))
end)

t.test("open rejects a mismatched aad", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  t.falsy(sodium.open(key("k"), nonce("n"), sealed, "different-aad"))
end)

t.test("open rejects a tampered ciphertext byte", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  local tampered = sealed:sub(1, 3)
    .. string.char(bit.bxor(sealed:byte(4), 0xFF))
    .. sealed:sub(5)
  t.falsy(sodium.open(key("k"), nonce("n"), tampered, "aad"))
end)

t.test("open rejects a tampered tag byte", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  local last = #sealed
  local tampered = sealed:sub(1, last - 1)
    .. string.char(bit.bxor(sealed:byte(last), 0xFF))
  t.falsy(sodium.open(key("k"), nonce("n"), tampered, "aad"))
end)

t.test("open rejects a ciphertext shorter than the tag", function()
  t.falsy(
    sodium.open(key("k"), nonce("n"), string.rep("x", sodium.TAG_BYTES - 1), "aad")
  )
end)

t.test("seal rejects a key that isn't exactly KEY_BYTES", function()
  local sealed, err = sodium.seal(string.rep("k", 16), nonce("n"), "object/path", "aad")
  t.falsy(sealed)
  t.equal(err, "invalid key length")
end)

t.test("seal rejects a nonce that isn't exactly NONCE_BYTES", function()
  local sealed, err = sodium.seal(key("k"), string.rep("n", 12), "object/path", "aad")
  t.falsy(sealed)
  t.equal(err, "invalid nonce length")
end)

t.test("open rejects a key that isn't exactly KEY_BYTES", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path", "aad"))
  local plaintext, err = sodium.open(string.rep("k", 16), nonce("n"), sealed, "aad")
  t.falsy(plaintext)
  t.equal(err, "invalid key length")
end)

t.test("seal without an aad matches open without an aad", function()
  local sealed = t.truthy(sodium.seal(key("k"), nonce("n"), "object/path"))
  t.equal(sodium.open(key("k"), nonce("n"), sealed), "object/path")
end)

t.test("different nonces for the same key produce different ciphertexts", function()
  local first = t.truthy(sodium.seal(key("k"), nonce("1"), "object/path", "aad"))
  local second = t.truthy(sodium.seal(key("k"), nonce("2"), "object/path", "aad"))
  t.falsy(first == second)
end)
