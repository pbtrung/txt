local t = require("tests.testlib")

local function codec()
  return {
    base64url_encode = function(value)
      return "encoded:" .. value
    end,
    base64url_decode = function(value)
      return value
    end,
    random = function(length)
      return string.rep("r", length)
    end,
    equal = function(left, right)
      return left == right
    end,
  }
end

t.test("owner ticket contains no role or account type", function()
  local captured
  local jwt = {
    sign_hs256 = function(payload)
      captured = payload
      return "ticket"
    end,
  }
  local old_ngx = ngx
  ngx = {
    time = function()
      return 1000
    end,
  }
  t.with_stubs("txt.owner_ticket", {
    ["txt.codec"] = codec(),
    ["txt.config"] = {
      get = function()
        return { owner_uid = "owner", r2_ticket_secret = "secret" }
      end,
    },
    ["txt.jwt"] = jwt,
  }, function(ticket)
    local value = ticket.issue({
      user_handle_hash = string.rep("h", 32),
      sign_version = 1,
      sign_algorithm = "ECDSA-P521-SHA512",
      sign_public_key = "public",
      db_binding_hash = string.rep("b", 64),
    })
    t.equal(value, "ticket")
    t.equal(captured.sub, "owner")
    t.equal(captured.exp - captured.iat, 86400)
    t.equal(captured.role, nil)
    t.equal(captured.account_type, nil)
  end)
  ngx = old_ngx
end)

t.test("owner ticket rejects every other Firebase subject", function()
  local jwt = {
    verify_hs256 = function()
      return {
        v = 2,
        aud = "r2-token",
        sub = "someone-else",
        iat = 1000,
        exp = 87400,
      }
    end,
  }
  local old_ngx = ngx
  ngx = {
    time = function()
      return 2000
    end,
  }
  t.with_stubs("txt.owner_ticket", {
    ["txt.codec"] = codec(),
    ["txt.config"] = {
      get = function()
        return { owner_uid = "owner", r2_ticket_secret = "secret" }
      end,
    },
    ["txt.jwt"] = jwt,
  }, function(ticket)
    t.falsy(ticket.verify("ticket"))
  end)
  ngx = old_ngx
end)
