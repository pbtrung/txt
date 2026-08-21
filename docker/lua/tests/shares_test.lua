local t = require("tests.testlib")

local valid_path = string.rep("a", 52)
local raw_id = string.rep("i", 32)

local function stubs(rqlite, aws)
  return {
    ["txt.aws_sigv4"] = aws or {},
    ["txt.codec"] = {
      base64url_decode = function(value)
        return value == "share-id" and raw_id or nil
      end,
      digest = function()
        return string.rep("d", 32)
      end,
      bytes_to_array = function(value)
        return { #value }
      end,
    },
    ["txt.owner_proof"] = {
      valid_path = function(value)
        return value == valid_path
      end,
    },
    ["txt.rqlite"] = rqlite,
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
          columns = { "object_path", "state" },
          values = {
            { valid_path .. "/shared/" .. valid_path .. "/" .. valid_path, "active" },
          },
        },
      }
    end,
    first_row = function(result)
      return { object_path = result.values[1][1], state = result.values[1][2] }
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
    t.truthy(shares.register(input))
    t.equal(
      captured[1][2].object_path,
      valid_path .. "/shared/" .. valid_path .. "/" .. valid_path
    )
    t.falsy(captured[1][2].user_id)
    t.falsy(captured[1][2].role)
  end)
  ngx = old_ngx
end)

t.test("share deletion revokes in rqlite before deleting the R2 object", function()
  local events = {}
  local rqlite = {
    request = function()
      events[#events + 1] = "mark-deleting"
      return {
        {},
        { columns = { "object_path", "state" }, values = { { "object", "deleting" } } },
      }
    end,
    first_row = function(result)
      return { object_path = result.values[1][1], state = result.values[1][2] }
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
    t.truthy(shares.delete(raw_id))
    t.equal(table.concat(events, ","), "mark-deleting,delete-object,remove-row")
  end)
  ngx = old_ngx
end)
