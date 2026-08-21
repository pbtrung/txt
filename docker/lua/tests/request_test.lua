local t = require("tests.testlib")

local function fake_ngx(opts)
  opts = opts or {}
  return {
    req = {
      get_method = function()
        return opts.method or "GET"
      end,
      get_headers = function()
        return opts.headers or {}
      end,
      read_body = function() end,
      get_body_data = function()
        return opts.body
      end,
    },
    var = { remote_addr = opts.remote_addr },
  }
end

local function stubs(captured)
  return {
    ["txt.codec"] = {
      parse_json = function(value)
        if value == "not-json" then
          return nil
        end
        if value == "[1,2,3]" then
          return { 1, 2, 3 } -- a table, but from a JSON array, not an object
        end
        return { ok = true }
      end,
    },
    ["txt.config"] = {
      get = function()
        return { ui_origin = "https://ui.example" }
      end,
    },
    ["txt.response"] = {
      error = function(status, code)
        captured[#captured + 1] = { status = status, code = code }
      end,
    },
  }
end

local function with_ngx(ngx_stub, fn)
  local old_ngx = ngx
  ngx = ngx_stub
  local ok, err = pcall(fn)
  ngx = old_ngx
  if not ok then
    error(err, 0)
  end
end

t.test("require_method short-circuits an OPTIONS preflight with no error", function()
  local captured = {}
  with_ngx(fake_ngx({ method = "OPTIONS" }), function()
    t.with_stubs("txt.request", stubs(captured), function(request)
      t.falsy(request.require_method("POST"))
      t.equal(#captured, 0)
    end)
  end)
end)

t.test("require_method reports a method mismatch", function()
  local captured = {}
  with_ngx(fake_ngx({ method = "GET" }), function()
    t.with_stubs("txt.request", stubs(captured), function(request)
      request.require_method("POST")
      t.equal(captured[1].status, 405)
      t.equal(captured[1].code, "method_not_allowed")
    end)
  end)
end)

t.test("require_method reports an origin that doesn't match UI_ORIGIN", function()
  local captured = {}
  local ngx_stub = fake_ngx({
    method = "POST",
    headers = { Origin = "https://evil.example" },
  })
  with_ngx(ngx_stub, function()
    t.with_stubs("txt.request", stubs(captured), function(request)
      request.require_method("POST")
      t.equal(captured[1].status, 403)
      t.equal(captured[1].code, "origin_not_allowed")
    end)
  end)
end)

t.test("require_method reports a missing origin", function()
  local captured = {}
  local ngx_stub = fake_ngx({ method = "POST" })
  with_ngx(ngx_stub, function()
    t.with_stubs("txt.request", stubs(captured), function(request)
      request.require_method("POST")
      t.equal(captured[1].status, 403)
      t.equal(captured[1].code, "origin_not_allowed")
    end)
  end)
end)

t.test("require_method accepts a matching method and origin without error", function()
  local captured = {}
  local ngx_stub = fake_ngx({
    method = "POST",
    headers = { Origin = "https://ui.example" },
  })
  with_ngx(ngx_stub, function()
    t.with_stubs("txt.request", stubs(captured), function(request)
      t.truthy(request.require_method("POST"))
      t.equal(#captured, 0)
    end)
  end)
end)

t.test(
  "json rejects a Content-Length above the limit without reading the body",
  function()
    local read_calls = 0
    local ngx_stub = fake_ngx({ headers = { ["Content-Length"] = "999" } })
    ngx_stub.req.read_body = function()
      read_calls = read_calls + 1
    end
    with_ngx(ngx_stub, function()
      t.with_stubs("txt.request", stubs({}), function(request)
        local value, err = request.json(10)
        t.falsy(value)
        t.equal(err, "body_too_large")
        t.equal(read_calls, 0)
      end)
    end)
  end
)

t.test("json rejects a missing or empty body", function()
  with_ngx(fake_ngx({ body = nil }), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      local value, err = request.json(512)
      t.falsy(value)
      t.equal(err, "invalid_body")
    end)
  end)
end)

t.test("json rejects a body larger than the limit once actually read", function()
  with_ngx(fake_ngx({ body = "0123456789" }), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      local value, err = request.json(5)
      t.falsy(value)
      t.equal(err, "invalid_body")
    end)
  end)
end)

t.test("json rejects parsed JSON that isn't a table", function()
  with_ngx(fake_ngx({ body = "not-json" }), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      local value, err = request.json(512)
      t.falsy(value)
      t.equal(err, "invalid_json")
    end)
  end)
end)

t.test("json returns the parsed object for a well-formed body", function()
  with_ngx(fake_ngx({ body = "{}" }), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      local value = t.truthy(request.json(512))
      t.equal(value.ok, true)
    end)
  end)
end)

local function bearer_ngx(header)
  return fake_ngx({ headers = { Authorization = header } })
end

t.test("bearer extracts the token from a well-formed Authorization header", function()
  with_ngx(bearer_ngx("Bearer abc.def.ghi"), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      t.equal(request.bearer(), "abc.def.ghi")
    end)
  end)
end)

t.test("bearer rejects a missing Authorization header", function()
  with_ngx(bearer_ngx(nil), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      t.falsy(request.bearer())
    end)
  end)
end)

t.test("bearer rejects a header without the Bearer scheme", function()
  with_ngx(bearer_ngx("Basic abc123"), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      t.falsy(request.bearer())
    end)
  end)
end)

t.test("client_address ignores a spoofed X-Forwarded-For header", function()
  local ngx_stub = fake_ngx({
    remote_addr = "203.0.113.9",
    headers = { ["X-Forwarded-For"] = "1.2.3.4" },
  })
  with_ngx(ngx_stub, function()
    t.with_stubs("txt.request", stubs({}), function(request)
      t.equal(request.client_address(), "203.0.113.9")
    end)
  end)
end)

t.test("client_address falls back to 'unknown' with no remote_addr", function()
  with_ngx(fake_ngx({ remote_addr = nil }), function()
    t.with_stubs("txt.request", stubs({}), function(request)
      t.equal(request.client_address(), "unknown")
    end)
  end)
end)
