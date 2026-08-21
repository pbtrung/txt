local codec = require("txt.codec")
local config = require("txt.config")
local jwt = require("txt.jwt")

local M = {}
local TTL = 24 * 60 * 60

local function valid_binary(value, length)
  local decoded = codec.base64url_decode(value)
  return decoded and (not length or #decoded == length) and decoded or nil
end

function M.issue(owner)
  local now = ngx.time()
  local ticket_id, err = codec.random(32)
  if not ticket_id then
    return nil, err
  end
  return jwt.sign_hs256({
    v = 2,
    aud = "r2-token",
    sub = config.get().owner_uid,
    jti = codec.base64url_encode(ticket_id),
    user_handle_hash = codec.base64url_encode(owner.user_handle_hash),
    sign_version = owner.sign_version,
    sign_algorithm = owner.sign_algorithm,
    sign_public_key = codec.base64url_encode(owner.sign_public_key),
    db_binding_hash = codec.base64url_encode(owner.db_binding_hash),
    iat = now,
    exp = now + TTL,
  }, config.get().r2_ticket_secret)
end

function M.verify(value)
  if type(value) ~= "string" or #value == 0 or #value > 8192 then
    return nil, "invalid ticket"
  end
  local payload, err = jwt.verify_hs256(value, config.get().r2_ticket_secret)
  if not payload then
    return nil, err
  end
  local now = ngx.time()
  if
    payload.v ~= 2
    or payload.aud ~= "r2-token"
    or payload.sub ~= config.get().owner_uid
    or type(payload.iat) ~= "number"
    or type(payload.exp) ~= "number"
    or payload.iat > now
    or payload.exp <= now
    or payload.exp - payload.iat ~= TTL
    or payload.sign_version ~= 1
    or payload.sign_algorithm ~= "ECDSA-P521-SHA512"
    or not valid_binary(payload.jti, 32)
  then
    return nil, "invalid ticket claims"
  end
  payload.user_handle_hash = valid_binary(payload.user_handle_hash, 32)
  payload.db_binding_hash = valid_binary(payload.db_binding_hash, 64)
  payload.sign_public_key = valid_binary(payload.sign_public_key)
  if
    not payload.user_handle_hash
    or not payload.db_binding_hash
    or not payload.sign_public_key
  then
    return nil, "invalid ticket key material"
  end
  return payload
end

return M
