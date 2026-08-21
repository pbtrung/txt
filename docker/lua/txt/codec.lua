local cjson = require("cjson.safe")
local digest = require("resty.openssl.digest")
local hmac = require("resty.openssl.hmac")
local rand = require("resty.openssl.rand")

local M = {}

local function padding(value)
  return string.rep("=", (4 - (#value % 4)) % 4)
end

function M.base64_decode(value)
  if type(value) ~= "string" or not value:match("^[A-Za-z0-9+/]*={0,2}$") then
    return nil, "invalid base64"
  end
  local raw = ngx.decode_base64(value .. padding(value))
  if not raw or ngx.encode_base64(raw) ~= value then
    return nil, "non-canonical base64"
  end
  return raw
end

function M.base64_encode(value)
  return ngx.encode_base64(value)
end

function M.base64url_decode(value)
  if type(value) ~= "string" or not value:match("^[A-Za-z0-9_-]*$") then
    return nil, "invalid base64url"
  end
  local standard = value:gsub("-", "+"):gsub("_", "/")
  local raw = ngx.decode_base64(standard .. padding(standard))
  if not raw or M.base64url_encode(raw) ~= value then
    return nil, "non-canonical base64url"
  end
  return raw
end

function M.base64url_encode(value)
  return ngx.encode_base64(value):gsub("=+$", ""):gsub("%+", "-"):gsub("/", "_")
end

function M.digest(algorithm, value)
  local context, err = digest.new(algorithm)
  if not context then
    return nil, err
  end
  local ok
  ok, err = context:update(value)
  if not ok then
    return nil, err
  end
  return context:final()
end

function M.hmac(algorithm, key, value)
  local context, err = hmac.new(key, algorithm)
  if not context then
    return nil, err
  end
  local ok
  ok, err = context:update(value)
  if not ok then
    return nil, err
  end
  return context:final()
end

function M.hex(value)
  return (
    value:gsub(".", function(byte)
      return string.format("%02x", string.byte(byte))
    end)
  )
end

function M.random(length)
  return rand.bytes(length, true)
end

function M.equal(left, right)
  if type(left) ~= "string" or type(right) ~= "string" or #left ~= #right then
    return false
  end
  local difference = 0
  for index = 1, #left do
    difference = bit.bor(difference, bit.bxor(left:byte(index), right:byte(index)))
  end
  return difference == 0
end

function M.bytes_to_array(value)
  local result = {}
  for index = 1, #value do
    result[index] = value:byte(index)
  end
  return result
end

function M.array_to_bytes(value)
  if type(value) ~= "table" then
    return nil, "expected byte array"
  end
  local chunks = {}
  for index = 1, #value do
    local byte = value[index]
    if type(byte) ~= "number" or byte < 0 or byte > 255 or byte % 1 ~= 0 then
      return nil, "invalid byte array"
    end
    chunks[index] = string.char(byte)
  end
  return table.concat(chunks)
end

function M.json(value)
  return cjson.encode(value)
end

function M.parse_json(value)
  return cjson.decode(value)
end

local function integer_bytes(value, length)
  local bytes = {}
  for index = length, 1, -1 do
    bytes[index] = string.char(value % 256)
    value = math.floor(value / 256)
  end
  return table.concat(bytes)
end

function M.u32be(value)
  return integer_bytes(value, 4)
end

function M.u64be(value)
  return integer_bytes(value, 8)
end

function M.percent_encode(value, preserve_slash)
  return (
    value:gsub(".", function(character)
      if
        character:match("[A-Za-z0-9_.~-]") or (preserve_slash and character == "/")
      then
        return character
      end
      return string.format("%%%02X", character:byte())
    end)
  )
end

return M
