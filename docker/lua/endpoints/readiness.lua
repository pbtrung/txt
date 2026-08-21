local rqlite = require("txt.rqlite")
local response = require("txt.response")

if ngx.req.get_method() ~= "GET" then
  return response.error(405, "method_not_allowed")
end

local result, err = rqlite.query("SELECT 1 AS ready")
local row = result and rqlite.first_row(result)
if not row or row.ready ~= 1 then
  ngx.log(ngx.ERR, "readiness rqlite check failed: ", err or "bad response")
  return response.error(503, "not_ready")
end
return response.json(200, { ok = true })
