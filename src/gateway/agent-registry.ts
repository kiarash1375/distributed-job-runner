import { WebSocket } from "ws";
import { logger } from "../shared/logger";

interface AgentConnection {
  socket: WebSocket;
  agentId: string;
  connectedAt: Date;
  lastSeen: Date;
}

const connections = new Map<string, AgentConnection>();

export function registerAgent(agentId: string, socket: WebSocket): void {
  const existing = connections.get(agentId);
  if (existing) {
    logger.warn({ agentId }, "agent reconnected, closing stale socket");
    try {
      existing.socket.close();
    } catch {}
  }

  connections.set(agentId, {
    socket,
    agentId,
    connectedAt: new Date(),
    lastSeen: new Date(),
  });
  logger.info({ agentId }, "agent connected");
}

export function unregisterAgent(agentId: string, socket: WebSocket): void {
  const existing = connections.get(agentId);
  if (existing && existing.socket === socket) {
    connections.delete(agentId);
    logger.info({ agentId }, "agent disconnected");
  }
}

export function touchAgent(agentId: string): void {
  const conn = connections.get(agentId);
  if (conn) conn.lastSeen = new Date();
}

export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}

export function sendToAgent(agentId: string, message: unknown): boolean {
  const conn = connections.get(agentId);
  if (!conn) return false;
  if (conn.socket.readyState !== WebSocket.OPEN) return false;

  try {
    conn.socket.send(JSON.stringify(message));
    return true;
  } catch (err: any) {
    logger.error({ agentId, err: err.message }, "failed to send to agent");
    return false;
  }
}

export function listConnectedAgents(): string[] {
  return Array.from(connections.keys());
}

export function reapStaleConnections(maxIdleMs = 60000): void {
  const now = Date.now();
  for (const [agentId, conn] of connections) {
    if (now - conn.lastSeen.getTime() > maxIdleMs) {
      logger.warn({ agentId }, "agent heartbeat timeout, dropping connection");
      try {
        conn.socket.terminate();
      } catch {}
      connections.delete(agentId);
    }
  }
}