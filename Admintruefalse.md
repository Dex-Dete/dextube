# Administrator on / off

This file is the switch for the administrator account on **this** DEXTube
instance. Edit the `admin:` line, save, then run:

```bash
npm run admin:switch
```

| `admin:` | What happens |
| --- | --- |
| `true` | The administrator account exists and can sign in. Created if missing; re-enabled if it was disabled. |
| `false` | The administrator account is deleted and all of its sessions are revoked. |

Nothing happens automatically: DEXTube never creates an administrator at
startup, and the web application has no route that can grant the ADMIN role. The
switch only takes effect when you run the command above.

---

## The settings

```text
admin: true
username: admin
email: admin@admin.com
password: admin
```

- **`admin`** — `true` or `false`. These are the only two accepted values; the
  command refuses to run and tells you which line is wrong if you write
  anything else.
- **`username`** / **`email`** — the identity of the account. Do not point this
  at an existing normal account: the command refuses to promote an account that
  is not already an administrator, and it never renames or resets one.
- **`password`** — the password used **only when the account is first created**.
  Running the command again never changes an existing password.

---

## Where to sign in

<http://localhost:3000/login> — then <http://localhost:3000/admin>

The administrator area has these sections:

| Page | What it does |
| --- | --- |
| `/admin` | Overview: counts of users, videos, imports and recent audit entries. |
| `/admin/users` | List accounts, disable/enable an account (which revokes its sessions). |
| `/admin/system` | The database-side switches, including the bootstrap switch. |
| `/admin/import` | Authorized channel/playlist migration (see below). |

## Seeing the imported channel entries

Run the ten-entry metadata test once, then open `/admin/import`:

```bash
npm run metadata-test          # imports the ten entries into THIS project's database
npm run metadata-test -- --cleanup   # removes them again
```

The ten entries appear on `/admin/import` with their real titles, video ids,
publication dates and thumbnails. They are **metadata only**: DEXTube has no
permission to copy that creator's media, so it records what the creator
published, with attribution, and stores no video file. That is the honest
outcome, not a failure — nothing is downloaded, and no fake video is created.

---

## Before you expose this instance to anyone else

1. **Change the password.** Sign in, go to <http://localhost:3000/settings>,
   and set a real password. `admin` is a placeholder that anyone can guess.
2. **Never let it face the public internet while this file says `admin: true`
   with the password `admin`.**
3. If you want the account gone, set `admin: false` and run the command. The
   account and its sessions are removed; the audit log keeps the history.
4. The bootstrap is **refused outright** when `DEXTUBE_ENV=production`, so a
   production deployment must create its first administrator through the
   normal setup flow.

## If you get locked out

Set `admin: true` again and run `npm run admin:switch`. If the account exists it
is re-enabled (and says so); if it was deleted, it is created again with the
password in this file. That is the recovery path, and it needs no access to the
web application.
