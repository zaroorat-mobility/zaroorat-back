-- LOCAL and TEST clusters only (server stacks never mount this directory).
-- Idempotent: compose.local.yml already creates zaroorat_local through POSTGRES_DB, and a
-- plain CREATE DATABASE for it aborted the whole init (ON_ERROR_STOP) on a fresh volume.
SELECT 'CREATE DATABASE zaroorat_local'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zaroorat_local')\gexec
SELECT 'CREATE DATABASE zaroorat_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zaroorat_test')\gexec
