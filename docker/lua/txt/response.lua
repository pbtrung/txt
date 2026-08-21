local codec = require("txt.codec")
local config = require("txt.config")

local M = {}

local function headers()
  ngx.header["Access-Control-Allow-Origin"] = config.get().ui_origin
  ngx.header["Access-Control-Allow-Methods"] = "POST, DELETE, OPTIONS"
  ngx.header["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
  ngx.header["Vary"] = "Origin"
  ngx.header["Cache-Control"] = "no-store"
end

function M.json(status, body)
  headers()
  ngx.status = status
  ngx.header["Content-Type"] = "application/json"
  if body ~= nil then
    ngx.print(codec.json(body))
  end
  return ngx.exit(status)
end

function M.error(status, code)
  ngx.log(status >= 500 and ngx.ERR or ngx.WARN, code, " status=", status)
  return M.json(status, { error = code })
end

function M.empty(status)
  headers()
  return ngx.exit(status)
end

function M.preflight(methods)
  local origin = ngx.req.get_headers()["Origin"]
  if origin ~= config.get().ui_origin then
    return M.error(403, "origin_not_allowed")
  end
  headers()
  ngx.header["Access-Control-Allow-Methods"] = methods .. ", OPTIONS"
  return ngx.exit(204)
end

return M
