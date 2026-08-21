local ffi = require("ffi")

ffi.cdef([[
int sodium_init(void);
int crypto_aead_xchacha20poly1305_ietf_encrypt(
    unsigned char *c, unsigned long long *clen_p,
    const unsigned char *m, unsigned long long mlen,
    const unsigned char *ad, unsigned long long adlen,
    const unsigned char *nsec, const unsigned char *npub,
    const unsigned char *k);
int crypto_aead_xchacha20poly1305_ietf_decrypt(
    unsigned char *m, unsigned long long *mlen_p,
    unsigned char *nsec,
    const unsigned char *c, unsigned long long clen,
    const unsigned char *ad, unsigned long long adlen,
    const unsigned char *npub, const unsigned char *k);
]])

local sodium = ffi.load("sodium")
assert(sodium.sodium_init() >= 0, "libsodium failed to initialize")

local M = {}

M.KEY_BYTES = 32
M.NONCE_BYTES = 24
M.TAG_BYTES = 16

-- libsodium trusts the caller on key/nonce length: a short buffer is read
-- past its end instead of rejected, so these lengths must be checked here
-- rather than left to the C call.
function M.seal(key, nonce, plaintext, aad)
  if #key ~= M.KEY_BYTES then
    return nil, "invalid key length"
  end
  if #nonce ~= M.NONCE_BYTES then
    return nil, "invalid nonce length"
  end
  local sealed = ffi.new("unsigned char[?]", #plaintext + M.TAG_BYTES)
  local sealed_len = ffi.new("unsigned long long[1]")
  local ad = aad or ""
  local rc = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sealed,
    sealed_len,
    plaintext,
    #plaintext,
    ad,
    #ad,
    nil,
    nonce,
    key
  )
  if rc ~= 0 then
    return nil, "encryption failed"
  end
  return ffi.string(sealed, tonumber(sealed_len[0]))
end

function M.open(key, nonce, sealed, aad)
  if #key ~= M.KEY_BYTES then
    return nil, "invalid key length"
  end
  if #nonce ~= M.NONCE_BYTES then
    return nil, "invalid nonce length"
  end
  if #sealed < M.TAG_BYTES then
    return nil, "ciphertext too short"
  end
  local plaintext = ffi.new("unsigned char[?]", #sealed - M.TAG_BYTES)
  local plaintext_len = ffi.new("unsigned long long[1]")
  local ad = aad or ""
  local rc = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    plaintext,
    plaintext_len,
    nil,
    sealed,
    #sealed,
    ad,
    #ad,
    nonce,
    key
  )
  if rc ~= 0 then
    return nil, "decryption failed"
  end
  return ffi.string(plaintext, tonumber(plaintext_len[0]))
end

return M
