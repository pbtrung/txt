local t = require("tests.testlib")

-- A fold over every byte, standing in for a real HMAC: deterministic, and
-- differs whenever the secret or message differs. Never contains "." so it
-- can safely sit in the token's third dot-separated segment.
local function fake_digest(value)
  local sum = 0
  for index = 1, #value do
    sum = (sum * 31 + value:byte(index)) % 2147483647
  end
  return tostring(sum)
end

local function fake_json_encode(value)
  local parts = {}
  for key, field in pairs(value) do
    parts[#parts + 1] = tostring(key) .. "=" .. tostring(field)
  end
  table.sort(parts)
  return table.concat(parts, "&")
end

local function fake_json_decode(value)
  local decoded = {}
  for pair in value:gmatch("[^&]+") do
    local key, field = pair:match("^([^=]+)=(.*)$")
    decoded[key] = field
  end
  return decoded
end

local function stubs()
  return {
    ["txt.codec"] = {
      base64url_encode = function(value)
        return value
      end,
      base64url_decode = function(value)
        return value
      end,
      json = fake_json_encode,
      parse_json = fake_json_decode,
      hmac = function(_, secret, message)
        return fake_digest(secret .. "\0" .. message)
      end,
      equal = function(left, right)
        return left == right
      end,
    },
  }
end

t.test("a token signed with one secret verifies and round-trips its payload", function()
  t.with_stubs("txt.jwt", stubs(), function(jwt)
    local token = t.truthy(jwt.sign_hs256({ sub = "owner", v = "2" }, "secret"))
    local payload = t.truthy(jwt.verify_hs256(token, "secret"))
    t.equal(payload.sub, "owner")
    t.equal(payload.v, "2")
  end)
end)

t.test("verification fails under a different secret", function()
  t.with_stubs("txt.jwt", stubs(), function(jwt)
    local token = t.truthy(jwt.sign_hs256({ sub = "owner" }, "secret"))
    t.falsy(jwt.verify_hs256(token, "wrong-secret"))
  end)
end)

t.test("a tampered payload segment fails signature verification", function()
  t.with_stubs("txt.jwt", stubs(), function(jwt)
    local token = t.truthy(jwt.sign_hs256({ sub = "owner" }, "secret"))
    local header, payload, signature = token:match("^([^.]+)%.([^.]+)%.([^.]+)$")
    local tampered = header .. "." .. payload .. "-tampered" .. "." .. signature
    t.falsy(jwt.verify_hs256(tampered, "secret"))
  end)
end)

t.test("a non-HS256 header is rejected even with a valid signature", function()
  t.with_stubs("txt.jwt", stubs(), function(jwt)
    local codec = stubs()["txt.codec"]
    local header = fake_json_encode({ alg = "RS256", typ = "JWT" })
    local body = fake_json_encode({ sub = "owner" })
    local input = header .. "." .. body
    local signature = codec.hmac("sha256", "secret", input)
    t.falsy(jwt.verify_hs256(input .. "." .. signature, "secret"))
  end)
end)

t.test("a malformed token shape is rejected", function()
  t.with_stubs("txt.jwt", stubs(), function(jwt)
    t.falsy(jwt.verify_hs256("not-a-jwt", "secret"))
    t.falsy(jwt.verify_hs256("only.two", "secret"))
  end)
end)
