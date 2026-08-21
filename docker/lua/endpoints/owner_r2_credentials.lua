local config = require("txt.config")
local credentials = require("txt.owner_r2_credentials")
local owner_proof = require("txt.owner_proof")
local rate_limit = require("txt.rate_limit")
local request = require("txt.request")
local response = require("txt.response")
local ticket = require("txt.owner_ticket")

if not request.require_method("POST") then
  return response.preflight("POST")
end

local body = request.json(12288)
if not body then
  return response.error(400, "malformed_proof")
end
local proof = owner_proof.parse(body)
if not proof then
  return response.error(400, "malformed_proof")
end

local verified = ticket.verify(proof.ticket)
if not verified then
  return response.error(401, "invalid_or_expired_ticket")
end
if not owner_proof.verify(verified, proof) then
  return response.error(403, "proof_not_authorized")
end

local allowed, limit_err = rate_limit.allow("owner-r2-token", verified.sub)
if allowed == nil then
  ngx.log(ngx.ERR, "R2 credential rate limit failed: ", limit_err)
  return response.error(503, "rate_limit_unavailable")
end
if not allowed then
  return response.error(429, "rate_limit_exceeded")
end

local minted, err = credentials.mint(proof.db_path, proof.db_prefix)
if not minted then
  ngx.log(ngx.ERR, "R2 credential signing failed: ", err)
  return response.error(503, "r2_signing_unavailable")
end

local settings = config.get()
return response.json(200, {
  credentials = minted,
  endpoint = settings.r2_endpoint,
  bucket = settings.r2_bucket,
  region = settings.r2_region,
})
