local codec = require("txt.codec")

local M = {}

function M.sign_hs256(payload, secret)
  local header = codec.base64url_encode(codec.json({ alg = "HS256", typ = "JWT" }))
  local body = codec.base64url_encode(codec.json(payload))
  local input = header .. "." .. body
  local signature, err = codec.hmac("sha256", secret, input)
  if not signature then
    return nil, err
  end
  return input .. "." .. codec.base64url_encode(signature)
end

function M.verify_hs256(token, secret)
  local header_part, payload_part, signature_part =
    token:match("^([^.]+)%.([^.]+)%.([^.]+)$")
  if not header_part then
    return nil, "malformed JWT"
  end
  local header_raw = codec.base64url_decode(header_part)
  local payload_raw = codec.base64url_decode(payload_part)
  local signature = codec.base64url_decode(signature_part)
  if not header_raw or not payload_raw or not signature then
    return nil, "invalid JWT encoding"
  end
  local header = codec.parse_json(header_raw)
  local payload = codec.parse_json(payload_raw)
  if type(header) ~= "table" or header.alg ~= "HS256" or header.typ ~= "JWT" then
    return nil, "invalid JWT header"
  end
  if type(payload) ~= "table" then
    return nil, "invalid JWT payload"
  end
  local expected, err = codec.hmac("sha256", secret, header_part .. "." .. payload_part)
  if not expected or not codec.equal(expected, signature) then
    return nil, err or "invalid JWT signature"
  end
  return payload
end

return M
