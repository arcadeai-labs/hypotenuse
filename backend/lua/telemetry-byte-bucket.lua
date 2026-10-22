-- One project's telemetry ingress budget, in bytes: take `cost`, or say when
-- that many will be free.
--
-- One script rather than a read and a write from TypeScript, because two web
-- processes checking and then decrementing would both spend the last bytes.
--
-- KEYS[1]  the bucket hash, `telemetry:bucket:<projectId>`
-- ARGV[1]  now, epoch ms
-- ARGV[2]  refill rate, bytes per second
-- ARGV[3]  burst: the most bytes the bucket holds
-- ARGV[4]  cost: the batch's size in bytes
--
-- Returns { granted (1 or 0), wait } where wait is how many ms until a batch
-- of this size could be granted, 0 when granted. A batch larger than the
-- burst is charged the burst, so it can pass once the bucket is full.
local key = KEYS[1]
local now = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2]) / 1000
local burst = tonumber(ARGV[3])
local cost = math.min(tonumber(ARGV[4]), burst)

local state = redis.call("HMGET", key, "bytes", "ts")
local bytes = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now

if now > ts then
  bytes = math.min(burst, bytes + (now - ts) * per_ms)
end

local granted = 0
local wait = 0
if bytes >= cost then
  bytes = bytes - cost
  granted = 1
else
  wait = math.ceil((cost - bytes) / per_ms)
end

redis.call("HSET", key, "bytes", tostring(bytes), "ts", tostring(now))
redis.call("PEXPIRE", key, math.ceil(burst / per_ms) + 60000)
return { granted, wait }
