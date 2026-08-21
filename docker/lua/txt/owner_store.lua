local codec = require("txt.codec")
local rqlite = require("txt.rqlite")

local M = {}

local OWNER_SQL = [[
SELECT firebase_uid, user_handle_hash, db_binding_hash, wrapped_umk,
       sign_version, sign_algorithm, sign_public_key,
       wrapped_sign_private_key, encrypted_credentials
FROM owner_control
WHERE singleton = 1
]]

local BLOB_FIELDS = {
  "user_handle_hash",
  "db_binding_hash",
  "wrapped_umk",
  "sign_public_key",
  "wrapped_sign_private_key",
  "encrypted_credentials",
}

function M.load()
  local result, err = rqlite.query(OWNER_SQL)
  if not result then
    return nil, err
  end
  local owner = rqlite.first_row(result)
  if not owner then
    return nil, "owner is not provisioned"
  end
  for _, field in ipairs(BLOB_FIELDS) do
    local value
    value, err = codec.array_to_bytes(owner[field])
    if not value then
      return nil, field .. ": " .. err
    end
    owner[field] = value
  end
  return owner
end

return M
