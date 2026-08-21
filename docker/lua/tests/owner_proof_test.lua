local t = require("tests.testlib")

local valid_path = string.rep("a", 52)
local user_handle = string.rep("h", 32)
local request_id = string.rep("r", 32)
local signature = string.rep("s", 132)

local function fake_digest(algorithm, value)
  return "digest:" .. algorithm .. ":" .. value
end

local function stubs(pkey)
  return {
    ["txt.codec"] = {
      digest = fake_digest,
      equal = function(left, right)
        return left == right
      end,
      base64_decode = function(value)
        return value
      end,
      u32be = function(value)
        return "u32:" .. tostring(value)
      end,
      u64be = function(value)
        return "u64:" .. tostring(value)
      end,
    },
    ["resty.openssl.pkey"] = pkey or {},
  }
end

local function with_ngx(now, fn)
  local old_ngx = ngx
  ngx = {
    time = function()
      return now
    end,
  }
  local ok, err = pcall(fn)
  ngx = old_ngx
  if not ok then
    error(err, 0)
  end
end

local function valid_body(overrides)
  local body = {
    ticket = "exact-ticket-value",
    db_path = valid_path,
    db_prefix = valid_path,
    user_handle = user_handle,
    proof = {
      request_id = request_id,
      signature = signature,
      version = 2,
      expires_at = 1030,
    },
  }
  for key, value in pairs(overrides or {}) do
    body[key] = value
  end
  return body
end

t.test("parse accepts a well-formed proof body within the freshness window", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      local parsed = t.truthy(owner_proof.parse(valid_body()))
      t.equal(parsed.ticket, "exact-ticket-value")
      t.equal(parsed.user_handle, user_handle)
      t.equal(parsed.request_id, request_id)
      t.equal(parsed.signature, signature)
      t.equal(parsed.version, 2)
      t.equal(parsed.expires_at, 1030)
    end)
  end)
end)

t.test("parse rejects a malformed db_path", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      t.falsy(owner_proof.parse(valid_body({ db_path = "too-short" })))
    end)
  end)
end)

t.test("parse rejects an expiry already in the past", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      local body = valid_body()
      body.proof.expires_at = 999
      t.falsy(owner_proof.parse(body))
    end)
  end)
end)

t.test("parse rejects an expiry beyond the 60-second freshness window", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      local body = valid_body()
      body.proof.expires_at = 1061
      t.falsy(owner_proof.parse(body))
    end)
  end)
end)

t.test("parse rejects a proof version other than 2", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      local body = valid_body()
      body.proof.version = 1
      t.falsy(owner_proof.parse(body))
    end)
  end)
end)

t.test("parse rejects a signature whose decoded length isn't 132 bytes", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      local body = valid_body()
      body.proof.signature = "too-short"
      t.falsy(owner_proof.parse(body))
    end)
  end)
end)

local function ticket_for(proof)
  return {
    user_handle_hash = fake_digest("sha256", proof.user_handle),
    db_binding_hash = fake_digest("sha512", proof.db_path .. proof.db_prefix),
  }
end

local function pkey_returning(result)
  return {
    new = function()
      return {
        verify = function()
          return result
        end,
      }
    end,
  }
end

-- Builds a properly parsed proof (ticket/user_handle/db_path/... all
-- top-level, matching M.parse's output) rather than the raw nested request
-- body shape, since M.verify expects the former.
local function parsed_proof(owner_proof)
  return t.truthy(owner_proof.parse(valid_body()))
end

t.test(
  "verify rejects a proof whose user handle hash doesn't match the ticket",
  function()
    with_ngx(1000, function()
      t.with_stubs("txt.owner_proof", stubs(pkey_returning(true)), function(owner_proof)
        local proof = parsed_proof(owner_proof)
        local ticket = ticket_for(proof)
        ticket.user_handle_hash = "wrong-hash"
        t.falsy(owner_proof.verify(ticket, proof))
      end)
    end)
  end
)

t.test("verify rejects a proof whose path binding doesn't match the ticket", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(pkey_returning(true)), function(owner_proof)
      local proof = parsed_proof(owner_proof)
      local ticket = ticket_for(proof)
      ticket.db_binding_hash = "wrong-hash"
      t.falsy(owner_proof.verify(ticket, proof))
    end)
  end)
end)

t.test("verify rejects a signature that isn't exactly 132 raw bytes", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(pkey_returning(true)), function(owner_proof)
      local proof = parsed_proof(owner_proof)
      proof.signature = "short"
      t.falsy(owner_proof.verify(ticket_for(proof), proof))
    end)
  end)
end)

t.test("verify returns true when the P-521 signature check succeeds", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(pkey_returning(true)), function(owner_proof)
      local proof = parsed_proof(owner_proof)
      t.truthy(owner_proof.verify(ticket_for(proof), proof))
    end)
  end)
end)

t.test("verify returns false when the P-521 signature check fails", function()
  with_ngx(1000, function()
    t.with_stubs("txt.owner_proof", stubs(pkey_returning(false)), function(owner_proof)
      local proof = parsed_proof(owner_proof)
      t.falsy(owner_proof.verify(ticket_for(proof), proof))
    end)
  end)
end)

t.test(
  "valid_path and path_binding agree on well-formed and malformed paths",
  function()
    t.with_stubs("txt.owner_proof", stubs(), function(owner_proof)
      t.truthy(owner_proof.valid_path(valid_path))
      t.falsy(owner_proof.valid_path("too-short"))
      t.truthy(owner_proof.path_binding(valid_path, valid_path))
      t.falsy(owner_proof.path_binding("too-short", valid_path))
    end)
  end
)
