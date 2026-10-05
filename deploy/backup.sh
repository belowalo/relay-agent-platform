#!/bin/sh
set -eu
# Install root-owned with a private environment file, secret mounts and off-host copy command.
# flock prevents overlapping scheduled and manual backups.
exec 9>/run/lock/relay-backup.lock
flock -n 9 || exit 1
cd /opt/relay
compose() { docker compose --env-file /etc/relay/production.env -f deploy/compose.production.yaml "$@"; }
resume() { compose up -d api worker; }
trap resume EXIT INT TERM
compose stop api worker
name="snapshot-$(date -u +%Y%m%dT%H%M%SZ).relay-backup"
compose run --rm -e BACKUP_QUIESCED=true backup create "$name"
compose run --rm backup verify "$name"
# Site-specific command MUST upload the encrypted archive and checksum to independent storage.
# It must exit nonzero on failure, keep BACKUP_KEY in a separate escrow, and update monitoring only after upload verification.
/etc/relay/copy-backup-offhost "$name"
