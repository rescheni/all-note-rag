# Security audit (open-source hardening)

Date: 2026-09-09. Scope: secrets, auth, supply chain, config hygiene, container safety.
Out of scope (per product owner): intentional on-disk personal notes / hub data model as a "data leak".

## Summary

| Severity | Finding | Action |
|----------|---------|--------|
| High | Example hub signing secret usable if dotenv not changed | Compose requires the secret var; api/worker log a warn on insecure default; README/env example call out change |
| High | Infra ports (Postgres/Redis/MinIO) previously published on 0.0.0.0 | Compose now binds them to 127.0.0.1 |
| Medium | Compose previously env_file=.env.example (ships example secrets into containers) | Switched to optional .env; variables injected via Compose environment |
| Medium | CORS reflects any Origin | Documented; intentional for flexible WEB_ORIGIN / tunnel setups — tighten to WEB_ORIGIN allowlist for locked-down deploys |
| Medium | AI settings Base URL is server-side fetched (SSRF class) | Authenticated owners only; document risk; do not expose to untrusted tenants |
| Low | Default MinIO/Postgres passwords in compose | Documented; change for internet-facing hosts |
| Low | Query token for asset GETs | By design for img tags; never log the value |
| Info | .env not tracked; DATA/ and data/ gitignored | Confirmed and extended |


## Checks performed

- Tracked tree: no live cloud credentials in git. Operator dotenv is gitignored — never commit it.
- Auth: most /v1 routes use requireUser. Exceptions: register/login/logout, OAuth browser callbacks (signed state), S3 hook (shared secret, timing-safe compare), /health.
- Images: Dockerfiles do not copy dotenv; dockerignore excludes dotenv and DATA.
- Volumes: bind mounts under ./DATA for postgres, redis, minio, models.
- CI: lockfile installs; GHCR via Actions token.


## Fixes applied in this pass

1. Full AGPL-3.0 LICENSE; package.json license field; README SPDX notice.
2. Compose DATA bind mounts; redis AOF; loopback infra ports; optional dotenv env_file; required hub signing secret substitution.
3. DATA/ and dotenv patterns in gitignore and dockerignore.
4. Startup warning when hub signing secret equals the insecure example default (api + worker).
5. GitHub Actions docker workflow for api/worker/web images to GHCR.
6. README rewrite for self-host; primary nav no longer lists Growth.

## Residual recommendations

- Hostile/multi-tenant: allowlist CORS to WEB_ORIGIN; TLS reverse proxy; rotate default store passwords; restrict AI Base URL hosts.
- Keep registration expectation clear on public instances (open register is for personal hubs).
- Never bake operator dotenv into images or commit DATA/.

## Ignored by request

Narratives that only say user notes live on disk / in Postgres / in object storage — that is the product model.

