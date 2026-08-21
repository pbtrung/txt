local codec = require("txt.codec")
local config = require("txt.config")
local owner_auth = require("txt.owner_auth")
local owner_store = require("txt.owner_store")
local rate_limit = require("txt.rate_limit")
local request = require("txt.request")
local response = require("txt.response")
local ticket = require("txt.owner_ticket")

if not request.require_method("POST") then
  return response.preflight("POST")
end

local uid = owner_auth.require_owner()
local allowed, limit_err = rate_limit.allow("owner-keys", uid)
if allowed == nil then
  ngx.log(ngx.ERR, "owner keys rate limit failed: ", limit_err)
  return response.error(503, "rate_limit_unavailable")
end
if not allowed then
  return response.error(429, "rate_limit_exceeded")
end

local owner, err = owner_store.load()
if not owner then
  ngx.log(ngx.ERR, "owner lookup failed: ", err)
  return response.error(503, "owner_store_unavailable")
end
if owner.firebase_uid ~= uid or owner.firebase_uid ~= config.get().owner_uid then
  return response.error(503, "owner_configuration_mismatch")
end

local signed_ticket
signed_ticket, err = ticket.issue(owner)
if not signed_ticket then
  ngx.log(ngx.ERR, "owner ticket signing failed: ", err)
  return response.error(503, "ticket_signing_unavailable")
end

return response.json(200, {
  uid = uid,
  umk = codec.base64_encode(owner.wrapped_umk),
  signing = {
    version = owner.sign_version,
    algorithm = owner.sign_algorithm,
    private_key = codec.base64_encode(owner.wrapped_sign_private_key),
  },
  credentials = codec.base64_encode(owner.encrypted_credentials),
  r2_ticket = signed_ticket,
})
