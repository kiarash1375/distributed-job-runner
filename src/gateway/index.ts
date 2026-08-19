import Fastify from "fastify";
import { config } from "../shared/config";
import { logger } from "../shared/logger";
import { pool } from "./db";
import { createJob, getJob, listJobs } from "./jobs-repo";
import { attachAgentHub } from "./agent-hub";
import { deliverPendingJobs } from "./agent-hub";
import { isAgentConnected, listConnectedAgents } from "./agent-registry";
import { getFullLog } from "./logs-repo";
import { subscribe } from "./log-stream";
import { getFullLog } from "./logs-repo";
import { isTerminal } from "../shared/types";
import { randomUUID } from "crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = Fastify({ logger: false });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

app.post("/jobs", async (request, reply) => {
  const body = request.body as any;

  if (!body?.agentId || typeof body.agentId !== "string") {
    return reply.code(400).send({ error: "agentId is required" });
  }
  if (!body?.image || typeof body.image !== "string") {
    return reply.code(400).send({ error: "image is required" });
  }
  if (!Array.isArray(body.command) || body.command.length === 0) {
    return reply.code(400).send({ error: "command must be a non-empty array" });
  }

  const correlationId = (request.headers["x-correlation-id"] as string) ?? randomUUID();

  const metadata = { ...(body.metadata ?? {}), correlationId };

  const { job, created } = await createJob({
    agentId: body.agentId,
    image: body.image,
    command: body.command,
    timeoutSeconds: body.timeoutSeconds,
    idempotencyKey: body.idempotencyKey,
    metadata: metadata,
  });

  logger.info(
    { correlationId, jobId: job.id, agentId: job.agent_id, duplicate: !created },
    "job submitted"
  );

  if (created && isAgentConnected(job.agent_id)) {
    deliverPendingJobs(job.agent_id).catch(() => {});
  }

  return reply.code(created ? 202 : 200).send({
    jobId: job.id,
    status: job.status,
    duplicate: !created,
  });
});

app.get("/jobs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!UUID_PATTERN.test(id)) {
    return reply.code(400).send({ error: "invalid job id format" });
  }

  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: "job not found" });

  return {
    jobId: job.id,
    agentId: job.agent_id,
    image: job.image,
    command: job.command,
    timeoutSeconds: job.timeout_seconds,
    metadata: job.metadata,
    status: job.status,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
});

app.get("/jobs/:id/result", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!UUID_PATTERN.test(id)) {
    return reply.code(400).send({ error: "invalid job id format" });
  }

  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: "job not found" });

  return {
    jobId: job.id,
    status: job.status,
    exitCode: job.exit_code,
    errorMessage: job.error_message,
  };
});

app.get("/jobs", async (request) => {
  const query = request.query as any;
  const jobs = await listJobs({
    agentId: query.agentId,
    status: query.status,
    limit: query.limit ? Number(query.limit) : undefined,
  });
  return { jobs: jobs.map((j) => ({ jobId: j.id, agentId: j.agent_id, status: j.status })) };
});

app.get("/agents", async () => {
  return { agents: listConnectedAgents() };
});

app.get("/jobs/:id/logs", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!UUID_PATTERN.test(id)) {
    return reply.code(400).send({ error: "invalid job id format" });
  }
  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: "job not found" });

  const log = await getFullLog(id);
  return reply.type("text/plain").send(log);
});

app.get("/jobs/:id/logs/stream", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!UUID_PATTERN.test(id)) {
    return reply.code(400).send({ error: "invalid job id format" });
  }

  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: "job not found" });

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      reply.raw.write(`data: ${line}\n`);
    }
    reply.raw.write("\n");
  };

  const existing = await getFullLog(id);
  if (existing.length > 0) send(existing);

  if (isTerminal(job.status)) {
    reply.raw.write(`data: --- job ${job.status} ---\n\n`);
    reply.raw.end();
    return;
  }

  const unsubscribe = subscribe(id, {
    write: send,
    dropped: 0,
  });

  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(": keep-alive\n\n");
    } catch {}
  }, 15000);

  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

async function start() {
  try {
    await pool.query("SELECT 1");
    logger.info("database connection verified");
    await app.listen({ port: config.gatewayPort, host: "0.0.0.0" });
    attachAgentHub(app.server);
    logger.info({ port: config.gatewayPort }, "gateway listening");
  } catch (err: any) {
    logger.error({ err: err.message }, "gateway failed to start");
    process.exit(1);
  }
}

start();