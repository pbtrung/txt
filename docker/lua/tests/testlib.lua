local M = { total = 0, failed = 0 }

local function render(value)
  if type(value) == "string" then
    return string.format("%q", value)
  end
  return tostring(value)
end

function M.equal(actual, expected, message)
  if actual ~= expected then
    error(
      (message or "values differ")
        .. ": expected "
        .. render(expected)
        .. ", got "
        .. render(actual),
      2
    )
  end
end

function M.truthy(value, message)
  if not value then
    error(message or "expected a truthy value", 2)
  end
  return value
end

function M.falsy(value, message)
  if value then
    error(message or "expected a falsy value", 2)
  end
end

function M.with_stubs(target, stubs, callback)
  local saved_loaded = {}
  local saved_preload = {}
  for name, module in pairs(stubs) do
    saved_loaded[name] = package.loaded[name]
    saved_preload[name] = package.preload[name]
    package.loaded[name] = nil
    package.preload[name] = function()
      return module
    end
  end
  local saved_target = package.loaded[target]
  package.loaded[target] = nil
  local ok, result = pcall(callback, require(target))
  package.loaded[target] = saved_target
  for name in pairs(stubs) do
    package.loaded[name] = saved_loaded[name]
    package.preload[name] = saved_preload[name]
  end
  if not ok then
    error(result, 0)
  end
  return result
end

function M.test(name, callback)
  M.total = M.total + 1
  local ok, err = pcall(callback)
  if ok then
    io.write("ok ", M.total, " - ", name, "\n")
    return
  end
  M.failed = M.failed + 1
  io.write("not ok ", M.total, " - ", name, "\n", tostring(err), "\n")
end

function M.finish()
  io.write(string.format("1..%d\n", M.total))
  if M.failed > 0 then
    os.exit(1)
  end
end

return M
