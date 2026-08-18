import { pool } from "./db";

export async function appendLogChunk(
  jobId: string,
  seq: number,
  stream: string,
  content: string
): Promise<void> {
  await pool.query(
    `INSERT INTO job_log_chunks (job_id, seq, stream, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_id, seq) DO NOTHING`,
    [jobId, seq, stream, content]
  );
}

export async function getFullLog(jobId: string): Promise<string> {
  const result = await pool.query(
    `SELECT content FROM job_log_chunks WHERE job_id = $1 ORDER BY seq ASC`,
    [jobId]
  );
  return result.rows.map((r) => r.content).join("");
}