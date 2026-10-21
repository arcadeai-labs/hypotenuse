-- One Linear installation's request budget: take a token, or say when one
-- will be free.
--
-- One script rather than a read and a write from TypeScript, because two
-- workers checking and then decrementing would both spend the last token.
--
-- KEYS[1]  the bucket hash, `linear:bucket:<installationId>`
-- ARGV[1]  now, epoch ms
-- ARGV[2]  refill rate, tokens per hour
-- ARGV[3]  burst: the most tokens the bucket holds
-- ARGV[4]  headroom: tokens that must remain after this take (0 for an
--          acknowledgement, the reserve for normal work, more for bulk)
-- ARGV[5]  what Linear last reported remaining, or -1 for nothing new
-- ARGV[6]  when Linear reported it, epoch ms (0 with -1 above)
--
-- Returns { granted (1 or 0), wait } where wait is how many ms until this
-- caller could be granted, 0 when granted.
local key = KEYS[1]
local now = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2]) / 3600000
local burst = tonumber(ARGV[3])
local headroom = tonumber(ARGV[4])
local observed = tonumber(ARGV[5])
local observed_at = tonumber(ARGV[6])

local state = redis.call("HMGET", key, "tokens", "ts", "observedAt")
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
local applied = tonumber(state[3]) or 0

if now > ts then
  tokens = math.min(burst, tokens + (now - ts) * per_ms)
end

-- Linear's own count wins when it is lower: workspace installs share Linear's
-- budget with nothing we can see, and a count we think we have is not one
-- Linear will honour. Each observation is applied once, so a stale one does
-- not pin the bucket.
if observed >= 0 and observed_at > applied then
  if observed < tokens then tokens = observed end
  applied = observed_at
end

local granted = 0
local wait = 0
if tokens >= headroom + 1 then
  tokens = tokens - 1
  granted = 1
else
  wait = math.ceil(((headroom + 1) - tokens) / per_ms)
end

redis.call(
  "HSET", key,
  "tokens", tostring(tokens),
  "ts", tostring(now),
  "observedAt", tostring(applied)
)
-- An idle installation's bucket is full again within the hour; nothing is lost
-- by letting it expire.
redis.call("PEXPIRE", key, 3600000)
return { granted, wait }
