local owner_auth = require("txt.owner_auth")
local request = require("txt.request")
local response = require("txt.response")
local shares = require("txt.shares")

if not request.require_method("DELETE") then
  return response.preflight("DELETE")
end
owner_auth.require_owner()
local body = request.json(512)
local id = body and shares.parse_id(body)
if not id then
  return response.error(400, "malformed_share")
end

local deleted, err = shares.delete(id)
if not deleted then
  ngx.log(ngx.ERR, "share deletion failed: ", err)
  return response.error(503, "share_deletion_unavailable")
end
return response.empty(204)
