# Running DEXTube on Fedora

This is the practical, Fedora-focused guide for getting DEXTube running — from a
bare install to a production service behind TLS. It assumes **Fedora 44** (the
verified target) but the commands work on adjacent releases; they degrade
gracefully on other distributions with a different package manager.

> **Nothing here is run for you.** Commands beginning with `sudo` change your
> system and require **your** approval. Review them before running.

---

## 1. Prerequisites

DEXTube needs:

| Component | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 22** | runtime for the web app and worker |
| npm | bundled with Node | package manager |
| PostgreSQL | **16** | via Docker (default) or natively |
| FFmpeg + FFprobe | recent | video processing (see the encoder gotcha) |
| Docker | optional | only needed for the default containerised PostgreSQL |

### 1.1 Node.js and npm

```bash
node --version   # must print v22.x or newer
npm --version
```

If either is missing or too old:

```bash
sudo dnf install nodejs npm
```

Fedora 44's `nodejs` package satisfies the `>= 22` requirement.

### 1.2 PostgreSQL

The default development setup runs PostgreSQL 16 in a Docker container named
`dextube-postgres` on host port **5433**, with the data volume `dextube_pgdata`.
You can instead point `DATABASE_URL` at any PostgreSQL 16 instance you already
run; in that case Docker is optional.

Install Docker from Fedora's repositories:

```bash
sudo dnf install moby-engine docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # then log out and back in
```

Docker's own upstream `docker-ce` repository also works if you prefer it.

### 1.3 FFmpeg and the encoder story (read this)

```bash
sudo dnf install ffmpeg-free
```

`ffmpeg-free` provides the `ffmpeg` and `ffprobe` binaries.

**The Fedora gotcha:** Fedora's `ffmpeg-free` build deliberately omits the
patent-encumbered **`libx264`** encoder. A pipeline that hardcodes
`-c:v libx264` therefore dies on a stock Fedora install with:

```
Unknown encoder 'libx264'
```

DEXTube never hardcodes an encoder. It inspects `ffmpeg -encoders` at runtime
and negotiates, in this preference order:

1. `VIDEO_ENCODER` — an explicit override from `.env`, if set
2. `libx264` — best quality per byte (RPM Fusion build)
3. `h264_nvenc` — NVIDIA hardware, if a GPU node is visible
4. `h264_vaapi` — Intel/AMD hardware, if a render node initialises
5. `libopenh264` — software H.264 shipped by Fedora

Consequently, **a stock `ffmpeg-free` install already transcodes**, as long as
`libopenh264` is present. Check what your build supports:

```bash
ffmpeg -hide_banner -encoders | grep -E 'libx264|libopenh264|h264_nvenc|h264_vaapi'
```

You have two ways to get the *patent-encumbered* `libx264` (better
quality-per-byte and CRF control):

**Option A — stay on Fedora's free stack, add OpenH264** (if `libopenh264` is
missing):

```bash
sudo dnf config-manager setopt fedora-cisco-openh264.enabled=1
sudo dnf install ffmpeg-free
```

**Option B — install RPM Fusion's full FFmpeg** (provides `libx264`):

```bash
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install ffmpeg
# If ffmpeg-free is already installed, let RPM Fusion's build replace it:
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```

What changes: with `libx264` DEXTube encodes with CRF (`-crf`); with
`libopenh264` it drives the encoder by target bitrate instead (OpenH264 has no
CRF control). Both produce browser-playable H.264. Force a choice in `.env`:

```bash
VIDEO_ENCODER=libx264     # or h264_nvenc / h264_vaapi / libopenh264 / auto
```

> **Do not** run the installer with `sudo`. `scripts/fedora-install.sh` installs
> *JavaScript* dependencies only; it prints the `dnf` commands above for you to
> run yourself.

### 1.4 Bootstrap the project

```bash
bash scripts/fedora-install.sh
```

This is idempotent: it checks the toolchain, copies `.env.example` to `.env`
when needed, runs `npm ci` (falling back to `npm install`), and generates the
Prisma client. It never runs `sudo`.

Then edit `.env`:

```bash
# Required secrets
SESSION_SECRET=$(openssl rand -base64 48)
```

Set `POSTGRES_PASSWORD` to match `docker-compose.yml`/`scripts/db-up.sh`, and
make sure `DATABASE_URL` uses the right host/port (`localhost:5433` for the
Docker container). Verify everything with:

```bash
npm run doctor
```

---

## 2. Starting and stopping

### Development

```bash
bash scripts/start.sh           # db-up.sh -> migrate -> doctor -> npm run dev
```

### Production

```bash
bash scripts/start.sh --prod    # db-up.sh -> migrate -> doctor -> build -> npm start
```

`start.sh` performs, in order: checks `.env`, starts the database via
`scripts/db-up.sh`, waits for it to accept connections, applies migrations
(`npx prisma migrate deploy`), runs `npm run doctor` (aborting on failure), then
launches the app in the background. When `JOB_RUNNER=external` is set in `.env`
it also starts `npm run worker`.

Logs are written to `storage/logs/` and PIDs to `storage/run/`:

| File | Contents |
| --- | --- |
| `storage/logs/app.log` | web app stdout/stderr |
| `storage/logs/worker.log` | background worker stdout/stderr |
| `storage/logs/build.log` | production build output |
| `storage/run/app.pid`, `storage/run/worker.pid` | PIDs used by `stop.sh` |

```bash
tail -f storage/logs/app.log
```

Stop the app (leaving the database running):

```bash
bash scripts/stop.sh
```

Stop the app *and* the database container:

```bash
bash scripts/stop.sh --with-db
```

`stop.sh` only signals processes it can verify were started by DEXTube (their
working directory is the project root). It sends `SIGTERM`, waits, then
`SIGKILL`. It never touches the database unless you pass `--with-db`.

---

## 3. Running as a systemd service

For a always-on deployment, run the web app and (optionally) the worker under
systemd. The examples below assume DEXTube lives at `/opt/dextube` and runs as a
dedicated `dextube` user.

```bash
sudo useradd --system --home-dir /opt/dextube --shell /sbin/nologin dextube
sudo chown -R dextube:dextube /opt/dextube
# Build once as the dextube user before enabling the unit:
sudo -u dextube bash -c 'cd /opt/dextube && npm ci && npx prisma generate && npm run build'
```

### 3.1 System service — web app

`/etc/systemd/system/dextube.service`:

```ini
[Unit]
Description=DEXTube web application
Documentation=file:/opt/dextube/docs/fedora.md
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=dextube
Group=dextube
WorkingDirectory=/opt/dextube
EnvironmentFile=/opt/dextube/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
# Wait for the database before starting; db-up.sh is idempotent.
ExecStartPre=/bin/bash /opt/dextube/scripts/db-up.sh
TimeoutStartSec=180

# Hardening. ReadWritePaths must include the media/log/run/backup tree.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/dextube/storage
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

### 3.2 System service — background worker

Set `JOB_RUNNER=external` in `/opt/dextube/.env`, then create
`/etc/systemd/system/dextube-worker.service`:

```ini
[Unit]
Description=DEXTube background worker
Documentation=file:/opt/dextube/docs/fedora.md
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=dextube
Group=dextube
WorkingDirectory=/opt/dextube
EnvironmentFile=/opt/dextube/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run worker
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/dextube/storage
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dextube.service dextube-worker.service
systemctl status dextube.service
journalctl -u dextube.service -f
```

`EnvironmentFile` reads `/opt/dextube/.env`. systemd's parser is stricter than
shell: put values containing spaces in double quotes, e.g.
`SMTP_FROM="DEXTube <no-reply@example.invalid>"`.

### 3.3 User service (no root)

A single-user install can run entirely under your own account. Put the units in
`~/.config/systemd/user/dextube.service` and `.../dextube-worker.service` (drop
`User=`/`Group=` and the `ReadWritePaths` hardening), then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dextube.service
loginctl enable-linger "$USER"    # keep it running after logout
journalctl --user -u dextube.service -f
```

---

## 4. Reverse proxy, TLS, and `DEXTUBE_TRUST_PROXY`

DEXTube binds `127.0.0.1:3000` by default. `scripts/start.sh` exports `PORT`
and passes `BIND_HOST` to Next.js as `-H`, so setting `PORT` and `BIND_HOST` in
`.env` is enough — you do not need to edit `package.json`. (If you launch the app
by hand with `npm run dev`, set the port on the command line instead, because
Next.js reads `PORT` from the environment *before* it loads `.env`:
`PORT=4000 npm run dev`.) In production the app **must sit behind a TLS
terminating reverse proxy**.

When your proxy supplies `X-Forwarded-For`, set:

```bash
DEXTUBE_TRUST_PROXY=1
```

This tells DEXTube to trust that header for rate limiting and view
de-duplication. **Never enable it** on a server that is directly reachable,
because clients could spoof their IP.

### 4.1 Caddy (primary — automatic TLS)

`/etc/caddy/Caddyfile`:

```caddyfile
video.example.com {
    encode zstd gzip

    # Media can be large; hand it straight to the app.
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    request_body {
        max_size 2GB
    }
}
```

Caddy obtains and renews certificates automatically. Reload with
`sudo systemctl reload caddy`.

### 4.2 nginx (alternative)

`/etc/nginx/conf.d/dextube.conf`:

```nginx
server {
    listen 80;
    server_name video.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name video.example.com;

    ssl_certificate     /etc/letsencrypt/live/video.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/video.example.com/privkey.pem;

    client_max_body_size 2G;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Certificates via `certbot --nginx`. Test with `sudo nginx -t` before reloading.

---

## 5. SELinux

On enforcing Fedora systems, SELinux blocks the web server (or other confined
processes) from reading a media directory that lives outside the usual web
roots. If you serve `MEDIA_ROOT` through a reverse proxy or a separate web
server, label it appropriately:

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/var/lib/dextube/media(/.*)?"
sudo restorecon -Rv /var/lib/dextube/media
```

Notes:

- If `semanage` is missing: `sudo dnf install policycoreutils-python-utils`.
- When DEXTube itself writes the media (the app reads/writes `MEDIA_ROOT`
  directly, not through the web server), you may instead need a writable context.
  Check denials first before guessing.
- Diagnose denials with:

  ```bash
  sudo ausearch -m avc -ts recent
  journalctl -t setroubleshoot --since "1 hour ago"
  ```

- Do not disable SELinux to "fix" a labeling problem. `restorecon` after the
  correct file context is the right answer.

---

## 6. firewalld

By default DEXTube listens only on `127.0.0.1:3000`, so **nothing needs to be
opened** if you use a reverse proxy on the same host. Open the firewall only for
the proxy's ports:

```bash
# If Caddy/nginx terminate TLS on this host:
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

To expose DEXTube *directly* (LAN testing only — set
`BIND_HOST=0.0.0.0` in `.env` first):

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

Serving plain HTTP on `0.0.0.0` is fine for a trusted LAN but never for the
public internet — use TLS via a proxy.

---

## 7. Backups

Back up both the database and the media directory:

```bash
bash scripts/backup.sh                 # -> storage/backups/dextube-<timestamp>/
bash scripts/backup.sh /mnt/backups    # custom destination parent
```

Each backup contains `database.sql.gz`, `media.tar.gz`, and a `manifest.txt`
with the timestamp, DEXTube version, database name, media root, and per-file
sizes/checksums. Restore (destructive — it requires `--yes`):

```bash
bash scripts/restore.sh storage/backups/dextube-20260101-120000 --yes
```

`restore.sh` verifies the manifest and archives before changing anything, drops
and reloads the database, and moves the current media directory aside as
`<media-root>.pre-restore-<timestamp>`.

---

## 8. Where logs live

| Source | Location |
| --- | --- |
| `scripts/start.sh` app | `storage/logs/app.log` |
| `scripts/start.sh` worker | `storage/logs/worker.log` |
| production build | `storage/logs/build.log` |
| App structured logs | stdout (also captured in the files above) |
| systemd services | `journalctl -u dextube.service` (or `--user`) |
| PostgreSQL container | `docker logs dextube-postgres` |

---

## 9. Troubleshooting

### `Unknown encoder 'libx264'`

**Cause:** Fedora's `ffmpeg-free` build omits `libx264`.

**Fix:** either rely on the shipped `libopenh264` (DEXTube already prefers it
when `libx264` is absent) or install a build that has `libx264`:

```bash
ffmpeg -hide_banner -encoders | grep -E 'libx264|libopenh264'
# RPM Fusion route:
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf install ffmpeg
sudo dnf swap ffmpeg-free ffmpeg --allowerasing   # if needed
```

Do **not** set `VIDEO_ENCODER=libx264` unless the encoder actually exists — the
app will refuse to start transcoding and say so. Use `VIDEO_ENCODER=auto`
(default) to let DEXTube negotiate.

### Database connection refused

**Symptoms:** `npm run doctor` reports PostgreSQL as `FAIL`, or `start.sh` times
out waiting for the database.

```bash
bash scripts/db-up.sh                 # start the container
docker logs --tail 50 dextube-postgres
docker inspect -f '{{.State.Running}}' dextube-postgres
```

Check that `.env`'s `DATABASE_URL` port matches reality: the Docker container
publishes **5433**, while a native PostgreSQL listens on **5432**.

```bash
# Correct for the default container:
DATABASE_URL=postgresql://dextube:<password>@localhost:5433/dextube
```

If you use an external PostgreSQL, make sure it is running, reachable, and that
`POSTGRES_PASSWORD` in `.env` matches the server's password.

### Port already in use

**Symptoms:** `EADDRINUSE`, or Next.js exits immediately after `start.sh`.

```bash
ss -ltnp '( sport = :3000 )'
# or
sudo lsof -i :3000
```

Stop whatever owns the port, or change it. Set `PORT` in `.env` and start with
`bash scripts/start.sh` (which exports it for Next.js), or run
`PORT=4000 npm run dev` by hand.

### `EACCES` on the media directory

**Symptoms:** uploads fail, or the doctor reports the media directory is not
writable.

```bash
ls -ld storage/media
# Make sure the user that runs the app owns it:
sudo chown -R dextube:dextube /opt/dextube/storage/media
```

If you serve media through a web server, remember the SELinux labeling from
section 5. The doctor's writability probe is the quickest check:

```bash
npm run doctor
```

### Worker not processing jobs

- Confirm `JOB_RUNNER=external` in `.env`; otherwise jobs run inline in the web
  process by design.
- Check that the worker is actually running: `cat storage/run/worker.pid` and
  `tail -f storage/logs/worker.log` (or `systemctl status dextube-worker`).

---

## 10. Quick reference

```bash
# Bootstrap (idempotent, no sudo)
bash scripts/fedora-install.sh

# Preflight
npm run doctor

# Start / stop
bash scripts/start.sh
bash scripts/start.sh --prod
bash scripts/stop.sh
bash scripts/stop.sh --with-db

# Backup / restore
bash scripts/backup.sh
bash scripts/restore.sh storage/backups/dextube-<stamp> --yes

# Test media
npm run make:testmedia
```
