local t = require("tests.testlib")

local function modules(payload)
  local cache
  local codec = {
    base64url_decode = function(value)
      return value
    end,
    parse_json = function(value)
      if value == "header" then
        return { alg = "RS256", kid = "key-id" }
      end
      if value == "payload" then
        return payload
      end
      if value == "cert-body" then
        return { ["key-id"] = "certificate" }
      end
    end,
  }
  local http = {
    new = function()
      return {
        set_timeouts = function() end,
        request_uri = function()
          return {
            status = 200,
            body = "cert-body",
            headers = { ["Cache-Control"] = "max-age=3600" },
          }
        end,
      }
    end,
  }
  local x509 = {
    new = function()
      return {
        get_pubkey = function()
          return {
            verify = function()
              return true
            end,
          }
        end,
      }
    end,
  }
  local old_ngx = ngx
  ngx = {
    time = function()
      return 1000
    end,
    shared = {
      firebase_certs = {
        get = function()
          return cache
        end,
        set = function(_, _, value)
          cache = value
        end,
      },
    },
  }
  return {
    old_ngx = old_ngx,
    stubs = {
      ["txt.codec"] = codec,
      ["txt.config"] = {
        get = function()
          return { firebase_project_id = "project" }
        end,
      },
      ["resty.http"] = http,
      ["resty.openssl.x509"] = x509,
    },
  }
end

t.test("Firebase verification accepts the configured project token", function()
  local setup = modules({
    exp = 2000,
    iat = 900,
    auth_time = 800,
    aud = "project",
    iss = "https://securetoken.google.com/project",
    sub = "owner",
  })
  t.with_stubs("txt.firebase_id_token", setup.stubs, function(firebase)
    local identity = t.truthy(firebase.verify("header.payload.signature"))
    t.equal(identity.sub, "owner")
  end)
  ngx = setup.old_ngx
end)

t.test("Firebase verification rejects another audience", function()
  local setup = modules({
    exp = 2000,
    iat = 900,
    auth_time = 800,
    aud = "other-project",
    iss = "https://securetoken.google.com/project",
    sub = "owner",
  })
  t.with_stubs("txt.firebase_id_token", setup.stubs, function(firebase)
    t.falsy(firebase.verify("header.payload.signature"))
  end)
  ngx = setup.old_ngx
end)
