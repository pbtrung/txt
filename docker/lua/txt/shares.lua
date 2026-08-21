local aws = require("txt.aws_sigv4")
local codec = require("txt.codec")
local config = require("txt.config")
local owner_proof = require("txt.owner_proof")
local owner_store = require("txt.owner_store")
local rqlite = require("txt.rqlite")
local share_grant = require("txt.share_grant")

local M = {}

local function share_id(value)
  local decoded = codec.base64url_decode(value)
  return decoded and #decoded == 32 and decoded or nil
end

local function share_hash(value)
  return codec.digest("sha256", value)
end

local function bytes(value)
  return codec.bytes_to_array(value)
end

local function object_path(db_prefix, share_prefix, share_path)
  return db_prefix .. "/shared/" .. share_prefix .. "/" .. share_path
end

local function matches_hash(row, path)
  if not row then
    return false
  end
  local stored = codec.array_to_bytes(row.object_path_hash)
  return stored ~= nil and codec.equal(stored, share_hash(path))
end

function M.parse_create(body)
  local id = share_id(body.share_id)
  if
    not id
    or not owner_proof.valid_path(body.db_path)
    or not owner_proof.valid_path(body.db_prefix)
    or not owner_proof.valid_path(body.share_prefix)
    or not owner_proof.valid_path(body.share_path)
  then
    return nil
  end
  return {
    id = id,
    db_path = body.db_path,
    db_prefix = body.db_prefix,
    object_path = object_path(body.db_prefix, body.share_prefix, body.share_path),
  }
end

function M.parse_object_request(body)
  local id = share_id(body.share_id)
  if
    not id
    or type(body.grant) ~= "string"
    or #body.grant == 0
    or #body.grant > 512
  then
    return nil
  end
  local path = share_grant.decrypt(share_hash(id), body.grant)
  if not path then
    return nil
  end
  return id, path
end

function M.authorize_owner_path(uid, db_path, db_prefix)
  local owner, err = owner_store.load()
  if not owner then
    return nil, "owner_store_unavailable", err
  end
  if owner.firebase_uid ~= uid or owner.firebase_uid ~= config.get().owner_uid then
    return nil, "owner_configuration_mismatch"
  end
  local submitted_binding = owner_proof.path_binding(db_path, db_prefix)
  if
    not submitted_binding or not codec.equal(submitted_binding, owner.db_binding_hash)
  then
    return nil, "path_not_authorized"
  end
  return true
end

function M.register(input)
  local now = math.floor(ngx.now() * 1000)
  local params = {
    share_id_hash = bytes(share_hash(input.id)),
    object_path_hash = bytes(share_hash(input.object_path)),
    now = now,
  }
  local results, err = rqlite.request({
    {
      [[
INSERT OR IGNORE INTO shares
  (share_id_hash, object_path_hash, state, created_at, updated_at)
VALUES (:share_id_hash, :object_path_hash, 'active', :now, :now)
]],
      params,
    },
    {
      [[
SELECT object_path_hash, state FROM shares WHERE share_id_hash = :share_id_hash
]],
      params,
    },
  })
  if not results then
    return nil, err
  end
  local row = rqlite.first_row(results[2])
  if not matches_hash(row, input.object_path) or row.state ~= "active" then
    return nil, "share_conflict"
  end
  return share_grant.encrypt(share_hash(input.id), input.object_path)
end

function M.active_object(id, path)
  local result, err = rqlite.query(
    "SELECT object_path_hash FROM shares "
      .. "WHERE share_id_hash = :share_id_hash AND state = 'active'",
    { share_id_hash = bytes(share_hash(id)) }
  )
  if not result then
    return nil, err
  end
  return matches_hash(rqlite.first_row(result), path)
end

function M.mark_deleting(id, path)
  local params = {
    share_id_hash = bytes(share_hash(id)),
    now = math.floor(ngx.now() * 1000),
  }
  local results, err = rqlite.request({
    {
      [[
UPDATE shares SET state = 'deleting', updated_at = :now
WHERE share_id_hash = :share_id_hash AND state = 'active'
]],
      params,
    },
    {
      "SELECT object_path_hash, state FROM shares WHERE share_id_hash = :share_id_hash",
      params,
    },
  })
  if not results then
    return nil, err
  end
  local row = rqlite.first_row(results[2])
  if not row then
    return false
  end
  if not matches_hash(row, path) then
    return nil, "object path mismatch"
  end
  if row.state ~= "deleting" then
    return nil, "invalid share state"
  end
  return true
end

function M.delete(id, path)
  local marked, err = M.mark_deleting(id, path)
  if marked == false then
    return true
  end
  if not marked then
    return nil, err
  end
  local removed
  removed, err = aws.delete(path)
  if not removed then
    return nil, err
  end
  local result
  result, err = rqlite.execute(
    "DELETE FROM shares WHERE share_id_hash = :share_id_hash AND state = 'deleting'",
    { share_id_hash = bytes(share_hash(id)) }
  )
  if not result then
    return nil, err
  end
  return true
end

return M
