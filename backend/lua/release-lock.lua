-- Release a lock only if this caller still holds it.
-- KEYS[1]: the lock key. ARGV[1]: the holder's token.
-- Returns 1 when released, 0 when someone else holds it (or nobody does).
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
