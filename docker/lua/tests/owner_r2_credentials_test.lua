local t = require("tests.testlib")

local function stubs(captured)
  return {
    ["txt.codec"] = {
      base64_encode = function(value)
        captured.encoded = value
        return "standard-base64"
      end,
      digest = function()
        return "digest"
      end,
      hex = function()
        return "digest-hex"
      end,
    },
    ["txt.config"] = {
      get = function()
        return {
          r2_host = "account.r2.cloudflarestorage.com",
          r2_bucket = "bucket",
          r2_access_key_id = "access-key",
          r2_secret_access_key = "secret-key",
        }
      end,
    },
    ["txt.jwt"] = {
      sign_hs256 = function(payload)
        captured.payload = payload
        return "signed.jwt"
      end,
    },
  }
end

t.test("R2 session tokens use standard padded base64", function()
  local captured = {}
  local saved_ngx = ngx
  ngx = {
    time = function()
      return 1000
    end,
  }
  t.with_stubs("txt.owner_r2_credentials", stubs(captured), function(credentials)
    local minted = credentials.mint("database", "books")
    t.equal(minted[1].session_token, "standard-base64")
    t.equal(minted[2].session_token, "standard-base64")
  end)
  ngx = saved_ngx
  t.equal(captured.encoded, "jwt/signed.jwt")
end)
