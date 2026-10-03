# Downloadizo Sync Hub

A tiny Node.js app that holds the **shared download queue** so your PC and phone
stay in sync. Deploy it once on your Hostinger Business plan (Node.js) — free,
always online, reachable from anywhere.

Both the desktop app and the phone app talk to this hub: add a link on either
device and it appears on both.

## Deploy on Hostinger (hPanel)

1. **hPanel → Advanced → Node.js** (or "Node.js" in the menu).
2. **Create a Node.js app:**
   - Project root: e.g. `downloadizo_sync`
   - Application URL: your domain/subdomain (e.g. `sync.yourdomain.com`)
    - Node.js version: a supported LTS release (22 or newer)
   - Application startup file: `app.js`
3. **Upload files:** open File Manager, go to the project root, and upload
    `app.js`, `security.js`, `package.json` and `package-lock.json` (from this `sync/` folder).
4. **Set a unique secret token:** use at least 32 random characters in a private
   `~/.config/downloadizo-sync/token` file (directory mode `0700`, file `0600`).
   `SYNC_TOKEN_FILE` can select another private file. That file takes precedence
   over legacy `.sync_token` or `SYNC_TOKEN` environment configuration, so a rotated
   credential remains authoritative after hosting rebuilds. For an initial setup
   without a private file, the environment fallback is:
   ```
   SYNC_TOKEN = <paste a long random string here>
   ```
    Pair the PC and phone through their settings. Never bundle a real token in
    application source, a URL, Git, screenshots, or logs.
5. **Install dependencies:** click the "Run NPM install" button (or it runs
   automatically). This installs `express`.
6. **Start the app**, then visit `https://<your-subdomain>/api/health`:
   ```json
    {"status":"ok"}
   ```
   That confirms it's live.

## API (token via `X-Token` header)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | – | liveness (no token) |
| GET | `/api/queue` | – | list all items |
| POST | `/api/queue` | `{url,label?,device?}` | add a link |
| PATCH | `/api/queue/:id` | `{status?,device?,progress?,filename?,error?}` | update |
| DELETE | `/api/queue/:id` | – | remove |
| GET/POST/DELETE | `/api/transfer` | `{address}` for POST | private transfer registration |
| GET/POST | `/api/cookies` | Netscape cookies, `text/plain` | YouTube domains only |
| GET/POST | `/api/pot` | `{token,visitorData?,expireAt?}` | private PO-token sharing |

Item shape: `{id,url,label,addedBy,addedAt,status,device,progress,filename,error}`
where `status` ∈ `queued|downloading|done|error|paused` and `device` ∈ `pc|mobile|null`.
Progress is a number from `0` to `1`. URLs must be HTTP(S) without embedded credentials.
All responses are non-cacheable; query-string authentication is rejected.

## Run / test locally

```bash
cd sync
npm ci --ignore-scripts
npm test                             # isolated synthetic fixtures in Safe_to_delete/
# Set SYNC_TOKEN_FILE to a private local token file before starting the service.
npm start                            # listens on PORT or 3000
```

## Notes

- This hub stores queue metadata plus explicitly shared YouTube cookies and PO
  tokens. Those are sensitive credentials. It does not download media; heavy
  downloads happen on the PC (yt-dlp) or phone.
- The app exports `module.exports = app` (for Hostinger/Passenger) and also
  listens on `process.env.PORT` when run directly — both work.
- Persistent state defaults to `~/.local/share/downloadizo-sync/`, overridable by
  `SYNC_DATA_DIR`. Use directory mode `0700` and state-file mode `0600`; keep this
  directory outside the public web root and hosting build directories. Migrate
  existing `queue.json`, `cookies.txt` and `pot.json` before upgrading from 1.0.0;
  preserve private backups and do not overwrite an existing destination.
- Authentication runs before body parsing. Invalid requests receive generic JSON
  errors, failed attempts and authenticated traffic have bounded rate limits,
  and the queue is capped at 5,000 entries / 16 MiB.
- Cookie sharing filters both newly uploaded and legacy jars to valid YouTube
  rows. Other browser-account cookies are never returned by the API.
