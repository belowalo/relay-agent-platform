#!/bin/sh
set -eu
app_password=$(cat /run/secrets/app_database_password)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$app_password" <<'SQL'
CREATE ROLE relay_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE relay TO relay_app;
CREATE SCHEMA IF NOT EXISTS relay AUTHORIZATION relay_owner;
GRANT USAGE ON SCHEMA relay TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay GRANT USAGE, SELECT ON SEQUENCES TO relay_app;
SQL
# The owner is privileged only in this single-host reference stack. Never mount its credentials in application containers.
