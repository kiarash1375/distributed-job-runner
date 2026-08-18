- Gateway restart: killed process, jobs still PENDING on restart. State is in Postgres, not memory.
- Postgres restart: docker compose restart postgres; jobs survived (named volume). Gateway did not crash.
- Jobs for a non-existent agent stay PENDING forever. The gateway can't distinguish
  "agent offline" from "agent never existed" — both look like a missing socket.
  Fix: expires_at column + periodic sweep to fail undispatched jobs past deadline.
  Also considered: agents table so unknown agent IDs are rejected at submission.
  Not implemented due to time; documented as a known gap.