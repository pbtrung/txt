local codec = require("txt.codec")

local M = {}
local cached

local REQUIRED = {
  "OWNER_FIREBASE_UID",
  "FIREBASE_PROJECT_ID",
  "UI_ORIGIN",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_REGION",
  "R2_READ_WRITE_ACCESS_KEY_ID",
  "R2_READ_WRITE_SECRET_ACCESS_KEY",
  "R2_TICKET_SECRET",
  "RATE_LIMIT_KEY",
  "SHARE_GRANT_KEY",
}

local function required(name)
  local value = os.getenv(name)
  if not value or value == "" then
    error(name .. " is required")
  end
  return value
end

local function secret(name, minimum)
  local encoded = required(name)
  local value, err = codec.base64_decode(encoded)
  if not value or #value < minimum then
    error(
      name
        .. " must be canonical padded base64 containing at least "
        .. minimum
        .. " bytes: "
        .. tostring(err)
    )
  end
  return value
end

local function load()
  for _, name in ipairs(REQUIRED) do
    required(name)
  end
  local endpoint = required("R2_ENDPOINT"):gsub("/+$", "")
  local scheme, host = endpoint:match("^(https)://([^/]+)$")
  if not scheme then
    error("R2_ENDPOINT must be an HTTPS origin without a path")
  end
  local ttl = tonumber(os.getenv("SHARE_URL_TTL_SECONDS") or "60")
  if not ttl or ttl % 1 ~= 0 or ttl < 1 or ttl > 900 then
    error("SHARE_URL_TTL_SECONDS must be an integer from 1 to 900")
  end
  return {
    owner_uid = required("OWNER_FIREBASE_UID"),
    firebase_project_id = required("FIREBASE_PROJECT_ID"),
    ui_origin = required("UI_ORIGIN"):gsub("/+$", ""),
    rqlite_url = "http://127.0.0.1:14001",
    r2_endpoint = endpoint,
    r2_host = host,
    r2_bucket = required("R2_BUCKET"),
    r2_region = required("R2_REGION"),
    r2_access_key_id = required("R2_READ_WRITE_ACCESS_KEY_ID"),
    r2_secret_access_key = required("R2_READ_WRITE_SECRET_ACCESS_KEY"),
    r2_ticket_secret = secret("R2_TICKET_SECRET", 32),
    rate_limit_key = secret("RATE_LIMIT_KEY", 32),
    share_grant_key = secret("SHARE_GRANT_KEY", 32),
    share_url_ttl = ttl,
  }
end

function M.get()
  if not cached then
    cached = load()
  end
  return cached
end

function M.validate()
  M.get()
end

return M
