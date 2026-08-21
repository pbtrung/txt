local owner_auth = require("txt.owner_auth")
local rate_limit = require("txt.rate_limit")
local request = require("txt.request")
local response = require("txt.response")
local shares = require("txt.shares")

if not request.require_method("DELETE") then
  return response.preflight("DELETE")
end
local uid = owner_auth.require_owner()

local allowed, limit_err = rate_limit.allow("owner-share-write", uid)
if allowed == nil then
  ngx.log(ngx.ERR, "owner share rate limit failed: ", limit_err)
  return response.error(503, "rate_limit_unavailable")
end
if not allowed then
  return response.error(429, "rate_limit_exceeded")
end

local body = request.json(2048)
local input = body and shares.parse_create(body)
if not input then
  return response.error(400, "malformed_share")
end

local authorized, code, detail =
  shares.authorize_owner_path(uid, input.db_path, input.db_prefix)
if not authorized then
  if code == "path_not_authorized" then
    return response.error(403, code)
  end
  ngx.log(ngx.ERR, "share authorization failed: ", detail or code)
  return response.error(503, code)
end

local deleted, err = shares.delete(input.id, input.object_path)
if not deleted then
  ngx.log(ngx.ERR, "share deletion failed: ", err)
  return response.error(503, "share_deletion_unavailable")
end
return response.empty(204)
