local t = require("tests.testlib")

local function stubs(bearer, identity, identity_err, owner_uid)
  return {
    ["txt.codec"] = {
      equal = function(left, right)
        return left == right
      end,
    },
    ["txt.config"] = {
      get = function()
        return { owner_uid = owner_uid or "owner-uid" }
      end,
    },
    ["txt.firebase_id_token"] = {
      verify = function()
        return identity, identity_err
      end,
    },
    ["txt.request"] = {
      bearer = function()
        return bearer
      end,
    },
    ["txt.response"] = {
      error = function(status, code)
        return { status = status, code = code }
      end,
    },
  }
end

local function with_ngx(fn)
  local old_ngx = ngx
  ngx = {
    WARN = "warn",
    ERR = "err",
    log = function() end,
  }
  local ok, err = pcall(fn)
  ngx = old_ngx
  if not ok then
    error(err, 0)
  end
end

t.test("require_owner rejects a missing bearer token", function()
  with_ngx(function()
    t.with_stubs("txt.owner_auth", stubs(nil), function(owner_auth)
      local result = owner_auth.require_owner()
      t.equal(result.status, 401)
      t.equal(result.code, "invalid_firebase_token")
    end)
  end)
end)

t.test("require_owner rejects a token Firebase fails to verify", function()
  with_ngx(function()
    t.with_stubs(
      "txt.owner_auth",
      stubs("a-token", nil, "signature invalid"),
      function(owner_auth)
        local result = owner_auth.require_owner()
        t.equal(result.status, 401)
        t.equal(result.code, "invalid_firebase_token")
      end
    )
  end)
end)

t.test("require_owner rejects a verified identity that isn't the owner", function()
  with_ngx(function()
    t.with_stubs(
      "txt.owner_auth",
      stubs("a-token", { sub = "someone-else" }, nil, "owner-uid"),
      function(owner_auth)
        local result = owner_auth.require_owner()
        t.equal(result.status, 403)
        t.equal(result.code, "owner_only")
      end
    )
  end)
end)

t.test("require_owner returns the subject for the configured owner", function()
  with_ngx(function()
    t.with_stubs(
      "txt.owner_auth",
      stubs("a-token", { sub = "owner-uid" }, nil, "owner-uid"),
      function(owner_auth)
        t.equal(owner_auth.require_owner(), "owner-uid")
      end
    )
  end)
end)
