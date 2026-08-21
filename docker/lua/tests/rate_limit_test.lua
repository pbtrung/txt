local t = require("tests.testlib")

t.test("rate limit increments and checks the durable rqlite counter", function()
  local captured
  local rqlite = {
    request = function(statements)
      captured = statements
      return { {}, { columns = { "count" }, values = { { 60 } } } }
    end,
    first_row = function(result)
      return { count = result.values[1][1] }
    end,
  }
  local old_ngx = ngx
  ngx = {
    time = function()
      return 3700
    end,
  }
  t.with_stubs("txt.rate_limit", {
    ["txt.codec"] = {
      hmac = function()
        return string.rep("h", 32)
      end,
      bytes_to_array = function(value)
        return { #value }
      end,
    },
    ["txt.config"] = {
      get = function()
        return { rate_limit_key = "secret" }
      end,
    },
    ["txt.rqlite"] = rqlite,
  }, function(rate_limit)
    t.truthy(rate_limit.allow("owner-keys", "owner"))
    t.equal(captured[1][2].window_start, 3600)
    t.equal(captured[1][2].scope, "owner-keys")
    t.truthy(captured[1][1]:match("ON CONFLICT"))
  end)
  ngx = old_ngx
end)

t.test("rate limit rejects a count above the endpoint budget", function()
  local rqlite = {
    request = function()
      return { {}, { columns = { "count" }, values = { { 121 } } } }
    end,
    first_row = function(result)
      return { count = result.values[1][1] }
    end,
  }
  local old_ngx = ngx
  ngx = {
    time = function()
      return 120
    end,
  }
  t.with_stubs("txt.rate_limit", {
    ["txt.codec"] = {
      hmac = function()
        return string.rep("h", 32)
      end,
      bytes_to_array = function()
        return {}
      end,
    },
    ["txt.config"] = {
      get = function()
        return { rate_limit_key = "secret" }
      end,
    },
    ["txt.rqlite"] = rqlite,
  }, function(rate_limit)
    t.falsy(rate_limit.allow("public-share-url", "127.0.0.1"))
  end)
  ngx = old_ngx
end)
