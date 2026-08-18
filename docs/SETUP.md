# Setup

## Requirements
- Node.js 18+
- Docker (with docker compose)
- Git

## Steps

1. Clone and install dependencies:
   git clone <repo-url>
   cd distributed-job-runner
   npm install

2. Create your environment file:
   cp .env.example .env

3. Start PostgreSQL:
   docker compose up -d

4. Load the database schema:
   docker compose exec -T postgres psql -U jobrunner -d jobrunner < db/schema.sql

5. Verify the tables exist:
   docker compose exec postgres psql -U jobrunner -d jobrunner -c "\dt"
   Expected: jobs, job_log_chunks, job_events