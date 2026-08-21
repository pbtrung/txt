local aws = require("txt.aws_sigv4")
local config = require("txt.config")
local rate_limit = require("txt.rate_limit")
local request = require("txt.request")
local response = require("txt.response")
local shares = require("txt.shares")

if not request.require_method("POST") then
  return response.preflight("POST")
end
local body = request.json(512)
local id, object_path
if body then
  id, object_path = shares.parse_object_request(body)
end
if not id then
  return response.error(400, "malformed_share")
end

local allowed, limit_err =
  rate_limit.allow("public-share-url", request.client_address())
if allowed == nil then
  ngx.log(ngx.ERR, "public share rate limit failed: ", limit_err)
  return response.error(503, "rate_limit_unavailable")
end
if not allowed then
  return response.error(429, "rate_limit_exceeded")
end

local active, err = shares.active_object(id, object_path)
if active == nil then
  ngx.log(ngx.ERR, "share lookup failed: ", err)
  return response.error(503, "share_registry_unavailable")
end
if not active then
  return response.error(404, "share_not_found")
end

local ttl = config.get().share_url_ttl
local url = aws.presigned_get(object_path, ttl)
return response.json(200, { url = url, expires_at = ngx.time() + ttl })
