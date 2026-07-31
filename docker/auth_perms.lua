-- auth_perms.lua
--
-- Runs as access_by_lua_file on the /db/query and /db/execute locations in
-- nginx.conf, before their own proxy_pass forwards to rqlite. Does two
-- things docs/data_model.md assigns to "the OpenResty auth layer" and
-- nothing rqlite itself can do: (1) resolve the caller's API key to a
-- {user_id, role} identity, and (2) translate the client's {statementId,
-- batch} envelope into rqlite's own statement list, injecting db_id
-- server-side so it is never trusted from the client.
--
-- Scope is deliberately narrow for ordinary users -- READ_PAGE, GET_META,
-- and COMMIT only, all three hard-forced to db_id = caller's own user_id, so
-- a user can never read or write another tenant's rows. Admins get that same
-- small set of statements against any tenant (via target_db_id) plus a few
-- cross-tenant-by-design ones (LIST_USERS, REVOKE_KEY, FORCE_GC,
-- INSPECT_META), plus RAW_QUERY: literal, unrestricted SQL text executed
-- as-is, no forced db_id, no template. RAW_QUERY's trust boundary is the
-- admin role itself, not this file -- it exists because "admin can do any
-- query" has no safe way to auto-scope arbitrary SQL text to one tenant, so
-- it isn't offered to ordinary users at all. It does not (yet) manage
-- active_readers snapshot leases, and there's no audit_log table in
-- docs/data_model.md, so admin actions (including RAW_QUERY) aren't logged
-- to the database here -- both would need a schema addition first, not a
-- silent invention in this file.

local cjson = require "cjson"
local digest = require "resty.openssl.digest"

local AUTH_CACHE_TTL = 60 -- seconds; bounds how long a revoked key stays "valid" from cache

local function log(level, ...)
  ngx.log(level, "auth_perms: ", ...)
end

-- User-facing statements: db_id is ALWAYS the caller's own id, forced below,
-- never read from the client.
local USER_STATEMENTS = {
  READ_PAGE = {
    query = [[
      SELECT data FROM pages
      WHERE db_id=:db_id AND page_no=:page_no AND version<=:snapshot
      ORDER BY version DESC LIMIT 1
    ]],
  },
  -- Read-only, and deliberately not SELECT * -- needs_gc is server-internal
  -- bookkeeping a client opening its own db has no use for. This is the
  -- normal-user equivalent of admin's INSPECT_META: a caller needs its own
  -- current_version/page_count/page_size to open a page-store-backed VFS at
  -- all (xFileSize, and which snapshot to pin), and forcing db_id below
  -- (same as every other USER_STATEMENTS entry) already scopes it to the
  -- caller's own row -- no admin privilege required for this.
  GET_META = {
    query = [[
      SELECT current_version, page_count, page_size FROM db_meta WHERE db_id=:db_id
    ]],
  },
}

-- Admin-only statements: cross-tenant by design, only reachable for
-- role='admin'. `forced_params` fills in whatever this specific statement
-- needs from the request's single `target_db_id` -- deliberately per
-- statement, not one field blindly stamped onto every admin query, since
-- not every admin query is even tenant-scoped (LIST_USERS isn't).
local ADMIN_STATEMENTS = {
  LIST_USERS = {
    query = "SELECT user_id, role, disabled, created_at FROM users LIMIT :limit OFFSET :offset",
  },
  REVOKE_KEY = {
    query = "UPDATE api_keys SET revoked_at=:now WHERE user_id=:target_user_id",
    forced_params = function(params, target_db_id)
      params.now = ngx.now() * 1000 -- server time; never trust a client-supplied revocation timestamp
      params.target_user_id = target_db_id -- db_id IS users.user_id (docs/data_model.md)
    end,
  },
  FORCE_GC = {
    query = "UPDATE db_meta SET needs_gc=1 WHERE db_id=:target_db_id",
    forced_params = function(params, target_db_id)
      params.target_db_id = target_db_id
    end,
  },
  INSPECT_META = {
    query = "SELECT * FROM db_meta WHERE db_id=:target_db_id",
    forced_params = function(params, target_db_id)
      params.target_db_id = target_db_id
    end,
  },
}

local function fail(status, reason)
  log(status >= 500 and ngx.ERR or ngx.WARN, reason, " (status=", status, ")")
  ngx.status = status
  ngx.say(cjson.encode({ error = true }))
  ngx.exit(status)
end

local function bearer_key()
  local auth = ngx.req.get_headers()["Authorization"]
  local key = auth and auth:match("^Bearer%s+(.+)$")
  if not key then fail(401, "missing or malformed Authorization header") end
  return key
end

-- api_keys.key_hash is base64(SHA3-256(raw key)) -- see CLAUDE.md's "Key
-- facts worth not re-deriving". Not the sha256/hex a stock ngx_lua sha256
-- helper would give you -- must match exactly or every key looks revoked.
local function key_hash(raw_key)
  local d = digest.new("sha3-256")
  d:update(raw_key)
  return ngx.encode_base64(d:final())
end

local function query_identity(hash)
  -- rqlite's named-params shape is a two-element array [sql, params], not an
  -- object with query/named_params keys -- the latter is silently rejected
  -- with a 400 by rqlite itself.
  local body = cjson.encode({ {
    [[
      SELECT u.user_id, u.role FROM api_keys k
      JOIN users u ON u.user_id = k.user_id
      WHERE k.key_hash = :key_hash AND k.revoked_at IS NULL AND u.disabled = 0
    ]],
    { key_hash = hash },
  } })
  local res = ngx.location.capture("/internal/rqlite/db/query", {
    method = ngx.HTTP_POST,
    body = body,
    headers = { ["Content-Type"] = "application/json" },
  })
  if res.status ~= 200 then
    fail(502, "auth lookup returned HTTP " .. res.status .. " from rqlite")
  end

  local ok, decoded = pcall(cjson.decode, res.body)
  local result = ok and decoded and decoded.results and decoded.results[1]
  if not result or result.error then
    -- A real query/rqlite failure, not "key not found" -- keep the two
    -- distinguishable in the logs even though both currently exit the
    -- request with the same generic status.
    fail(502, "auth lookup query failed: " .. tostring(result and result.error or "malformed rqlite response"))
  end

  local rows = result.values
  if not rows or #rows == 0 then fail(401, "no active key for this hash") end
  return { user_id = rows[1][1], role = rows[1][2] }
end

-- Cached by key_hash, not by raw key -- an operator inspecting the cache
-- (or a core dump) sees the same one-way hash already stored in api_keys.
local function resolve_identity(hash)
  local cache = ngx.shared.auth_cache
  local cached = cache:get(hash)
  if cached then
    log(ngx.INFO, "identity cache hit")
    return cjson.decode(cached)
  end

  local identity = query_identity(hash)
  cache:set(hash, cjson.encode(identity), AUTH_CACHE_TTL)
  log(ngx.INFO, "identity cache miss, resolved user_id=", identity.user_id, " role=", identity.role)
  return identity
end

local function require_batch(body)
  if type(body.batch) ~= "table" or #body.batch == 0 then
    fail(400, "batch must be a non-empty array")
  end
  return body.batch
end

local function require_commit(body)
  local commit = body.commit
  if type(commit) ~= "table" or type(commit.pages) ~= "table" or #commit.pages == 0 then
    fail(400, "commit.pages must be a non-empty array")
  end
  if
    type(commit.old_version) ~= "number"
    or type(commit.new_version) ~= "number"
    or type(commit.page_count) ~= "number"
  then
    fail(400, "commit is missing old_version/new_version/page_count")
  end
  return commit
end

-- The guarded-INSERT + CAS-UPDATE pair from docs/data_model.md's "commit
-- pattern", built as one atomic rqlite statement batch. Kept as its own
-- builder rather than forced through the generic per-batch-item templating
-- below: it's two statement *shapes* sharing one transaction, not N
-- repetitions of a single template.
local function build_commit_statements(db_id, commit)
  local values_sql, args = {}, {}
  for _, page in ipairs(commit.pages) do
    table.insert(values_sql, "(?, ?, ?, ?)")
    table.insert(args, db_id)
    table.insert(args, page.page_no)
    table.insert(args, commit.new_version)
    table.insert(args, page.data)
  end

  local insert_sql = "INSERT INTO pages (db_id, page_no, version, data) "
    .. "SELECT db_id, page_no, version, data FROM (VALUES "
    .. table.concat(values_sql, ", ")
    .. ") AS dirty(db_id, page_no, version, data) "
    .. "WHERE (SELECT current_version FROM db_meta WHERE db_id = ?) = ?"
  table.insert(args, db_id)
  table.insert(args, commit.old_version)

  local insert_stmt = { insert_sql }
  for _, v in ipairs(args) do table.insert(insert_stmt, v) end

  log(
    ngx.INFO,
    "commit db_id=",
    db_id,
    " pages=",
    #commit.pages,
    " ",
    commit.old_version,
    " -> ",
    commit.new_version
  )

  return {
    insert_stmt, -- rqlite's positional-params form: {sql, p1, p2, ...}
    { -- rqlite's named-params form: {sql, params}, not {query=, named_params=}
      [[
        UPDATE db_meta SET current_version=:new_version, page_count=:page_count, needs_gc=1
        WHERE db_id=:db_id AND current_version=:old_version
      ]],
      {
        new_version = commit.new_version,
        page_count = commit.page_count,
        db_id = db_id,
        old_version = commit.old_version,
      },
    },
  }
end

-- Admin-only escape hatch: the SQL text comes from the client verbatim, with
-- no forced db_id and no template, unlike every other statement in this
-- file. Logged at WARN (not the INFO everything else uses) so it survives
-- nginx.conf's default `error_log ... warn` level -- this is the one place
-- worth an audit trail even without a dedicated audit_log table.
local function build_raw_statements(body)
  local statements = {}
  for _, item in ipairs(require_batch(body)) do
    if type(item.sql) ~= "string" or item.sql == "" then
      fail(400, "RAW_QUERY batch items require a non-empty sql string")
    end
    log(ngx.WARN, "RAW_QUERY: ", item.sql)
    if item.params ~= nil then
      table.insert(statements, { item.sql, item.params }) -- rqlite named-params form
    elseif item.args ~= nil then
      local stmt = { item.sql } -- rqlite positional-params form: {sql, p1, p2, ...}
      for _, a in ipairs(item.args) do table.insert(stmt, a) end
      table.insert(statements, stmt)
    else
      table.insert(statements, item.sql) -- rqlite plain-string form: no params at all
    end
  end
  return statements
end

local function build_user_statements(body, user_id)
  if body.statementId == "COMMIT" then
    return build_commit_statements(user_id, require_commit(body))
  end

  local stmt = USER_STATEMENTS[body.statementId]
  if not stmt then fail(400, "unknown statementId: " .. tostring(body.statementId)) end

  local statements = {}
  for _, params in ipairs(require_batch(body)) do
    params.db_id = user_id -- forced, never read from the client
    table.insert(statements, { stmt.query, params })
  end
  return statements
end

-- Admin acting "as" a tenant must say which one explicitly -- no implicit self.
local function build_admin_statements(body)
  if body.statementId == "RAW_QUERY" then
    return build_raw_statements(body)
  end
  if body.statementId == "COMMIT" then
    if not body.target_db_id then fail(400, "COMMIT as admin requires target_db_id") end
    return build_commit_statements(body.target_db_id, require_commit(body))
  end

  local user_tmpl = USER_STATEMENTS[body.statementId]
  local admin_tmpl = ADMIN_STATEMENTS[body.statementId]
  if not (user_tmpl or admin_tmpl) then
    fail(400, "unknown statementId: " .. tostring(body.statementId))
  end

  local batch = require_batch(body)
  local statements = {}
  if user_tmpl then
    if not body.target_db_id then fail(400, body.statementId .. " as admin requires target_db_id") end
    for _, params in ipairs(batch) do
      params.db_id = body.target_db_id
      table.insert(statements, { user_tmpl.query, params })
    end
  else
    if admin_tmpl.forced_params and not body.target_db_id then
      fail(400, body.statementId .. " requires target_db_id")
    end
    for _, params in ipairs(batch) do
      if admin_tmpl.forced_params then admin_tmpl.forced_params(params, body.target_db_id) end
      table.insert(statements, { admin_tmpl.query, params })
    end
  end
  return statements
end

ngx.req.read_body()
local ok, body = pcall(cjson.decode, ngx.req.get_body_data() or "")
if not ok or not body or not body.statementId then
  fail(400, "request body is not valid JSON or missing statementId")
end

local identity = resolve_identity(key_hash(bearer_key()))
log(ngx.INFO, identity.role, " ", identity.user_id, " -> ", body.statementId)

local statements = (identity.role == "admin") and build_admin_statements(body)
  or build_user_statements(body, identity.user_id)

ngx.req.set_body_data(cjson.encode(statements))
