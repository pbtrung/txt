local codec = require("txt.codec")
local config = require("txt.config")
local http = require("resty.http")

local M = {}

local function send(path, statements)
  local client = http.new()
  client:set_timeouts(1000, 3000, 3000)
  local result, err = client:request_uri(config.get().rqlite_url .. path, {
    method = "POST",
    body = codec.json(statements),
    headers = { ["Content-Type"] = "application/json" },
    keepalive = true,
  })
  if not result then
    return nil, err
  end
  if result.status ~= 200 then
    return nil, "rqlite HTTP " .. result.status
  end
  local decoded = codec.parse_json(result.body)
  if not decoded or type(decoded.results) ~= "table" then
    return nil, "malformed rqlite response"
  end
  for _, item in ipairs(decoded.results) do
    if item.error then
      return nil, item.error
    end
  end
  return decoded.results
end

function M.query(sql, params)
  local results, err =
    send("/db/query?level=strong&blob_array", { { sql, params or {} } })
  if not results then
    return nil, err
  end
  return results[1]
end

function M.execute(sql, params)
  local results, err = send("/db/execute?transaction", { { sql, params or {} } })
  if not results then
    return nil, err
  end
  return results[1]
end

function M.request(statements)
  return send("/db/request?transaction&level=strong&blob_array", statements)
end

function M.first_row(result)
  if not result or type(result.values) ~= "table" or #result.values == 0 then
    return nil
  end
  local row = {}
  for index, name in ipairs(result.columns or {}) do
    row[name] = result.values[1][index]
  end
  return row
end

return M
