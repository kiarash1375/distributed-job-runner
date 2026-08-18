import * as dotenv from "dotenv";

dotenv.config();

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://jobrunner:jobrunner@localhost:5432/jobrunner",
  gatewayPort: Number(process.env.GATEWAY_PORT ?? 8080),
  gatewayWsUrl: process.env.GATEWAY_WS_URL ?? "ws://localhost:8080/agent",
  agentId: process.env.AGENT_ID ?? "agent-a",
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  logLevel: process.env.LOG_LEVEL ?? "info",
};