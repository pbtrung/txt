local t = require("tests.testlib")

local valid_path = string.rep("a", 52)
local raw_id = string.rep("i", 32)
local object_path = valid_path .. "/shared/" .. valid_path .. "/" .. valid_path

local DEFAULT_OWNER = { firebase_uid = "owner-uid", db_binding_hash = "binding-hash" }

local function stubs(rqlite, aws, owner_store, config)
  return {
    ["txt.aws_sigv4"] = aws or {},
    ["txt.codec"] = {
      base64url_decode = function(value)
        return value == "share-id" and raw_id or nil
      end,
      digest = function(_, value)
        return "hash:" .. value
      end,
      bytes_to_array = function(value)
        return value
      end,
      array_to_bytes = function(value)
        return value
      end,
      equal = function(left, right)
        return left == right
      end,
    },
    ["txt.config"] = config or {
      get = function()
        return { owner_uid = "owner-uid" }
      end,
    },
    ["txt.owner_proof"] = {
      valid_path = function(value)
        return value == valid_path
      end,
      path_binding = function()
        return "binding-hash"
      end,
    },
    ["txt.owner_store"] = owner_store or {
      load = function()
        return DEFAULT_OWNER
      end,
    },
    ["txt.rqlite"] = rqlite,
    ["txt.share_grant"] = {
      encrypt = function(_, path)
        return "grant:" .. path
      end,
      decrypt = function(_, grant)
        return grant:match("^grant:(.*)$")
      end,
    },
  }
end

t.test("share registration constructs one exact owner-prefix object path", function()
  local captured
  local rqlite = {
    request = function(statements)
      captured = statements
      return {
        {},
        {
          columns = { "object_path_hash", "state" },
          values = { { "hash:" .. object_path, "active" } },
        },
      }
    end,
    first_row = function(result)
      return { object_path_hash = result.values[1][1], state = result.values[1][2] }
    end,
  }
  local old_ngx = ngx
  ngx = {
    now = function()
      return 1
    end,
  }
  t.with_stubs("txt.shares", stubs(rqlite), function(shares)
    local input = t.truthy(shares.parse_create({
      share_id = "share-id",
      db_path = valid_path,
      db_prefix = valid_path,
      share_prefix = valid_path,
      share_path = valid_path,
    }))
    t.equal(input.object_path, object_path)
    t.equal(shares.register(input), "grant:" .. object_path)
    t.equal(captured[1][2].object_path_hash, "hash:" .. object_path)
    t.falsy(captured[1][2].user_id)
    t.falsy(captured[1][2].role)
  end)
  ngx = old_ngx
end)

t.test(
  "parse_object_request recovers the id and path from a share_id and grant",
  function()
    t.with_stubs("txt.shares", stubs({}), function(shares)
      local id, path = shares.parse_object_request({
        share_id = "share-id",
        grant = "grant:" .. object_path,
      })
      t.equal(id, raw_id)
      t.equal(path, object_path)
    end)
  end
)

t.test("parse_object_request rejects a grant that fails to decrypt", function()
  t.with_stubs("txt.shares", stubs({}), function(shares)
    local id = shares.parse_object_request({ share_id = "share-id", grant = "bogus" })
    t.falsy(id)
  end)
end)

t.test("share deletion revokes in rqlite before deleting the R2 object", function()
  local events = {}
  local rqlite = {
    request = function()
      events[#events + 1] = "mark-deleting"
      return {
        {},
        {
          columns = { "object_path_hash", "state" },
          values = { { "hash:" .. object_path, "deleting" } },
        },
      }
    end,
    first_row = function(result)
      return { object_path_hash = result.values[1][1], state = result.values[1][2] }
    end,
    execute = function()
      events[#events + 1] = "remove-row"
      return {}
    end,
  }
  local aws = {
    delete = function()
      events[#events + 1] = "delete-object"
      return true
    end,
  }
  local old_ngx = ngx
  ngx = {
    now = function()
      return 1
    end,
  }
  t.with_stubs("txt.shares", stubs(rqlite, aws), function(shares)
    t.truthy(shares.delete(raw_id, object_path))
    t.equal(table.concat(events, ","), "mark-deleting,delete-object,remove-row")
  end)
  ngx = old_ngx
end)

t.test(
  "active_object rejects a resupplied path that doesn't match the registered hash",
  function()
    local rqlite = {
      query = function()
        return {
          columns = { "object_path_hash" },
          values = { { "hash:" .. object_path } },
        }
      end,
      first_row = function(result)
        return { object_path_hash = result.values[1][1] }
      end,
    }
    t.with_stubs("txt.shares", stubs(rqlite), function(shares)
      t.truthy(shares.active_object(raw_id, object_path))
      t.falsy(shares.active_object(raw_id, "not/" .. object_path))
    end)
  end
)

t.test("authorize_owner_path accepts the configured owner's own binding", function()
  t.with_stubs("txt.shares", stubs({}), function(shares)
    t.truthy(shares.authorize_owner_path("owner-uid", valid_path, valid_path))
  end)
end)

t.test("authorize_owner_path rejects an unavailable owner store", function()
  local owner_store = {
    load = function()
      return nil, "rqlite unreachable"
    end,
  }
  t.with_stubs("txt.shares", stubs({}, nil, owner_store), function(shares)
    local ok, code = shares.authorize_owner_path("owner-uid", valid_path, valid_path)
    t.falsy(ok)
    t.equal(code, "owner_store_unavailable")
  end)
end)

t.test("authorize_owner_path rejects a uid that isn't the configured owner", function()
  t.with_stubs("txt.shares", stubs({}), function(shares)
    local ok, code = shares.authorize_owner_path("someone-else", valid_path, valid_path)
    t.falsy(ok)
    t.equal(code, "owner_configuration_mismatch")
  end)
end)

t.test("authorize_owner_path rejects a path that isn't the owner's binding", function()
  local owner_store = {
    load = function()
      return { firebase_uid = "owner-uid", db_binding_hash = "a-different-hash" }
    end,
  }
  t.with_stubs("txt.shares", stubs({}, nil, owner_store), function(shares)
    local ok, code = shares.authorize_owner_path("owner-uid", valid_path, valid_path)
    t.falsy(ok)
    t.equal(code, "path_not_authorized")
  end)
end)
