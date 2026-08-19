# Reproducible failure scenarios

Each scenario is a manual sequence, because they require killing and restarting
processes. Prerequisites: gateway running, agent-a and agent-b running.

## 1. Agent offline before the job arrives

1. Stop agent-b with Ctrl+C.
2. Submit a job for it:

   curl -s -X POST localhost:8080/jobs -H "Content-Type: application/json" \
     -d '{"agentId":"agent-b","image":"alpine:3.19","command":["sh","-c","echo delivered late"],"idempotencyKey":"fs-offline"}'

3. Check status — expect PENDING:  curl localhost:8080/jobs/<id>
4. Start agent-b:  AGENT_ID=agent-b npm run agent
5. Check status again — expect SUCCEEDED within a second of connection.

Expected: the job is delivered when the agent reconnects, not by a gateway retry.

## 2. Agent restarts mid-job

1. Submit a long job to agent-a:

   curl -s -X POST localhost:8080/jobs -H "Content-Type: application/json" \
     -d '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","for i in $(seq 1 40); do echo tick $i; sleep 1; done"],"timeoutSeconds":120,"idempotencyKey":"fs-restart"}'

2. Wait for "container started" in the agent log, then a few more seconds.
3. Ctrl+C agent-a.
4. Confirm the container is still alive without its agent:

   docker ps --filter "label=jobrunner.job-id=<id>"

5. Restart:  AGENT_ID=agent-a npm run agent

Expected: agent log shows "reattaching to running container"; the job reaches
SUCCEEDED when the container finishes.

## 3. Agent dies after the container finishes, before reporting

Same as scenario 2, but wait for the container to exit before restarting the
agent.

Expected: agent log shows "recovered exit code from finished container"; the job
moves from RUNNING to a terminal state. The exit code survived because
containers are not auto-removed.

## 4. Orphan container cleanup

1. Submit a job and Ctrl+C agent-a while it runs.
2. Force the job terminal in the database:

   docker compose exec postgres psql -U jobrunner -d jobrunner \
     -c "UPDATE jobs SET status='FAILED' WHERE id='<id>'"

3. Restart agent-a.

Expected: agent log shows "orphan container, removing" — the container's job is
no longer active, so it is cleaned up.

## 5. Gateway restart

1. Note current state:  curl localhost:8080/jobs
2. Ctrl+C the gateway.
3. Confirm the API is down:  curl localhost:8080/jobs   (connection refused)
4. Restart:  npm run gateway
5. Check both:  curl localhost:8080/jobs  and  curl localhost:8080/agents

Expected: all jobs and statuses intact; the agent list is briefly empty and
repopulates as agents reconnect with backoff.

## 6. Database restart

   docker compose restart postgres
   curl localhost:8080/jobs

Expected: jobs survive (named volume); the running gateway does not crash.

## 7. Live viewer disconnects

1. Submit a long job and attach:  curl -N localhost:8080/jobs/<id>/logs/stream
2. Ctrl+C the viewer partway through.
3. After the job finishes:  curl localhost:8080/jobs/<id>/logs

Expected: the job completed normally and the final log is complete.

## 8. Duplicate submission

Submit the same body twice with the same idempotencyKey.

Expected: identical jobId, "duplicate": true on the second response.

## 9. Job for an unknown agent (known gap)

   curl -s -X POST localhost:8080/jobs -H "Content-Type: application/json" \
     -d '{"agentId":"agent-does-not-exist","image":"alpine:3.19","command":["sh","-c","echo hi"],"idempotencyKey":"fs-unknown"}'

Expected: stays PENDING indefinitely. This is a documented gap — see
docs/NOTES.md.