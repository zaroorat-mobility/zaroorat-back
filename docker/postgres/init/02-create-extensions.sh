#!/bin/bash
set -e

echo "Creating extensions in zaroorat_dev..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "zaroorat_dev" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS "postgis";
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL

echo "Creating extensions in zaroorat_test..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "zaroorat_test" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS "postgis";
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL
