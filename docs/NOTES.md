# Development Notes

Running log of verified behaviour, decisions made, and known gaps.
Written during development; source material for the final documentation.

---

## Verified behaviour

### Routing between agents

Job submitted for agent-a executed on agent-a only; agent-b stayed idle with both
agents connected simultaneously. Each agent receives only jobs addressed to it.

```bash
curl -X POST localhost:8080/jobs -H "Content-Type: application/json" \
  -d '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","echo hello"],"idempotencyKey":"route-1"}'

curl localhost:8080/agents
```

### Idempotent submission

The same POST body sent twice returns the same jobId with `"duplicate": true`.
Enforced by a partial unique index in Postgres, not an application-level check —
check-then-insert would race under concurrent requests.

```bash
# run this twice and compare the returned jobId
curl -X POST localhost:8080/jobs -H "Content-Type: application/json" \
  -d '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","echo hi"],"idempotencyKey":"test-1"}'
```

### Agent offline before the job arrives

Stopped agent-b, submitted a job for it, job stayed PENDING. Restarted agent-b;
the job was delivered and executed within a second of connection.

Delivery is triggered by the agent connecting, not by a gateway retry loop — the
gateway has no way to dial an agent, so the job simply waits in the database.

```bash
# stop agent-b with Ctrl+C, then:
curl -X POST localhost:8080/jobs -H "Content-Type: application/json" \
  -d '{"agentId":"agent-b","image":"alpine:3.19","command":["sh","-c","echo back"],"idempotencyKey":"offline-1"}'

curl localhost:8080/jobs/1dfa5288-f2af-40a4-a42d-0a6288a7a7db        # PENDING

AGENT_ID=agent-b npm run agent        # job executes on connect

curl localhost:8080/jobs/1dfa5288-f2af-40a4-a42d-0a6288a7a7db        # SUCCEEDED
```

### Gateway restart

Killed the gateway process and restarted it. All jobs and their statuses survived.
The connected-agent list came back empty because it is in-memory; agents reconnect
on their own.

State lives in Postgres; the socket map is a disposable cache.

```bash
# Ctrl+C the gateway, then:
npm run gateway

curl localhost:8080/jobs      # all jobs and statuses intact
curl localhost:8080/agents    # empty until agents reconnect
```

### Postgres restart

`docker compose restart postgres` — jobs survived, because data lives in a named
volume rather than the container filesystem. The running gateway did not crash:
the `pool.on("error")` handler catches the dropped idle connections that would
otherwise surface as an unhandled error and kill the process.

```bash
docker compose restart postgres

curl localhost:8080/jobs
```

---

### Live log streaming

Submitted a job printing one line per second for ten seconds and attached to the
SSE stream while it ran. Lines appeared incrementally rather than in a single
batch at the end.

The stream replays whatever is already stored in `job_log_chunks` before
subscribing to live output, so a viewer attaching mid-job sees the output from the
beginning and then continues live. A viewer attaching to an already-terminal job
gets the full log and an immediate close.

```bash
JOB_ID=$(curl -s -X POST localhost:8080/jobs -H "Content-Type: application/json" \
  -d '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","for i in 1 2 3 4 5 6 7 8 9 10; do echo line $i; sleep 1; done"],"timeoutSeconds":60,"idempotencyKey":"stream-1"}' \
  | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

curl -N localhost:8080/jobs/$JOB_ID/logs/stream
```

### Live viewer disconnecting does not affect the job

Killed the streaming client mid-job with Ctrl+C. The job continued to completion
and the final log was complete when fetched afterwards.

Live delivery and durable storage are separate paths: the agent sends each chunk
once, the gateway publishes it to any in-memory subscribers and independently
writes it to Postgres. With no subscribers the publish step does nothing at all,
so an unwatched job costs nothing on the live path.

```bash
# with the stream above running, press Ctrl+C, then:
curl localhost:8080/jobs/$JOB_ID          # SUCCEEDED
curl localhost:8080/jobs/$JOB_ID/logs     # full log intact
```

## Decisions and trade-offs

### Gateway fails fast on startup

If Postgres is unreachable at boot, the gateway logs the error and exits rather
than starting and serving requests it cannot fulfil.

Trade-off: if the gateway and Postgres restart together and the gateway wins the
race, it dies instead of waiting a second. The alternative — startup retry with
backoff — is more resilient to ordering but hides genuine misconfiguration behind
a minute of retries. Chose fail-fast on the assumption a process supervisor
handles the restart.

### At-least-once delivery

`DISPATCHED -> PENDING` is an allowed transition. If an agent's connection drops
after dispatch but before it confirms anything, we do not know whether it received
the job, so it returns to PENDING and is redelivered on reconnect.

This accepts the risk of a job running twice, in exchange for never silently
losing one. `idempotencyKey` is how callers protect themselves against the
duplicate case.

### Containers are not auto-removed

`AutoRemove: false` on container creation. If the agent crashes between the
container exiting and the result being reported, the exited container is the only
surviving evidence of the exit code. Auto-removal would destroy it and make that
recovery impossible.

Cost: containers accumulate and need explicit cleanup.

### TypeScript with strict mode off

Deliberate concession to the time budget. Strict mode catches more bugs but
requires satisfying the type checker constantly, which is expensive while learning
the language. Would enable it for anything longer-lived.

---

### Backpressure: drop the viewer, protect the pipeline

If writing to a live subscriber fails, that subscriber is removed rather than
retried or buffered. A slow or dead viewer must never block job execution or the
other viewers.

Nothing is actually lost: the durable path already holds every chunk, so a dropped
viewer can fetch the complete log afterwards. The alternative — buffering per
subscriber — trades unbounded memory growth for a marginally better live
experience, which is the wrong trade when a complete log is one request away.

### SSE rather than WebSocket for live logs

The viewer never sends anything, so a one-directional transport fits. SSE runs over
plain HTTP, works with `curl`, and reconnects automatically in browsers without a
client library. A WebSocket would work but adds bidirectionality that this path has
no use for.

## Known gaps

### Jobs for a non-existent agent pend forever

The gateway cannot distinguish "agent is offline" from "agent never existed" —
both look like a missing entry in the socket map. A job submitted for `agent-zzz`
stays PENDING indefinitely: it will never run, never fail, never be cleaned up.

Fix: an `expires_at` column plus a periodic sweep that fails undispatched jobs
past their deadline. Also considered: an `agents` table so unknown agent IDs are
rejected at submission time — though that would mean an agent must connect once
before it can be targeted.

Not implemented due to time.

### Agents are not authenticated

An agent identifies itself with a query-string parameter on connect. Anything that
can reach the gateway can claim to be `agent-a` and receive its jobs. Acceptable
for a local demo, not for a real deployment.

Fix: a per-agent token verified on connect, and `wss://` rather than `ws://` so
credentials and job output are not sent in plaintext.

### Result loss window

If the gateway dies after an agent sends `JOB_RESULT` but before the transaction
commits, the result is lost and the job stays RUNNING forever.

Fix: the agent should treat a result as unacknowledged until the gateway confirms
it, and resend on reconnect. The `job_log_chunks` table already handles duplicate
delivery via `ON CONFLICT DO NOTHING`; results would need equivalent handling,
which the state machine's terminal-state rule mostly provides already.

### stdout and stderr are not distinguished

Docker's attach stream multiplexes both, with a header byte identifying which. The
agent currently strips the 8-byte header and labels everything `stdout`. The
`job_log_chunks` table has a `stream` column ready for the correct value.

### Single gateway instance assumed

Agent sockets live in the memory of one gateway process. With several gateway
instances behind a load balancer, a user request could land on an instance that
does not hold the target agent's socket, and dispatch would fail.

Fix: a shared pub/sub layer between gateway instances, or a message broker with a
per-agent queue that any instance can publish to. This is the strongest argument
for introducing a broker, which is otherwise unnecessary at this scale.

---

### Replay/subscribe race in the log stream

The SSE endpoint queries stored chunks and then subscribes to live output. A chunk
arriving between those two operations would be missed by that viewer.

Fix: subscribe first and buffer, then replay stored chunks and de-duplicate against
the buffer by sequence number. The final log is unaffected — this only affects what
a single live viewer sees.

## Environment problems hit during setup

- WSL2 install failed with `0x80370102` until virtualization was enabled in BIOS.
- Docker CLI inside WSL failed with `docker-credential-desktop.exe: exec format
  error` — Docker Desktop writes a Windows credential helper path into
  `~/.docker/config.json` that Linux cannot execute. Fixed by emptying the file.
- DNS resolution inside WSL failed (`Temporary failure resolving`); fixed by
  writing a static `/etc/resolv.conf` and disabling WSL's auto-generation.