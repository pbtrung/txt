local codec = require("txt.codec")
local config = require("txt.config")
local owner_auth = require("txt.owner_auth")
local owner_proof = require("txt.owner_proof")
local owner_store = require("txt.owner_store")
local request = require("txt.request")
local response = require("txt.response")
local shares = require("txt.shares")

if not request.require_method("POST") then
  return response.preflight("POST")
end
local uid = owner_auth.require_owner()
local body = request.json(2048)
local input = body and shares.parse_create(body)
if not input then
  return response.error(400, "malformed_share")
end

local owner, err = owner_store.load()
if not owner then
  ngx.log(ngx.ERR, "owner lookup failed during share registration: ", err)
  return response.error(503, "owner_store_unavailable")
end
if owner.firebase_uid ~= uid or owner.firebase_uid ~= config.get().owner_uid then
  return response.error(503, "owner_configuration_mismatch")
end
local submitted_binding = owner_proof.path_binding(input.db_path, input.db_prefix)
if
  not submitted_binding or not codec.equal(submitted_binding, owner.db_binding_hash)
then
  return response.error(403, "path_not_authorized")
end

local registered
registered, err = shares.register(input)
if not registered then
  if err == "share_conflict" or (err and err:match("UNIQUE constraint")) then
    return response.error(409, "share_conflict")
  end
  ngx.log(ngx.ERR, "share registration failed: ", err)
  return response.error(503, "share_registry_unavailable")
end
return response.json(201, { registered = true })
