local codec = require("txt.codec")
local config = require("txt.config")
local jwt = require("txt.jwt")

local M = {}
local TTL = 15 * 60

local function mint(credential_type, scope, paths)
  local settings = config.get()
  local now = ngx.time()
  local account_id = settings.r2_host:match("^([^.]+)")
  local token, err = jwt.sign_hs256({
    bucket = settings.r2_bucket,
    scope = scope,
    paths = paths,
    sub = account_id,
    iss = settings.r2_access_key_id,
    aud = settings.r2_host,
    iat = now,
    exp = now + TTL,
  }, settings.r2_secret_access_key)
  if not token then
    return nil, err
  end
  local secret = codec.digest("sha256", token)
  return {
    type = credential_type,
    access_key_id = settings.r2_access_key_id,
    secret_access_key = codec.hex(secret),
    session_token = codec.base64url_encode("jwt/" .. token),
    expiration = os.date("!%Y-%m-%dT%H:%M:%SZ", now + TTL),
  }
end

function M.mint(db_path, db_prefix)
  local exact, err = mint("db_path", "object-read-write", {
    objectPaths = { db_path },
    prefixPaths = {},
  })
  if not exact then
    return nil, err
  end
  local prefix
  prefix, err = mint("db_prefix", "object-read-write", {
    objectPaths = {},
    prefixPaths = { db_prefix .. "/" },
  })
  if not prefix then
    return nil, err
  end
  return { exact, prefix }
end

return M
