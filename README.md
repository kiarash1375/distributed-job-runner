# Distributed Job Runner

Submit a command via HTTP; it runs as a Docker container on a specific remote
agent. Job state, results, and logs survive restarts of every component.

The central gateway cannot open connections to agents — agents dial out to the
gateway and hold a WebSocket open. Jobs for a disconnected agent wait in
PostgreSQL and are delivered when that agent reconnects.

## Architecture

Three processes and a database:

- **Gateway** — HTTP API for users, WebSocket hub for agents. Owns all state,
  never touches Docker.
- **Agent** — run once per environment. Dials out to the gateway, creates
  containers, streams logs, reports results. Owns no state.
- **PostgreSQL** — the source of truth. The WebSocket is only transport.

Everything durable is in Postgres. The map of connected agents lives in gateway
memory and rebuilds itself when agents reconnect.

## Requirements

- Node.js 18+
- Docker with Compose
- Git

## Running it

```bash
git clone https://github.com/kiarash1375/distributed-job-runner.git
cd distributed-job-runner
npm install
cp .env.example .env
docker compose up -d
docker compose exec -T postgres psql -U jobrunner -d jobrunner < db/schema.sql
```

Then start three processes, each in its own terminal:

```bash
npm run gateway
```
```bash
AGENT_ID=agent-a npm run agent
```
```bash
AGENT_ID=agent-b npm run agent
```

Verify both agents are connected:

```bash
curl localhost:8080/agents
```

## Submitting a job

```bash
curl -X POST localhost:8080/jobs -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent-a",
    "image": "alpine:3.19",
    "command": ["sh", "-c", "echo hello"],
    "timeoutSeconds": 60,
    "idempotencyKey": "example-1",
    "metadata": {}
  }'
```

Returns `202 Accepted` with a `jobId`. The connection closes immediately; the job
runs asynchronously.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/jobs` | Submit a job. Returns `jobId`. |
| `GET` | `/jobs` | List jobs. Optional `agentId`, `status`, `limit`. |
| `GET` | `/jobs/:id` | Job details and current status. |
| `GET` | `/jobs/:id/result` | Exit code and error message. |
| `GET` | `/jobs/:id/logs` | Full log, plain text. |
| `GET` | `/jobs/:id/logs/stream` | Live log via SSE. |
| `GET` | `/agents` | Currently connected agents. |
| `GET` | `/health` | Liveness, including database. |

Resubmitting with the same `idempotencyKey` returns the original `jobId` and
does not create a second job.

## Job states

PENDING -> DISPATCHED -> RUNNING -> SUCCEEDED | FAILED | TIMED_OUT


`DISPATCHED` can return to `PENDING` if the agent disconnects before starting the
container, which makes delivery at-least-once. Terminal states never change; a
late result for a finished job is rejected and logged.

## Failure scenarios

Reproducible demonstrations, with commands, are in
[docs/NOTES.md](docs/NOTES.md): agent offline before dispatch, agent restart
mid-job, orphan container cleanup, gateway restart, database restart, duplicate
submission, and live viewer disconnection.

## Documentation

- [docs/NOTES.md](docs/NOTES.md) — verified behaviour, trade-offs, known gaps, bugs found and fixed
- [docs/SETUP.md](docs/SETUP.md) — environment setup from scratch
- [AI_USAGE.md](AI_USAGE.md) — how AI tools were used