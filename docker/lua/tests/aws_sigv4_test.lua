local t = require("tests.testlib")

local function stubs(captured)
  return {
    ["txt.codec"] = {
      percent_encode = function(value)
        return value
      end,
      digest = function(_, value)
        if value ~= "" then
          captured.canonical = value
        end
        return "digest"
      end,
      hex = function(value)
        return value
      end,
      hmac = function()
        return "hmac"
      end,
    },
    ["txt.config"] = {
      get = function()
        return {
          r2_host = "account.r2.cloudflarestorage.com",
          r2_endpoint = "https://account.r2.cloudflarestorage.com",
          r2_bucket = "bucket",
          r2_region = "auto",
          r2_access_key_id = "access-key",
          r2_secret_access_key = "secret-key",
        }
      end,
    },
    ["resty.http"] = {
      new = function()
        return {
          set_timeouts = function() end,
          request_uri = function()
            return nil, "stubbed: no network in tests"
          end,
        }
      end,
    },
  }
end

t.test(
  "presigned GET canonical request has exactly one blank line before SignedHeaders",
  function()
    local captured = {}
    local saved_ngx = ngx
    ngx = {
      time = function()
        return 1700000000
      end,
    }
    t.with_stubs("txt.aws_sigv4", stubs(captured), function(aws)
      aws.presigned_get("object/path", 60)
    end)
    ngx = saved_ngx
    t.truthy(
      captured.canonical:find(
        "host:account.r2.cloudflarestorage.com\n\nhost\n",
        1,
        true
      )
    )
  end
)
