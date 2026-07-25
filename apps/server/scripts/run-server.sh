#!/bin/sh
set -eu

provider="$(printf "%s" "${HAPPIER_DB_PROVIDER:-${HAPPY_DB_PROVIDER:-postgres}}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
flavor="$(printf "%s" "${HAPPIER_SERVER_FLAVOR:-${HAPPY_SERVER_FLAVOR:-full}}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
start_script="start"
if [ "$flavor" = "light" ]; then
  start_script="start:light"
fi
schema="prisma/schema.prisma"
should_migrate="1"
case "$provider" in
  ""|"postgres"|"postgresql") schema="prisma/schema.prisma" ;;
  "mysql") schema="prisma/mysql/schema.prisma" ;;
  "sqlite") schema="prisma/sqlite/schema.prisma" ;;
  "pglite") should_migrate="0" ;;
  *)
    echo "[entrypoint] Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER: $provider"
    exit 1
    ;;
esac

if [ "$provider" = "sqlite" ]; then
  if [ -z "${DATABASE_URL:-}" ] || [ -z "$(printf "%s" "$DATABASE_URL" | tr -d '[:space:]')" ]; then
    data_dir="$(printf "%s" "${HAPPIER_SERVER_LIGHT_DATA_DIR:-${HAPPY_SERVER_LIGHT_DATA_DIR:-}}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "$data_dir" ]; then
      echo "[entrypoint] Missing HAPPIER_SERVER_LIGHT_DATA_DIR/HAPPY_SERVER_LIGHT_DATA_DIR (required to derive sqlite DATABASE_URL)"
      exit 1
    fi
    sqlite_busy_timeout_ms="$(printf "%s" "${HAPPIER_SQLITE_BUSY_TIMEOUT_MS:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "$sqlite_busy_timeout_ms" ]; then
      sqlite_busy_timeout_ms="$(printf "%s" "${HAPPY_SQLITE_BUSY_TIMEOUT_MS:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    fi
    if [ -z "$sqlite_busy_timeout_ms" ]; then
      sqlite_busy_timeout_ms="30000"
    fi
    case "$sqlite_busy_timeout_ms" in
      ""|*[!0-9]*)
        echo "[entrypoint] Invalid HAPPIER_SQLITE_BUSY_TIMEOUT_MS/HAPPY_SQLITE_BUSY_TIMEOUT_MS: $sqlite_busy_timeout_ms"
        exit 1
        ;;
    esac
    if [ "$sqlite_busy_timeout_ms" -gt 600000 ]; then
      echo "[entrypoint] Invalid HAPPIER_SQLITE_BUSY_TIMEOUT_MS/HAPPY_SQLITE_BUSY_TIMEOUT_MS: $sqlite_busy_timeout_ms"
      exit 1
    fi

    sqlite_query=""
    if [ "$sqlite_busy_timeout_ms" -gt 0 ]; then
      sqlite_socket_timeout_seconds=$(( (sqlite_busy_timeout_ms + 999) / 1000 ))
      sqlite_query="socket_timeout=${sqlite_socket_timeout_seconds}"
    fi

    sqlite_connection_limit="$(printf "%s" "${HAPPIER_SQLITE_CONNECTION_LIMIT:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "$sqlite_connection_limit" ]; then
      sqlite_connection_limit="$(printf "%s" "${HAPPY_SQLITE_CONNECTION_LIMIT:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    fi
    if [ -z "$sqlite_connection_limit" ]; then
      sqlite_connection_limit="1"
    fi
    if [ -n "$sqlite_connection_limit" ]; then
      case "$sqlite_connection_limit" in
        *[!0-9]*)
          echo "[entrypoint] Invalid HAPPIER_SQLITE_CONNECTION_LIMIT/HAPPY_SQLITE_CONNECTION_LIMIT: $sqlite_connection_limit"
          exit 1
          ;;
      esac
      if [ "$sqlite_connection_limit" -lt 1 ] || [ "$sqlite_connection_limit" -gt 64 ]; then
        echo "[entrypoint] Invalid HAPPIER_SQLITE_CONNECTION_LIMIT/HAPPY_SQLITE_CONNECTION_LIMIT: $sqlite_connection_limit"
        exit 1
      fi
      if [ -n "$sqlite_query" ]; then
        sqlite_query="${sqlite_query}&"
      fi
      sqlite_query="${sqlite_query}connection_limit=${sqlite_connection_limit}"
    fi

    DATABASE_URL="file:${data_dir%/}/happier-server-light.sqlite"
    if [ -n "$sqlite_query" ]; then
      DATABASE_URL="${DATABASE_URL}?${sqlite_query}"
    fi
    export DATABASE_URL
  fi
fi

if [ "$should_migrate" = "1" ] && [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
  attempts="${MIGRATIONS_MAX_ATTEMPTS:-30}"
  delay="${MIGRATIONS_RETRY_DELAY_SECONDS:-2}"

  i=1
  while [ "$i" -le "$attempts" ]; do
    if [ "$provider" = "sqlite" ]; then
      migration_command="migrate:sqlite:deploy"
    else
      migration_command="prisma migrate deploy --schema $schema"
    fi
    echo "[entrypoint] Running ${migration_command} (${provider}) (attempt $i/$attempts)..."

    if [ "$provider" = "sqlite" ]; then
      out="$(yarn --cwd apps/server migrate:sqlite:deploy 2>&1)" && status=0 || status=$?
    else
      out="$(yarn --cwd apps/server prisma migrate deploy --schema "$schema" 2>&1)" && status=0 || status=$?
    fi
    if [ "$status" -eq 0 ]; then
      printf "%s\n" "$out"
      break
    fi
    printf "%s\n" "$out"

    if [ "$provider" = "postgres" ] || [ "$provider" = "postgresql" ]; then
      if echo "$out" | grep -q "Timed out trying to acquire a postgres advisory lock"; then
      echo "[entrypoint] Advisory lock timeout; retrying in ${delay}s..."
      sleep "$delay"
      i=$((i + 1))
      continue
      fi
    fi

    echo "[entrypoint] Migration failed."
    exit "$status"
  done

  if [ "$i" -gt "$attempts" ]; then
    echo "[entrypoint] Migrations failed after ${attempts} attempts."
    exit 1
  fi
fi

exec yarn --cwd apps/server "$start_script"
