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
   - Node.js version: 18 or newer
   - Application startup file: `app.js`
3. **Upload files:** open File Manager, go to the project root, and upload
   `app.js` and `package.json` (from this `sync/` folder).
4. **Set the secret token:** in the app's **Environment variables**, add:
   ```
   SYNC_TOKEN = <paste a long random string here>
   ```
   (You'll paste this same token into Downloadizo on both the PC and phone.)
5. **Install dependencies:** click the "Run NPM install" button (or it runs
   automatically). This installs `express`.
6. **Start the app**, then visit `https://<your-subdomain>/api/health`:
   ```json
   {"status":"ok","items":0}
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

Item shape: `{id,url,label,addedBy,addedAt,status,device,progress,filename,error}`
where `status` ∈ `queued|downloading|done|error` and `device` ∈ `pc|mobile|null`.

## Run / test locally

```bash
cd sync
SYNC_TOKEN=devtoken npm start          # listens on PORT or 3000
curl -H "X-Token: devtoken" http://localhost:3000/api/queue
```

## Notes

- This hub only stores the **queue metadata** (tiny JSON) — it does **not**
  download or host files. Heavy downloads happen on your PC (yt-dlp) or phone.
- The app exports `module.exports = app` (for Hostinger/Passenger) and also
  listens on `process.env.PORT` when run directly — both work.
- `queue.json` is the persisted queue; it lives in the app root on Hostinger.
