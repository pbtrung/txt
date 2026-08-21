local script = arg[0]:gsub("[^/]+$", "")
local lua_root = script:gsub("tests/$", "")
package.path = lua_root .. "?.lua;" .. lua_root .. "?/init.lua;" .. package.path

require("tests.owner_ticket_test")
require("tests.rate_limit_test")
require("tests.shares_test")
require("tests.firebase_id_token_test")

require("tests.testlib").finish()
