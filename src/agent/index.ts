import WebSocket from "ws";
import Docker from "dockerode";
import { config } from "../shared/config";
import { childLogger } from "../shared/logger";

const log = childLogger({ agentId: config.agentId });
const docker = new Docker({ socketPath: config.dockerSocket });

let socket: WebSocket | null = null;
let reconnectDelay = 1000;
const running = new Map<string, { containerId: string; timer: NodeJS.Timeout }>();

function send(message: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function connect(): void {
  const url = `${config.gatewayWsUrl}?agentId=${encodeURIComponent(config.agentId)}`;
  log.info({ url }, "connecting to gateway");

  socket = new WebSocket(url);

  socket.on("open", () => {
    log.info("connected to gateway");
    reconnectDelay = 1000;
    send({ type: "RECONCILE_REQUEST" });
  });

  socket.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "JOB_ASSIGN") {
      send({ type: "JOB_ACCEPTED", jobId: msg.job.id });
      runJob(msg.job).catch((err) =>
        log.error({ jobId: msg.job.id, err: err.message }, "job execution failed")
      );
    }
    if (msg.type === "RECONCILE_RESPONSE") {
      reconcile(msg.jobs).catch((err) =>
        log.error({ err: err.message }, "reconciliation failed")
      );
    }
  });

  socket.on("close", () => {
    log.warn({ retryInMs: reconnectDelay }, "disconnected from gateway");
    socket = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  socket.on("error", (err) => log.error({ err: err.message }, "socket error"));
}

setInterval(() => send({ type: "HEARTBEAT" }), 15000);

async function runJob(job: any): Promise<void> {
  const jobLog = childLogger({ agentId: config.agentId, jobId: job.id });
  let seq = 0;
  let timedOut = false;

  try {
    
    
    const pullStart = Date.now();
    jobLog.info({ image: job.image }, "pulling image");
    await pullImage(job.image);
    jobLog.info({ image: job.image, ms: Date.now() - pullStart }, "image ready");

    const createStart = Date.now();

    const container = await docker.createContainer({
      Image: job.image,
      Cmd: job.command,
      Labels: {
        "jobrunner.job-id": job.id,
        "jobrunner.agent-id": config.agentId,
      },
      HostConfig: { AutoRemove: false },
    });

    running.set(job.id, { containerId: container.id, timer: null as any });
    send({ type: "JOB_RUNNING", jobId: job.id, containerId: container.id });

    await container.start();

    jobLog.info(
      { containerId: container.id, ms: Date.now() - createStart },
      "container started"
    );

    attachLogs(container, job.id, jobLog);

    

    const timer = setTimeout(async () => {
      timedOut = true;
      jobLog.warn({ timeoutSeconds: job.timeout_seconds }, "job timed out, killing container");
      try {
        await container.kill();
      } catch {}
    }, job.timeout_seconds * 1000);

    running.set(job.id, { containerId: container.id, timer });

    const result = await container.wait();
    clearTimeout(timer);
    running.delete(job.id);

    send({
      type: "JOB_RESULT",
      jobId: job.id,
      exitCode: result.StatusCode,
      timedOut,
    });
    jobLog.info({ exitCode: result.StatusCode, timedOut }, "job finished");

    await container.remove().catch(() => {});
  } catch (err: any) {
    jobLog.error({ err: err.message }, "job failed");
    running.delete(job.id);
    send({
      type: "JOB_RESULT",
      jobId: job.id,
      exitCode: -1,
      errorMessage: err.message,
    });
  }
}

async function reconcile(activeJobs: any[]): Promise<void> {
  log.info({ count: activeJobs.length }, "starting reconciliation");

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [`jobrunner.agent-id=${config.agentId}`],
    }),
  });

  const byJobId = new Map<string, any>();
  for (const c of containers) {
    const jobId = c.Labels["jobrunner.job-id"];
    if (jobId) byJobId.set(jobId, c);
  }

  const activeIds = new Set(activeJobs.map((j) => j.id));

  for (const [jobId, info] of byJobId) {
    if (activeIds.has(jobId)) continue;
    log.warn({ jobId, containerId: info.Id }, "orphan container, removing");
    try {
      const container = docker.getContainer(info.Id);
      if (info.State === "running") await container.kill();
      await container.remove();
    } catch (err: any) {
      log.error({ jobId, err: err.message }, "failed to remove orphan");
    }
  }

  for (const job of activeJobs) {
    const info = byJobId.get(job.id);
    const jobLog = childLogger({ agentId: config.agentId, jobId: job.id });

    if (!info) {
      jobLog.warn("no container found for active job, releasing for redelivery");
      send({ type: "JOB_RELEASE", jobId: job.id });
      continue;
    }

    const container = docker.getContainer(info.Id);

    if (info.State === "running") {
      jobLog.info({ containerId: info.Id }, "reattaching to running container");
      attachLogs(container, job.id, jobLog);
      container
        .wait()
        .then(async (result: any) => {
          send({
            type: "JOB_RESULT",
            jobId: job.id,
            exitCode: result.StatusCode,
            timedOut: false,
          });
          jobLog.info({ exitCode: result.StatusCode }, "recovered job finished");
          await container.remove().catch(() => {});
        })
        .catch((err: any) =>
          jobLog.error({ err: err.message }, "wait failed on recovered container")
        );
    }      else if (info.State === "created") {
      jobLog.warn(
        { containerId: info.Id },
        "container was created but never started, releasing job for redelivery"
      );
      await container.remove().catch(() => {});
      send({ type: "JOB_RELEASE", jobId: job.id });
    } else {
      const details = await container.inspect();
      const exitCode = details.State.ExitCode;
      jobLog.info({ exitCode }, "recovered exit code from finished container");
      send({ type: "JOB_RESULT", jobId: job.id, exitCode, timedOut: false });
      await container.remove().catch(() => {});
    }
  }
}

function attachLogs(container: any, jobId: string, jobLog: any, startSeq = 0) {
  let seq = startSeq;
  container.logs(
    { follow: true, stdout: true, stderr: true },
    (err: any, stream: any) => {
      if (err) {
        jobLog.error({ err: err.message }, "failed to attach to logs");
        return;
      }
      stream.on("data", (chunk: Buffer) => {
        let offset = 0;
        while (offset + 8 <= chunk.length) {
          const streamType = chunk[offset] === 2 ? "stderr" : "stdout";
          const length = chunk.readUInt32BE(offset + 4);
          const content = chunk
            .slice(offset + 8, offset + 8 + length)
            .toString("utf8");
          if (content.length > 0) {
            send({
              type: "JOB_LOG",
              jobId,
              seq: seq++,
              stream: streamType,
              content,
            });
          }
          offset += 8 + length;
        }
      });
    }
  );
}

async function pullImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // image not present locally, fall through and pull it
  }

  return new Promise((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr: any) =>
        doneErr ? reject(doneErr) : resolve()
      );
    });
  });
}

connect();
log.info("agent started");