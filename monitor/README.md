# Server Health Monitor

A real-time system dashboard: Node.js + Express backend that reads OS metrics via the built-in `os` module, and a dark-themed vanilla HTML/CSS/JS frontend.

## Quick start

```bash
cd monitor
npm install                 # installs express, cors, nodemon
npm run dev                 # starts server with nodemon (auto-reload)
# or:
npm start                   # plain node
```

Then open **http://localhost:3000** — Express serves both the dashboard (`public/index.html`) and the API.

## API

**GET** `/api/system-status` → JSON

```json
{
  "cpu":    { "model", "cores", "architecture", "speedMHz", "usagePercent", "loadAverage" },
  "memory": { "totalGB", "freeGB", "usedGB", "usedPercent" },
  "uptime": { "seconds", "human" },
  "os":     { "type", "platform", "release", "hostname" },
  "timestamp": "ISO-8601"
}
```

CORS is enabled globally so you can also open `public/index.html` directly from a different origin.

## Files

- `server.js` — Express API + static hosting for the dashboard
- `public/index.html` — Single-file dashboard (Tailwind via CDN, vanilla JS, 5s auto-refresh)
- `package.json` — Dependencies and `start` / `dev` scripts

## Notes

- CPU usage is sampled over a ~200 ms window per request by diffing `os.cpus()` times — no external monitoring library required.
- Auto-refresh runs every 5 seconds; the **Refresh Now** button triggers an immediate fetch.
- Progress bars use CSS transitions so values animate smoothly between polls.
