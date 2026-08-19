#!/usr/bin/env bash
# End-to-end demo: routing, idempotency, live logs, final logs.
# Prerequisites: gateway running, agent-a and agent-b running.
set -e

GW=${GATEWAY_URL:-http://localhost:8080}

submit() {
  curl -s -X POST "$GW/jobs" -H "Content-Type: application/json" -d "$1"
}

job_id() {
  echo "$1" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4
}

wait_terminal() {
  for _ in $(seq 1 60); do
    S=$(curl -s "$GW/jobs/$1" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    case "$S" in SUCCEEDED|FAILED|TIMED_OUT) echo "$S"; return;; esac
    sleep 1
  done
  echo "TIMEOUT_WAITING"
}

echo "== connected agents =="
curl -s "$GW/agents"; echo

echo
echo "== 1. routing: job for agent-a =="
R=$(submit '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","echo hello from agent A"],"idempotencyKey":"demo-route-a"}')
A=$(job_id "$R"); echo "jobId=$A"
echo "final state: $(wait_terminal "$A")"
echo "log: $(curl -s "$GW/jobs/$A/logs")"

echo
echo "== 2. routing: job for agent-b =="
R=$(submit '{"agentId":"agent-b","image":"alpine:3.19","command":["sh","-c","echo hello from agent B"],"idempotencyKey":"demo-route-b"}')
B=$(job_id "$R"); echo "jobId=$B"
echo "final state: $(wait_terminal "$B")"
echo "log: $(curl -s "$GW/jobs/$B/logs")"

echo
echo "== 3. idempotency: same key resubmitted =="
R2=$(submit '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","echo hello from agent A"],"idempotencyKey":"demo-route-a"}')
echo "$R2"
[ "$(job_id "$R2")" = "$A" ] && echo "PASS: same jobId returned" || echo "FAIL: different jobId"

echo
echo "== 4. failing job: non-zero exit code =="
R=$(submit '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","echo failing; exit 3"],"idempotencyKey":"demo-fail"}')
F=$(job_id "$R")
echo "final state: $(wait_terminal "$F")"
curl -s "$GW/jobs/$F/result"; echo

echo
echo "== 5. timeout =="
R=$(submit '{"agentId":"agent-a","image":"alpine:3.19","command":["sh","-c","sleep 60"],"timeoutSeconds":5,"idempotencyKey":"demo-timeout"}')
T=$(job_id "$R")
echo "final state: $(wait_terminal "$T")"

echo
echo "== 6. live log stream (10s) =="
R=$(submit '{"agentId":"agent-b","image":"alpine:3.19","command":["sh","-c","for i in 1 2 3 4 5 6 7 8 9 10; do echo line $i; sleep 1; done"],"timeoutSeconds":60,"idempotencyKey":"demo-stream"}')
L=$(job_id "$R")
curl -N -s "$GW/jobs/$L/logs/stream"

echo
echo "== all jobs =="
curl -s "$GW/jobs"; echo