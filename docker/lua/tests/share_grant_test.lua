local t = require("tests.testlib")

-- A fold over every byte so the fake tag actually depends on the whole
-- key/iv/aad, not just a truncated prefix of their concatenation.
local function fake_digest(value)
  local sum = 0
  for index = 1, #value do
    sum = (sum * 31 + value:byte(index)) % 2147483647
  end
  return tostring(sum)
end

local function fake_tag(key, iv, aad, size)
  return (
    fake_digest(key .. "\0" .. iv .. "\0" .. (aad or "")) .. string.rep("0", size)
  ):sub(1, size)
end

local function fake_aead()
  local state = {}
  return {
    encrypt = function(_, key, iv, s, _, aad)
      state.key, state.iv, state.aad = key, iv, aad
      return s
    end,
    get_aead_tag = function(_, size)
      return fake_tag(state.key, state.iv, state.aad, size)
    end,
    decrypt = function(_, key, iv, s, _, aad, tag)
      if fake_tag(key, iv, aad, #tag) ~= tag then
        return nil, "tag mismatch"
      end
      return s
    end,
  }
end

local function stubs()
  local random_seq = 0
  return {
    ["resty.openssl.cipher"] = {
      new = function()
        return fake_aead()
      end,
    },
    ["txt.codec"] = {
      hmac = function(_, key, value)
        return "hmac(" .. key .. "|" .. value .. ")"
      end,
      random = function(length)
        random_seq = random_seq + 1
        return string.rep(tostring(random_seq % 10), length)
      end,
      base64url_encode = function(value)
        return value
      end,
      base64url_decode = function(value)
        return value
      end,
    },
    ["txt.config"] = {
      get = function()
        return { share_grant_key = "master-key" }
      end,
    },
  }
end

t.test(
  "a grant decrypts back to the exact object path under its own share id",
  function()
    t.with_stubs("txt.share_grant", stubs(), function(share_grant)
      local grant =
        t.truthy(share_grant.encrypt("id-hash-a", "owner/shared/prefix/path"))
      t.equal(share_grant.decrypt("id-hash-a", grant), "owner/shared/prefix/path")
    end)
  end
)

t.test("a grant does not decrypt under a different share id", function()
  t.with_stubs("txt.share_grant", stubs(), function(share_grant)
    local grant = t.truthy(share_grant.encrypt("id-hash-a", "owner/shared/prefix/path"))
    t.falsy(share_grant.decrypt("id-hash-b", grant))
  end)
end)

t.test("a malformed grant is rejected", function()
  t.with_stubs("txt.share_grant", stubs(), function(share_grant)
    t.falsy(share_grant.decrypt("id-hash-a", "short"))
    t.falsy(share_grant.decrypt("id-hash-a", "\2" .. string.rep("x", 60)))
  end)
end)
