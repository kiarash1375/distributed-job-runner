import { randomUUID } from "crypto";
import { pool } from "./db";
import { Job, JobStatus, canTransition } from "../shared/types";
import { logger } from "../shared/logger";

export interface CreateJobInput {
  agentId: string;
  image: string;
  command: string[];
  timeoutSeconds?: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export async function createJob(
  input: CreateJobInput
): Promise<{ job: Job; created: boolean }> {
  const id = randomUUID();

  try {
    const result = await pool.query(
      `INSERT INTO jobs (id, agent_id, image, command, timeout_seconds, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.agentId,
        input.image,
        input.command,
        input.timeoutSeconds ?? 300,
        input.idempotencyKey ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return { job: result.rows[0], created: true };
  } catch (err: any) {
    if (err.code === "23505" && input.idempotencyKey) {
      const existing = await pool.query(
        `SELECT * FROM jobs WHERE idempotency_key = $1`,
        [input.idempotencyKey]
      );
      logger.info(
        { idempotencyKey: input.idempotencyKey, jobId: existing.rows[0].id },
        "duplicate idempotency key, returning existing job"
      );
      return { job: existing.rows[0], created: false };
    }
    throw err;
  }
}

export async function getJob(id: string): Promise<Job | null> {
  const result = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listJobs(filters: {
  agentId?: string;
  status?: string;
  limit?: number;
}): Promise<Job[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  if (filters.agentId) {
    values.push(filters.agentId);
    conditions.push(`agent_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(filters.limit ?? 50);

  const result = await pool.query(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${values.length}`,
    values
  );
  return result.rows;
}

export async function findPendingJobsForAgent(agentId: string): Promise<Job[]> {
  const result = await pool.query(
    `SELECT * FROM jobs WHERE agent_id = $1 AND status = 'PENDING' ORDER BY created_at ASC`,
    [agentId]
  );
  return result.rows;
}

export async function transitionJob(
  jobId: string,
  to: JobStatus,
  detail: Record<string, unknown> = {}
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT status FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId]
    );

    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const from: JobStatus = current.rows[0].status;

    if (from === to) {
      await client.query("COMMIT");
      logger.debug({ jobId, state: to }, "duplicate transition ignored");
      return true;
    }

    if (!canTransition(from, to)) {
      await client.query("ROLLBACK");
      logger.warn({ jobId, from, to }, "illegal transition rejected");
      return false;
    }

    await client.query(
      `UPDATE jobs
         SET status = $2,
             exit_code = COALESCE($3, exit_code),
             error_message = COALESCE($4, error_message),
             container_id = COALESCE($5, container_id),
             updated_at = now()
       WHERE id = $1`,
      [
        jobId,
        to,
        detail.exitCode ?? null,
        detail.errorMessage ?? null,
        detail.containerId ?? null,
      ]
    );

    await client.query(
      `INSERT INTO job_events (job_id, from_state, to_state, detail)
       VALUES ($1, $2, $3, $4)`,
      [jobId, from, to, JSON.stringify(detail)]
    );

    await client.query("COMMIT");
    logger.info({ jobId, from, to }, "job transitioned");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}