local codec = require("txt.codec")
local config = require("txt.config")
local http = require("resty.http")

local M = {}
local SERVICE = "s3"

local function timestamp(now)
  return os.date("!%Y%m%dT%H%M%SZ", now), os.date("!%Y%m%d", now)
end

local function signing_key(secret, date, region)
  local date_key = codec.hmac("sha256", "AWS4" .. secret, date)
  local region_key = codec.hmac("sha256", date_key, region)
  local service_key = codec.hmac("sha256", region_key, SERVICE)
  return codec.hmac("sha256", service_key, "aws4_request")
end

local function object_uri(object_path)
  local settings = config.get()
  return "/"
    .. codec.percent_encode(settings.r2_bucket, false)
    .. "/"
    .. codec.percent_encode(object_path, true)
end

local function scope(date)
  local settings = config.get()
  return date .. "/" .. settings.r2_region .. "/" .. SERVICE .. "/aws4_request"
end

local function signature(method, uri, query, headers, signed_headers, payload_hash, now)
  local settings = config.get()
  local amz_date, date = timestamp(now)
  local canonical = table.concat({
    method,
    uri,
    query,
    headers,
    "",
    signed_headers,
    payload_hash,
  }, "\n")
  local request_hash = codec.digest("sha256", canonical)
  local to_sign = "AWS4-HMAC-SHA256\n"
    .. amz_date
    .. "\n"
    .. scope(date)
    .. "\n"
    .. codec.hex(request_hash)
  return codec.hex(
    codec.hmac(
      "sha256",
      signing_key(settings.r2_secret_access_key, date, settings.r2_region),
      to_sign
    )
  ),
    amz_date,
    date
end

local function canonical_query(values)
  local keys = {}
  for key in pairs(values) do
    keys[#keys + 1] = key
  end
  table.sort(keys)
  local parts = {}
  for _, key in ipairs(keys) do
    parts[#parts + 1] = codec.percent_encode(key, false)
      .. "="
      .. codec.percent_encode(values[key], false)
  end
  return table.concat(parts, "&")
end

function M.presigned_get(object_path, ttl)
  local settings = config.get()
  local now = ngx.time()
  local amz_date, date = timestamp(now)
  local values = {
    ["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256",
    ["X-Amz-Credential"] = settings.r2_access_key_id .. "/" .. scope(date),
    ["X-Amz-Date"] = amz_date,
    ["X-Amz-Expires"] = tostring(ttl),
    ["X-Amz-SignedHeaders"] = "host",
  }
  local query = canonical_query(values)
  local uri = object_uri(object_path)
  local signed = signature(
    "GET",
    uri,
    query,
    "host:" .. settings.r2_host .. "\n",
    "host",
    "UNSIGNED-PAYLOAD",
    now
  )
  return settings.r2_endpoint .. uri .. "?" .. query .. "&X-Amz-Signature=" .. signed
end

function M.delete(object_path)
  local settings = config.get()
  local now = ngx.time()
  local uri = object_uri(object_path)
  local payload_hash = codec.hex(codec.digest("sha256", ""))
  local amz_date, date = timestamp(now)
  local canonical_headers = "host:"
    .. settings.r2_host
    .. "\n"
    .. "x-amz-content-sha256:"
    .. payload_hash
    .. "\n"
    .. "x-amz-date:"
    .. amz_date
    .. "\n"
  local signed_headers = "host;x-amz-content-sha256;x-amz-date"
  local signed =
    signature("DELETE", uri, "", canonical_headers, signed_headers, payload_hash, now)
  local authorization = "AWS4-HMAC-SHA256 Credential="
    .. settings.r2_access_key_id
    .. "/"
    .. scope(date)
    .. ", SignedHeaders="
    .. signed_headers
    .. ", Signature="
    .. signed
  local client = http.new()
  client:set_timeouts(1000, 5000, 5000)
  local result, err = client:request_uri(settings.r2_endpoint .. uri, {
    method = "DELETE",
    ssl_verify = true,
    headers = {
      ["Authorization"] = authorization,
      ["Host"] = settings.r2_host,
      ["x-amz-content-sha256"] = payload_hash,
      ["x-amz-date"] = amz_date,
    },
    keepalive = true,
  })
  if not result then
    return nil, err
  end
  if result.status == 404 or (result.status >= 200 and result.status < 300) then
    return true
  end
  return nil, "R2 delete HTTP " .. result.status
end

return M
