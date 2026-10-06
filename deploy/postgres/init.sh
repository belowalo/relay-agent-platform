#!/bin/sh
set -eu
app_password=$(cat /run/secrets/app_database_password)
identity_password=$(cat /run/secrets/identity_database_password)
rate_password=$(cat /run/secrets/rate_database_password)
dispatch_password=$(cat /run/secrets/dispatch_database_password)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_password="$app_password" -v identity_password="$identity_password" -v rate_password="$rate_password" -v dispatch_password="$dispatch_password" <<'SQL'
CREATE ROLE relay_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_identity LOGIN PASSWORD :'identity_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_rate LOGIN PASSWORD :'rate_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE relay_dispatch LOGIN PASSWORD :'dispatch_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE relay TO relay_app,relay_identity,relay_rate,relay_dispatch;
CREATE SCHEMA IF NOT EXISTS relay AUTHORIZATION relay_owner;
GRANT USAGE ON SCHEMA relay TO relay_app;
SQL
# The owner is privileged only in this single-host reference stack. Never mount its credentials in application containers.
