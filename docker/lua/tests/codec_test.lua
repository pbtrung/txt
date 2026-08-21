local testlib = require("tests.testlib")

local encoded = {
  a = "YQ==",
  ab = "YWI=",
  abc = "YWJj",
}

local function decode(value)
  for raw, canonical in pairs(encoded) do
    if value == canonical then
      return raw
    end
  end
end

local function with_codec(callback)
  local saved_ngx = _G.ngx
  _G.ngx = {
    decode_base64 = decode,
    encode_base64 = function(value)
      return encoded[value]
    end,
  }
  local ok, err = pcall(testlib.with_stubs, "txt.codec", {
    ["cjson.safe"] = {},
    ["resty.openssl.digest"] = {},
    ["resty.openssl.hmac"] = {},
    ["resty.openssl.rand"] = {},
  }, callback)
  _G.ngx = saved_ngx
  if not ok then
    error(err, 0)
  end
end

testlib.test("canonical base64 accepts zero, one, or two padding characters", function()
  with_codec(function(codec)
    testlib.equal(codec.base64_decode("YWJj"), "abc")
    testlib.equal(codec.base64_decode("YWI="), "ab")
    testlib.equal(codec.base64_decode("YQ=="), "a")
  end)
end)

testlib.test("base64 rejects missing, excess, and non-alphabet characters", function()
  with_codec(function(codec)
    testlib.falsy(codec.base64_decode("YWI"))
    testlib.falsy(codec.base64_decode("YQ==="))
    testlib.falsy(codec.base64_decode("YQ==\n"))
  end)
end)
