local codec = require("txt.codec")
local pkey = require("resty.openssl.pkey")

local M = {}
local PATH_PATTERN = "^[0-9abcdefghjkmnpqrstvwxyz]+$"

local function path(value)
  return type(value) == "string" and #value == 52 and value:match(PATH_PATTERN) ~= nil
end

local function binding(db_path, db_prefix)
  return codec.digest("sha512", db_path .. db_prefix)
end

local function der_length(length)
  if length < 128 then
    return string.char(length)
  end
  return string.char(0x81, length)
end

local function der_integer(value)
  while #value > 1 and value:byte(1) == 0 do
    value = value:sub(2)
  end
  if value:byte(1) >= 0x80 then
    value = "\0" .. value
  end
  return string.char(0x02, #value) .. value
end

local function raw_signature_to_der(value)
  if #value ~= 132 then
    return nil
  end
  local body = der_integer(value:sub(1, 66)) .. der_integer(value:sub(67, 132))
  return string.char(0x30) .. der_length(#body) .. body
end

local function canonical(input)
  local ticket_hash = codec.digest("sha256", input.ticket)
  local path_hash = binding(input.db_path, input.db_prefix)
  if not ticket_hash or not path_hash then
    return nil
  end
  return "txt:r2-ticket-proof\0"
    .. codec.u32be(input.version)
    .. ticket_hash
    .. input.user_handle
    .. codec.u64be(input.expires_at)
    .. input.request_id
    .. path_hash
end

function M.parse(body)
  if
    type(body.ticket) ~= "string"
    or not path(body.db_path)
    or not path(body.db_prefix)
  then
    return nil
  end
  if type(body.proof) ~= "table" or type(body.user_handle) ~= "string" then
    return nil
  end
  local user_handle = codec.base64_decode(body.user_handle)
  local request_id = codec.base64_decode(body.proof.request_id)
  local signature = codec.base64_decode(body.proof.signature)
  local version = body.proof.version
  local expires_at = body.proof.expires_at
  local now = ngx.time()
  if
    not user_handle
    or #user_handle ~= 32
    or not request_id
    or #request_id ~= 32
    or not signature
    or #signature ~= 132
    or version ~= 2
    or type(expires_at) ~= "number"
    or expires_at % 1 ~= 0
    or expires_at <= now
    or expires_at > now + 60
  then
    return nil
  end
  return {
    ticket = body.ticket,
    user_handle = user_handle,
    db_path = body.db_path,
    db_prefix = body.db_prefix,
    version = version,
    expires_at = expires_at,
    request_id = request_id,
    signature = signature,
  }
end

function M.verify(ticket, proof)
  local handle_hash = codec.digest("sha256", proof.user_handle)
  local path_hash = binding(proof.db_path, proof.db_prefix)
  if
    not handle_hash
    or not path_hash
    or not codec.equal(handle_hash, ticket.user_handle_hash)
    or not codec.equal(path_hash, ticket.db_binding_hash)
  then
    return false
  end
  local key = pkey.new(ticket.sign_public_key, { format = "DER", type = "pu" })
  local signature = raw_signature_to_der(proof.signature)
  local message = canonical(proof)
  if not key or not signature or not message then
    return false
  end
  return key:verify(signature, message, "sha512") == true
end

function M.path_binding(db_path, db_prefix)
  if not path(db_path) or not path(db_prefix) then
    return nil
  end
  return binding(db_path, db_prefix)
end

function M.valid_path(value)
  return path(value)
end

return M
