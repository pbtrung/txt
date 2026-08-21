local codec = require("txt.codec")
local config = require("txt.config")
local http = require("resty.http")
local x509 = require("resty.openssl.x509")

local M = {}
local CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/"
  .. "securetoken@system.gserviceaccount.com"

local function decode_part(value)
  local raw, err = codec.base64url_decode(value)
  if not raw then
    return nil, err
  end
  local decoded = codec.parse_json(raw)
  if type(decoded) ~= "table" then
    return nil, "invalid JWT JSON"
  end
  return decoded
end

local function max_age(value)
  return tonumber(type(value) == "string" and value:match("max%-age=(%d+)") or nil)
    or 300
end

local function fetch_certs()
  local client = http.new()
  client:set_timeouts(1000, 3000, 3000)
  local result, err =
    client:request_uri(CERTS_URL, { ssl_verify = true, keepalive = true })
  if not result then
    return nil, err
  end
  if result.status ~= 200 then
    return nil, "Firebase cert HTTP " .. result.status
  end
  local certs = codec.parse_json(result.body)
  if type(certs) ~= "table" then
    return nil, "malformed Firebase cert response"
  end
  local ttl = math.max(60, math.min(max_age(result.headers["Cache-Control"]), 86400))
  ngx.shared.firebase_certs:set("certs", result.body, ttl)
  return certs
end

local function certs()
  local cached = ngx.shared.firebase_certs:get("certs")
  if cached then
    local decoded = codec.parse_json(cached)
    if decoded then
      return decoded
    end
  end
  return fetch_certs()
end

local function verify_signature(kid, signing_input, signature)
  local available, err = certs()
  if not available then
    return false, err
  end
  local pem = available[kid]
  if type(pem) ~= "string" then
    return false, "unknown Firebase signing key"
  end
  local certificate
  certificate, err = x509.new(pem)
  if not certificate then
    return false, err
  end
  local public_key
  public_key, err = certificate:get_pubkey()
  if not public_key then
    return false, err
  end
  return public_key:verify(signature, signing_input, "sha256")
end

local function valid_claims(payload)
  local now = ngx.time()
  local project = config.get().firebase_project_id
  return type(payload.exp) == "number"
    and payload.exp > now
    and type(payload.iat) == "number"
    and payload.iat <= now
    and type(payload.auth_time) == "number"
    and payload.auth_time <= now
    and payload.aud == project
    and payload.iss == "https://securetoken.google.com/" .. project
    and type(payload.sub) == "string"
    and #payload.sub > 0
    and #payload.sub <= 128
end

function M.verify(token)
  if type(token) ~= "string" or #token > 16384 then
    return nil, "invalid token"
  end
  local header_part, payload_part, signature_part =
    token:match("^([^.]+)%.([^.]+)%.([^.]+)$")
  if not header_part then
    return nil, "malformed token"
  end
  local header, header_err = decode_part(header_part)
  local payload, payload_err = decode_part(payload_part)
  local signature, signature_err = codec.base64url_decode(signature_part)
  if not header or not payload or not signature then
    return nil, header_err or payload_err or signature_err
  end
  if header.alg ~= "RS256" or type(header.kid) ~= "string" or header.kid == "" then
    return nil, "invalid Firebase JWT header"
  end
  local verified, err =
    verify_signature(header.kid, header_part .. "." .. payload_part, signature)
  if not verified then
    return nil, err or "invalid Firebase signature"
  end
  if not valid_claims(payload) then
    return nil, "invalid Firebase claims"
  end
  return payload
end

return M
