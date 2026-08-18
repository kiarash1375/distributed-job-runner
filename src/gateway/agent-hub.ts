import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { logger, childLogger } from "../shared/logger";
import {
  registerAgent,
  unregisterAgent,
  touchAgent,
  sendToAgent,
  reapStaleConnections,
} from "./agent-registry";
import { findPendingJobsForAgent, transitionJob } from "./jobs-repo";
import { appendLogChunk } from "./logs-repo";

export function attachAgentHub(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/agent" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const agentId = url.searchParams.get("agentId");

    if (!agentId) {
      logger.warn("agent connection rejected: missing agentId");
      socket.close(4001, "agentId required");
      return;
    }

    const log = childLogger({ agentId });
    registerAgent(agentId, socket);

    socket.on("message", async (raw) => {
      touchAgent(agentId);
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        log.warn("received non-json message");
        return;
      }

      try {
        await handleAgentMessage(agentId, msg, log);
      } catch (err: any) {
        log.error({ err: err.message, type: msg?.type }, "error handling agent message");
      }
    });

    socket.on("close", () => unregisterAgent(agentId, socket));
    socket.on("error", (err) => log.error({ err: err.message }, "agent socket error"));

    deliverPendingJobs(agentId).catch((err) =>
      log.error({ err: err.message }, "failed to deliver pending jobs")
    );
  });

  setInterval(() => reapStaleConnections(), 20000);
  logger.info("agent websocket hub attached at /agent");
}

async function handleAgentMessage(agentId: string, msg: any, log: any) {
  switch (msg.type) {
    case "HEARTBEAT":
      return;

    case "JOB_ACCEPTED":
      await transitionJob(msg.jobId, "DISPATCHED", { agentId });
      return;

    case "JOB_RUNNING":
      await transitionJob(msg.jobId, "RUNNING", {
        containerId: msg.containerId,
      });
      return;

    case "JOB_LOG":
      await appendLogChunk(msg.jobId, msg.seq, msg.stream, msg.content);
      return;

    case "JOB_RESULT": {
      const status =
        msg.timedOut === true
          ? "TIMED_OUT"
          : msg.exitCode === 0
          ? "SUCCEEDED"
          : "FAILED";
      await transitionJob(msg.jobId, status, {
        exitCode: msg.exitCode,
        errorMessage: msg.errorMessage ?? null,
      });
      return;
    }

    default:
      log.warn({ type: msg.type }, "unknown message type from agent");
  }
}

export async function deliverPendingJobs(agentId: string): Promise<void> {
  const jobs = await findPendingJobsForAgent(agentId);
  for (const job of jobs) {
    const sent = sendToAgent(agentId, { type: "JOB_ASSIGN", job });
    if (!sent) {
      logger.warn({ jobId: job.id, agentId }, "could not deliver job, will retry on reconnect");
      break;
    }
  }
}