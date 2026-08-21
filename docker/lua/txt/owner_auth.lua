local codec = require("txt.codec")
local config = require("txt.config")
local firebase = require("txt.firebase_id_token")
local request = require("txt.request")
local response = require("txt.response")

local M = {}

function M.require_owner()
  local token = request.bearer()
  if not token then
    return response.error(401, "invalid_firebase_token")
  end
  local identity, err = firebase.verify(token)
  if not identity then
    ngx.log(ngx.WARN, "Firebase verification failed: ", err)
    return response.error(401, "invalid_firebase_token")
  end
  if not codec.equal(identity.sub, config.get().owner_uid) then
    return response.error(403, "owner_only")
  end
  return identity.sub
end

return M
