-- Count one hit in a fixed window.
-- KEYS[1]: the window's counter. ARGV[1]: the window length in milliseconds.
-- Returns the count after this hit; the first hit starts the window's clock.
local n = redis.call("INCR", KEYS[1])
if n == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return n
