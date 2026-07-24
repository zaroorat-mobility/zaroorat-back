# Postgres Docker Setup

This directory contains scripts, configurations, and utilities for the PostgreSQL database container.

## Directory Structure

- **`init/`**: Contains initialization scripts (`*.sql`, `*.sh`). These scripts run automatically when the database container is created for the first time. They are mounted to `/docker-entrypoint-initdb.d/` in the container.
- **`config/`**: A place to store custom PostgreSQL configuration files (`postgresql.conf`, `pg_hba.conf`). To use them, you will need to add a volume mapping in `docker-compose.yml` to mount this folder to `/etc/postgresql/postgresql.conf` and update the database command.
- **`backups/`**: A designated folder to dump database backups. You can add a volume binding to keep backups persistent on the host.
- **`scripts/`**: Useful bash scripts for database management, such as manual backup scripts, restore scripts, or database reset utilities.

## How Initialization Works

When you run `docker compose up -d` (or `make up`), the `postgres` service starts. If the data directory (`postgres_data` volume) is empty, Postgres will execute all scripts inside the `init/` folder in alphabetical order.

> [!NOTE]
> If you add new scripts to `init/` after the container has been initialized, they will **not** automatically run. You must either destroy the `postgres_data` volume or execute them manually.

To recreate the volume and trigger initialization again:

```bash
docker compose down -v
docker compose up -d
```

## Backup & Restore Workflow

The `scripts/` directory contains `backup.sh` and `restore.sh` to automate saving and recovering your database using custom-compressed formats.

### Taking a Backup

To export the database (tables, indexes, constraints, views, etc.), run:

```bash
./docker/postgres/scripts/backup.sh [database_name]
```

_(If no database is provided, it defaults to `zaroorat_dev`)_

**Why we use `pg_dump -Fc`:**
Instead of plain SQL, these scripts use PostgreSQL's custom format (`-Fc`). This ensures the backup is **compressed, smaller, faster**, and allows for selective or parallel restores.

Each backup is saved in `docker/postgres/backups/` and is uniquely timestamped (e.g. `zaroorat_dev_2026-07-24_15-10.dump`), ensuring you retain a full history of your database state without overwriting past backups.

### Restoring a Backup

If a disaster happens (like an accidental `DROP TABLE`), you can seamlessly restore the database:

```bash
./docker/postgres/scripts/restore.sh docker/postgres/backups/<filename>.dump [database_name]
```

**How the restore script works:**

1. **Drops Existing Objects (`--clean`):** The script automatically drops conflicting tables/objects before recreating them, ensuring the restored database is identical to the backup without throwing "table already exists" errors.
2. **Single Transaction (`--single-transaction`):** The entire restoration runs in a single transaction. If an error occurs halfway through, the database rolls back to its pre-restore state, protecting you from a corrupted, half-restored database.

### Typical Development Workflow

1. Start Docker: `docker compose up -d`
2. Work on your application and insert data.
3. Take a backup: `./docker/postgres/scripts/backup.sh`
4. Experiment (run migrations, drop tables, etc).
5. If something breaks, restore it: `./docker/postgres/scripts/restore.sh docker/postgres/backups/...`
