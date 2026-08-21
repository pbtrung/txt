local aws = require("txt.aws_sigv4")
local codec = require("txt.codec")
local owner_proof = require("txt.owner_proof")
local rqlite = require("txt.rqlite")

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
    object_path = body.db_prefix
      .. "/shared/"
      .. body.share_prefix
      .. "/"
      .. body.share_path,
  }
end

function M.parse_id(body)
  return type(body) == "table" and share_id(body.share_id) or nil
end

function M.register(input)
  local now = math.floor(ngx.now() * 1000)
  local params = {
    share_id_hash = bytes(share_hash(input.id)),
    object_path = input.object_path,
    now = now,
  }
  local results, err = rqlite.request({
    {
      [[
INSERT OR IGNORE INTO shares (share_id_hash, object_path, state, created_at, updated_at)
VALUES (:share_id_hash, :object_path, 'active', :now, :now)
]],
      params,
    },
    {
      [[
SELECT object_path, state FROM shares WHERE share_id_hash = :share_id_hash
]],
      params,
    },
  })
  if not results then
    return nil, err
  end
  local row = rqlite.first_row(results[2])
  if not row or row.object_path ~= input.object_path or row.state ~= "active" then
    return nil, "share_conflict"
  end
  return true
end

function M.active_object(id)
  local result, err = rqlite.query(
    "SELECT object_path FROM shares "
      .. "WHERE share_id_hash = :share_id_hash AND state = 'active'",
    { share_id_hash = bytes(share_hash(id)) }
  )
  if not result then
    return nil, err
  end
  local row = rqlite.first_row(result)
  return row and row.object_path or false
end

function M.mark_deleting(id)
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
      "SELECT object_path, state FROM shares WHERE share_id_hash = :share_id_hash",
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
  if row.state ~= "deleting" then
    return nil, "invalid share state"
  end
  return row.object_path
end

function M.delete(id)
  local object_path, err = M.mark_deleting(id)
  if object_path == false then
    return true
  end
  if not object_path then
    return nil, err
  end
  local removed
  removed, err = aws.delete(object_path)
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
