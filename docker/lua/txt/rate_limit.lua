local codec = require("txt.codec")
local config = require("txt.config")
local rqlite = require("txt.rqlite")

local M = {}

local LIMITS = {
  ["owner-keys"] = { window = 3600, maximum = 60 },
  ["owner-r2-token"] = { window = 3600, maximum = 30 },
  ["public-share-url"] = { window = 60, maximum = 120 },
}

function M.allow(scope, subject)
  local limit = LIMITS[scope]
  if not limit then
    return nil, "unknown rate-limit scope"
  end
  local digest, err = codec.hmac("sha256", config.get().rate_limit_key, subject)
  if not digest then
    return nil, err
  end
  local now = ngx.time()
  local window_start = math.floor(now / limit.window) * limit.window
  local params = {
    scope = scope,
    subject_hash = codec.bytes_to_array(digest),
    window_start = window_start,
  }
  local results
  results, err = rqlite.request({
    {
      [[
INSERT INTO rate_limits (scope, subject_hash, window_start, count)
VALUES (:scope, :subject_hash, :window_start, 1)
ON CONFLICT (scope, subject_hash, window_start)
DO UPDATE SET count = rate_limits.count + 1
]],
      params,
    },
    {
      [[
SELECT count FROM rate_limits
WHERE scope = :scope AND subject_hash = :subject_hash AND window_start = :window_start
]],
      params,
    },
  })
  if not results then
    return nil, err
  end
  local row = rqlite.first_row(results[2])
  if not row or type(row.count) ~= "number" then
    return nil, "missing rate-limit result"
  end
  return row.count <= limit.maximum
end

return M
