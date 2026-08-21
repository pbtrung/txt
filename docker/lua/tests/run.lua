local script = arg[0]:gsub("[^/]+$", "")
local lua_root = script:gsub("tests/$", "")
package.path = lua_root .. "?.lua;" .. lua_root .. "?/init.lua;" .. package.path

require("tests.owner_ticket_test")
require("tests.owner_r2_credentials_test")
require("tests.aws_sigv4_test")
require("tests.rate_limit_test")
require("tests.shares_test")
require("tests.share_grant_test")
require("tests.firebase_id_token_test")
require("tests.codec_test")

require("tests.testlib").finish()
