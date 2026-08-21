local cipher = require("resty.openssl.cipher")
local codec = require("txt.codec")
local config = require("txt.config")

local M = {}
local ALGORITHM = "chacha20-poly1305"
local VERSION = "\1"
local SALT_BYTES = 32
local NONCE_BYTES = 12
local TAG_BYTES = 16
local KEY_INFO = "txt:share-grant-key:v1"
local AAD_PREFIX = "txt:share-grant:v1"
local ENVELOPE_BYTES = #VERSION + SALT_BYTES + NONCE_BYTES + TAG_BYTES

local function grant_key(salt, id_hash)
  local prk, err = codec.hmac("sha256", salt, config.get().share_grant_key)
  if not prk then
    return nil, err
  end
  return codec.hmac("sha256", prk, KEY_INFO .. id_hash .. "\1")
end

local function seal(key, nonce, plaintext, aad)
  local aead = cipher.new(ALGORITHM)
  local ciphertext, err = aead:encrypt(key, nonce, plaintext, false, aad)
  if not ciphertext then
    return nil, err
  end
  local tag
  tag, err = aead:get_aead_tag(TAG_BYTES)
  if not tag then
    return nil, err
  end
  return ciphertext .. tag
end

local function split_envelope(envelope)
  local salt = envelope:sub(2, 1 + SALT_BYTES)
  local nonce = envelope:sub(2 + SALT_BYTES, 1 + SALT_BYTES + NONCE_BYTES)
  local ciphertext = envelope:sub(2 + SALT_BYTES + NONCE_BYTES, -TAG_BYTES - 1)
  local tag = envelope:sub(-TAG_BYTES)
  return salt, nonce, ciphertext, tag
end

function M.encrypt(id_hash, object_path)
  local salt = codec.random(SALT_BYTES)
  local nonce = codec.random(NONCE_BYTES)
  local key, err = grant_key(salt, id_hash)
  if not key then
    return nil, err
  end
  local sealed
  sealed, err = seal(key, nonce, object_path, AAD_PREFIX .. id_hash)
  if not sealed then
    return nil, err
  end
  return codec.base64url_encode(VERSION .. salt .. nonce .. sealed)
end

function M.decrypt(id_hash, grant)
  local envelope = codec.base64url_decode(grant)
  if not envelope or #envelope <= ENVELOPE_BYTES or envelope:sub(1, 1) ~= VERSION then
    return nil, "malformed grant"
  end
  local salt, nonce, ciphertext, tag = split_envelope(envelope)
  local key, err = grant_key(salt, id_hash)
  if not key then
    return nil, err
  end
  local aead = cipher.new(ALGORITHM)
  return aead:decrypt(key, nonce, ciphertext, false, AAD_PREFIX .. id_hash, tag)
end

return M
