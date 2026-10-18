# DEXTube Deployment

This is the production deployment guide. It assumes you have already read
[`docs/fedora.md`](./fedora.md), which is the Fedora-specific walkthrough
(prerequisites, the FFmpeg encoder situation, systemd units, SELinux, firewalld,
logging, and troubleshooting). This document focuses on the production topology,
hardening, and a go-live checklist.

The reference topology is simple:

```
                 TLS
   Internet ───────────► Reverse proxy (nginx / Caddy) ──► DEXTube web  (127.0.0.1:3000)
                                                                     │
                                                     ┌───────────────┴───────────────┐
                                                     ▼                               ▼
                                            PostgreSQL 16                   DEXTube worker
                                            (5432 / 5433)                   (npm run worker)
                                                     │
                                                     └── local media storage (MEDIA_ROOT)
```

---

## 1. Build

Install dependencies and build the production bundle as the user that will run
the service:

```bash
npm ci
npx prisma generate
npm run build
```

The web server runs the build with `npm start`. The worker does not need a build
step; it runs from source with `tsx` via `npm run worker`.

---

## 2. PostgreSQL

DEXTube needs PostgreSQL **16**. Two supported options:

**A. Containerised (default).** `scripts/db-up.sh` starts a `dextube-postgres`
container on `127.0.0.1:5433` using `--restart unless-stopped`. `scripts/start.sh`
calls it automatically. `docker-compose.yml` is provided for hosts that have the
Compose plugin.

**B. External / native PostgreSQL 16.** Point `DATABASE_URL` at it. A native
install listens on `5432` by default:

```dotenv
DATABASE_URL=postgresql://dextube:CHANGE_ME@localhost:5432/dextube
```

Then apply migrations:

```bash
npx prisma migrate deploy
```

Do not use `prisma migrate dev` in production — it is interactive and can reset
data. Always use `migrate deploy`.

---

## 3. Production environment

Start from `.env.example` and set, at minimum:

| Variable | Production value / notes |
| --- | --- |
| `NODE_ENV` | `production` — disables dev-only behaviour such as `'unsafe-eval'` in the CSP and surfacing action links in logs. Cookie security follows `APP_URL` (see below), not `NODE_ENV`. |
| `APP_URL` | The public HTTPS origin, for example `https://video.example.com`. Used for CSRF origin checks, email links, and SMTP EHLO. |
| `BIND_HOST` | Keep `127.0.0.1` when a reverse proxy runs on the same host. Only bind `0.0.0.0` if the proxy is elsewhere and the network is trusted. |
| `PORT` | `3000` by default. |
| `DATABASE_URL` | Real credentials. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Must match the database (used by the scripts and the container). |
| `SESSION_SECRET` | **Strong and unique.** Generate with `openssl rand -base64 48`. DEXTube refuses to start in production while this still contains `CHANGE_ME`. |
| `SESSION_TTL_DAYS` | Session lifetime (default 30). |
| `DEXTUBE_TRUST_PROXY` | `1` **only** when a trusted reverse proxy supplies `X-Forwarded-For`. Enables correct client IPs for rate limiting and view dedupe. **Never set this on a directly reachable server** — clients could spoof their IP. |
| `STORAGE_DRIVER` | `local` (the S3 adapter is not implemented). |
| `MEDIA_ROOT` | An absolute path on a large volume, for example `/var/lib/dextube/media`. |
| `PROCESSING_CONCURRENCY` | `1`–`2` unless you have headroom; each FFmpeg job is CPU- and memory-heavy. |
| `TRANSCODE_LADDER` | For example `720,480,360`, or `off` to remux/original only. |
| `ENABLE_HLS` | `false` unless your host can handle packaging and you have configured HLS delivery. |
| `MAX_UPLOAD_BYTES` | Defaults to 2 GiB; keep your proxy's body limit at or above this. |
| `JOB_RUNNER` | `external` — run media work in the dedicated worker (see §4). |
| `SMTP_*` | Configure for real email verification and password reset; otherwise mail is written to `storage/mail-outbox/`. |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_MINUTES`, `VIEW_DEDUPE_SECONDS` | Abuse-control tuning. |
| `DEXTUBE_WORKER_ID` | Optional stable worker identity for job lock rows. |

Notes:

- **Secure cookies are automatic when `APP_URL` is `https://`** (`Secure`,
  `httpOnly`, `SameSite=Lax`, `__Host-dextube_session`). `__Host-` requires the
  cookie to be `Secure`, `Path=/`, and host-only — so serve DEXTube over HTTPS.
  A plain-HTTP origin (for example a trusted LAN) gets the unprefixed
  `dextube_session` without `Secure`, because browsers refuse to store `Secure`
  cookies received over HTTP. `SESSION_COOKIE_SECURE=auto|true|false` forces the
  decision; leave it on `auto` unless your proxy configuration requires
  otherwise.
- DEXTube validates its configuration at startup and **fails fast** on a
  placeholder `SESSION_SECRET` or `DATABASE_URL`.
- Values containing spaces (for example `SMTP_FROM`) must be quoted in a
  systemd `EnvironmentFile`.

Verify the deployment before exposing it:

```bash
npm run doctor
```

---

## 4. Running the web server and the worker

Set `JOB_RUNNER=external` in `.env`, then run two processes:

```bash
# Web server
npm start

# Background worker (separate process; can be a separate systemd unit or container)
npm run worker
```

- `npm start` serves the built application on `BIND_HOST:PORT`.
- `npm run worker` polls the `jobs` table and processes media, notifications,
  analytics rollups, and maintenance. It handles `SIGINT`/`SIGTERM` gracefully,
  finishing the job in flight before exiting. If you set `JOB_RUNNER=external`
  but forget to run the worker, uploads stay in `PROCESSING`.

For development-only single-process setups, `JOB_RUNNER=inline` drains the queue
inside the web process instead. Its heartbeat and retry timers are `unref`'d so
they never keep the process alive on their own.

`scripts/start.sh --prod` performs the build and starts both processes and writes
logs/PIDs under `storage/`; see [`docs/fedora.md`](./fedora.md#2-starting-and-stopping).

---

## 5. Reverse proxy (TLS, range requests, large uploads)

DEXTube serves media itself through `/api/media/...` using **HTTP range
requests**. The proxy must forward `Range`/`If-Range` and not interfere with
`206 Partial Content`, and its request-body limit must be at least
`MAX_UPLOAD_BYTES`.

### 5.1 Caddy (automatic TLS)

```caddyfile
video.example.com {
    encode zstd gzip

    # Match MAX_UPLOAD_BYTES (default 2 GiB).
    request_body {
        max_size 2GB
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up Host {host}
    }
}
```

Caddy obtains and renews certificates automatically and streams bodies without
buffering the whole request, so range and large-upload behaviour work out of the
box. Reload with `sudo systemctl reload caddy`. Do **not** enable `encode` for
video responses if you observe seeking problems — ranged MP4 is already
compressed; the line above is safe because Caddy skips compressing already
compressed content, but if you hit issues, scope compression to text assets.

### 5.2 nginx

```nginx
server {
    listen 80;
    server_name video.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name video.example.com;

    ssl_certificate     /etc/letsencrypt/live/video.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/video.example.com/privkey.pem;

    # Must be >= MAX_UPLOAD_BYTES.
    client_max_body_size 2G;
    # Give slow/small chunk uploads room to finish.
    client_body_timeout  300s;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Range requests: forward them and do not rewrite 206 responses.
        proxy_set_header   Range     $http_range;
        proxy_set_header   If-Range  $http_if_range;

        # Do not buffer media; let seeking stream straight through.
        proxy_buffering    off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Certificates via `certbot --nginx`. Always `sudo nginx -t` before reloading.

When either proxy is in front, set `DEXTUBE_TRUST_PROXY=1` so rate limiting and
view dedupe see the real client IP from `X-Forwarded-For`.

---

## 6. systemd units

Complete, copy-pasteable units (web app and worker, system and user variants) live
in [`docs/fedora.md` §3](./fedora.md#3-running-as-a-systemd-service). They run the
app as a dedicated `dextube` user with `ProtectSystem=strict`, `NoNewPrivileges`,
and `ReadWritePaths=/opt/dextube/storage`, and load configuration from
`/opt/dextube/.env`.

Minimal summary of what each unit runs:

| Unit | ExecStart | Notes |
| --- | --- | --- |
| `dextube.service` | `/usr/bin/npm start` | Set `NODE_ENV=production`. `ExecStartPre=/bin/bash /opt/dextube/scripts/db-up.sh` waits for the database. |
| `dextube-worker.service` | `/usr/bin/npm run worker` | Requires `JOB_RUNNER=external`. |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dextube.service dextube-worker.service
journalctl -u dextube.service -f
```

---

## 7. Backups and restore

Back up **both** the database and the media directory. `scripts/backup.sh`
produces a timestamped directory containing `database.sql.gz`, `media.tar.gz`,
and `manifest.txt` (timestamp, version, database name, media root, and per-file
size + SHA-256).

```bash
bash scripts/backup.sh                 # -> storage/backups/dextube-<stamp>/
bash scripts/backup.sh /mnt/backups    # custom destination parent
```

It uses `docker exec … pg_dump` when the container is running, and falls back to
the host `pg_dump` with `DATABASE_URL` otherwise (recording which path was used
in the manifest). There are npm aliases too:

```bash
npm run db:backup
npm run db:restore -- <backup-dir> --yes
```

Restore is destructive and **requires `--yes`**:

```bash
bash scripts/restore.sh storage/backups/dextube-20260101-120000 --yes
```

`restore.sh` verifies the manifest and both archives (`gzip -t`, `tar -tzf`)
before changing anything, drops and reloads the database schema, and moves the
current media directory aside as `<media-root>.pre-restore-<stamp>` so the change
is reversible. Schedule `scripts/backup.sh` from cron or a systemd timer and copy
the output off-host.

---

## 8. Health and monitoring

- `GET /api/health` returns `200` when the database, storage, FFmpeg, FFprobe,
  and a usable H.264 encoder are all available, and `503` otherwise. It exposes
  no secrets — only booleans, tool versions, feature flags, and the host's own
  advertised URL. Add `?details=1` (non-production only) for a job breakdown.
- Use it as a container/systemd health check.
- App logs are structured JSON on stdout; `scripts/start.sh` also writes
  `storage/logs/app.log` and `storage/logs/worker.log`.

---

## 9. Production checklist

- [ ] Node.js **>= 22** installed; `npm ci` and `npm run build` completed.
- [ ] PostgreSQL 16 running and reachable; `npx prisma migrate deploy` applied.
- [ ] `NODE_ENV=production` set.
- [ ] `SESSION_SECRET` is strong and unique (`openssl rand -base64 48`), not a
      placeholder.
- [ ] `DATABASE_URL` uses real credentials, not a placeholder.
- [ ] `APP_URL` is the public HTTPS origin.
- [ ] `BIND_HOST=127.0.0.1` and the app sits behind a TLS-terminating proxy.
- [ ] `DEXTUBE_TRUST_PROXY=1` set **only** because a trusted proxy supplies
      `X-Forwarded-For`.
- [ ] Proxy forwards `Range`/`If-Range`, allows `206` responses, and its body
      limit is `>= MAX_UPLOAD_BYTES`.
- [ ] `JOB_RUNNER=external` and the worker process is running under systemd.
- [ ] `MEDIA_ROOT` is an absolute path on a large volume, owned by the service
      user, and included in backups.
- [ ] `npm run doctor` reports no `FAIL` items.
- [ ] SMTP configured, **or** `storage/mail-outbox/` treated as sensitive.
- [ ] A usable H.264 encoder is available (`libx264` via RPM Fusion, or
      `libopenh264` from Fedora's free stack). See
      [`docs/fedora.md` §1.3](./fedora.md#13-ffmpeg-and-the-encoder-story-read-this).
- [ ] Scheduled `scripts/backup.sh` runs, with copies stored off-host.
- [ ] Firewall exposes only the proxy's ports (80/443); DEXTube itself is not
      publicly reachable.
- [ ] SELinux contexts (if enforcing) allow the service to read/write
      `MEDIA_ROOT` — see [`docs/fedora.md` §5](./fedora.md#5-selinux).
- [ ] `GET /api/health` returns `200`.

---

## 10. Object storage (reserved)

`STORAGE_DRIVER=s3` is **not implemented** in this release. Setting it makes
DEXTube fail fast with a clear error that points at
`src/server/storage/index.ts`, rather than silently pretending to store media
remotely. The `MediaStorage` interface (`put`, `getStream` with ranges, `stat`,
`delete`, `deletePrefix`, `list`, `localPath`, `publicUrl`) is the seam a future
S3 adapter would implement; until then, use `STORAGE_DRIVER=local`.
