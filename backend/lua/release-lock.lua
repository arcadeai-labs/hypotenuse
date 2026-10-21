-- Release a lock only if this holder still owns it.
--
-- A plain DEL after a slow holder's lease expired would delete the next
-- holder's lock, letting a third process in beside it.
--
-- KEYS[1]  the lock key
-- ARGV[1]  the token this holder set
--
-- Returns 1 when released, 0 when the lock was no longer ours.
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
