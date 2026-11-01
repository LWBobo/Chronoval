#!/bin/sh
set -eu

cd /app
current=$(sha256sum package.json pnpm-lock.yaml pnpm-workspace.yaml packages/webgl-image/package.json | sha256sum)
expected=$(cat /opt/chronoval-dev-dependencies.sha256)
if [ "$current" != "$expected" ]; then
    echo '[chronoval-dev] Dependency manifests changed. Run:' >&2
    echo 'docker compose -f compose.dev.yaml up -d --build --force-recreate --renew-anon-volumes' >&2
    exit 1
fi

# Nuxt auth otherwise tries to append a generated secret to the read-only .env.
# Persist a development-only secret alongside the separate development database.
if [ -z "${NUXT_SESSION_PASSWORD:-}" ]; then
    NUXT_SESSION_PASSWORD=$(node --input-type=module -e '
        import { randomBytes } from "node:crypto";
        import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
        const file = "/app/data/.session-password";
        mkdirSync("/app/data", { recursive: true });
        let secret = "";
        try { secret = readFileSync(file, "utf8").trim(); } catch {}
        if (secret.length < 32) {
            secret = randomBytes(48).toString("base64url");
            writeFileSync(file, secret, { mode: 0o600 });
        }
        process.stdout.write(secret);
    ')
    export NUXT_SESSION_PASSWORD
fi

echo '[chronoval-dev] Preparing Nuxt and the watched WebGL workspace package...'
pnpm exec nuxt prepare
pnpm run build:deps
echo '[chronoval-dev] Starting development server on port 3100.'
exec "$@"
