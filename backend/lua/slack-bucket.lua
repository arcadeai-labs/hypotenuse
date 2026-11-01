-- Take one token from a per-installation token bucket, refilled continuously.
-- KEYS[1]: the bucket (a hash of `tokens` and `at`, the last refill in ms).
-- ARGV[1]: capacity. ARGV[2]: tokens refilled per second. ARGV[3]: now, in ms.
-- Returns 0 when a token was taken, or how many milliseconds until one will be.
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call("HMGET", KEYS[1], "tokens", "at")
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
local elapsed = math.max(0, now - at)
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil(((1 - tokens) / rate) * 1000)
end
redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "at", tostring(now))
redis.call("PEXPIRE", KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)
return wait
