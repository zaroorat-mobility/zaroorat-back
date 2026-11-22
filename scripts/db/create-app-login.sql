-- Creates (or refreshes) the LOGIN user the API and worker connect as, inside the
-- `zaroorat_app_runtime` group role that migration 20261002130100 creates and grants.
-- Run as the schema owner, after `prisma migrate deploy`:
--
--   APP_DB_PASSWORD=... psql "postgresql://<owner>@<host>:5432/<db>" \
--     -v app_user=zaroorat_app -f scripts/db/create-app-login.sql
--
-- The password is read from the APP_DB_PASSWORD environment variable (psql 15+), so it
-- never appears in a process list or `docker inspect`; `-v app_password=...` still
-- overrides it. It comes from the operator's secret store and is never committed.
-- Idempotent: re-running rotates the password and re-asserts the attributes.
\set ON_ERROR_STOP on

\if :{?app_password}
\else
  \getenv app_password APP_DB_PASSWORD
\endif
\if :{?app_password}
\else
  -- An error, not \quit: with ON_ERROR_STOP it exits non-zero, so `make migrate-prod` stops.
  DO $$ BEGIN RAISE EXCEPTION 'APP_DB_PASSWORD is not set: refusing to create a login without a password'; END $$;
\endif
\if :{?app_user}
\else
  \set app_user zaroorat_app
\endif

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L IN ROLE zaroorat_app_runtime',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- Whatever the user was before, it ends as a plain login with nothing but the group's
-- privileges: no superuser, no role or database creation, no replication, no RLS bypass.
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
  :'app_user', :'app_password'
)
\gexec

SELECT format('GRANT zaroorat_app_runtime TO %I', :'app_user')
\gexec
