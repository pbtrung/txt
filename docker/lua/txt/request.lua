local codec = require("txt.codec")
local config = require("txt.config")
local response = require("txt.response")

local M = {}

function M.require_method(expected)
  local method = ngx.req.get_method()
  if method == "OPTIONS" then
    return false
  end
  if method ~= expected then
    response.error(405, "method_not_allowed")
  end
  local origin = ngx.req.get_headers()["Origin"]
  if origin ~= config.get().ui_origin then
    response.error(403, "origin_not_allowed")
  end
  return true
end

function M.json(max_bytes)
  local length = tonumber(ngx.req.get_headers()["Content-Length"])
  if length and length > max_bytes then
    return nil, "body_too_large"
  end
  ngx.req.read_body()
  local body = ngx.req.get_body_data()
  if not body or #body == 0 or #body > max_bytes then
    return nil, "invalid_body"
  end
  local value = codec.parse_json(body)
  if type(value) ~= "table" then
    return nil, "invalid_json"
  end
  return value
end

function M.bearer()
  local authorization = ngx.req.get_headers()["Authorization"]
  if type(authorization) ~= "string" then
    return nil
  end
  return authorization:match("^Bearer%s+([^%s]+)$")
end

function M.client_address()
  -- Not X-Forwarded-For: nginx.conf configures no trusted-proxy chain
  -- (no set_real_ip_from), so that header is entirely client-controlled and
  -- would let anyone roll a fresh rate-limit bucket on every request.
  return ngx.var.remote_addr or "unknown"
end

return M
