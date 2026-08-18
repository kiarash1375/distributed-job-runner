export type JobStatus =
  | "PENDING"
  | "DISPATCHED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT";

export const TERMINAL_STATES: JobStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
];

export const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  PENDING: ["DISPATCHED"],
  DISPATCHED: ["RUNNING", "FAILED", "PENDING"],
  RUNNING: ["SUCCEEDED", "FAILED", "TIMED_OUT"],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
};

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface Job {
  id: string;
  agent_id: string;
  image: string;
  command: string[];
  timeout_seconds: number;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  status: JobStatus;
  exit_code: number | null;
  error_message: string | null;
  container_id: string | null;
  created_at: string;
  updated_at: string;
}