-- Take one token from a per-installation token bucket with a reserve.
-- KEYS[1]: the bucket (a hash of `tokens` and `at`, the last refill in ms).
-- ARGV[1]: capacity. ARGV[2]: tokens refilled per second. ARGV[3]: now, in ms.
-- ARGV[4]: the reserve — tokens only a reserved call (an acknowledgement, a
-- stop's answer) may take. ARGV[5]: 1 for a reserved call, 0 otherwise.
-- Returns 0 when a token was taken, or how many milliseconds until one will be.
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local reserve = tonumber(ARGV[4])
local reserved = tonumber(ARGV[5]) == 1
local state = redis.call("HMGET", KEYS[1], "tokens", "at")
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
local elapsed = math.max(0, now - at)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)
local floor = 1
if not reserved then
  floor = 1 + reserve
end
local wait = 0
if tokens >= floor then
  tokens = tokens - 1
else
  wait = math.ceil(((floor - tokens) / rate) * 1000)
end
redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "at", tostring(now))
redis.call("PEXPIRE", KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)
return wait
