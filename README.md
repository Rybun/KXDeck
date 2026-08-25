# KXDeck

<img src="branding/kx-deck-lockup.svg" alt="KXDeck" width="220">

Companion overlay for [KX-Bridge](https://gitea.it-drui.de/viewit/KX-Bridge-Release) (the Moonraker-compatible bridge for the Anycubic Kobra X). KXDeck doesn't replace or fork KX-Bridge's panel — it sits in front of it, injecting extra cards and widgets straight into the native UI, and forwarding everything else untouched. If KX-Bridge updates, KXDeck's own injections just degrade gracefully instead of breaking.

This is an independent, unofficial, community project — not maintained or supported by the KX-Bridge team.

## What it adds

- Combined camera + interactive GCode viewer during a print: skipped/omitted objects grayed out, 90° rotate to match your camera's mount, smooth layer scrubbing (background-prefetches nearby layers).
- Richer pre-print dialog: on top of KX-Bridge's own "assign GCode channel to AMS slot" screen, KXDeck overlays a live 3D/2D/GCode preview of the actual parts, with the piece highlighted in 3D as you hover each channel — a much more intuitive way to see what color/filament goes where before you commit. Its "skip objects" tab is a friendlier alternative to the native checklist, fully in sync with it either way.
- Print progress widget, AMS spool status animation, pause-at-layer/time scheduling.
- Speed / fan / light controls, accent color theming.
- Optional Home Assistant integration: control a room light (or several) right next to the camera light toggle. Two-way webhook bridge — KXDeck never stores a long-lived Home Assistant access token. The exact automation YAML to paste into HA is generated live in Settings → Integrations, from whatever you've already filled in.

## Quick start

```bash
git clone https://github.com/Rybun/KXDeck.git
cd KXDeck
cp .env.example .env
# edit .env: at minimum set KX_URL to your KX-Bridge instance
docker compose up -d --build
```

KXDeck listens on port `5000`. Open `http://<host>:5000/` — that's the patched KX-Bridge panel, with KXDeck's cards inside it. There's no separate app/page to navigate to.

## Configuration

All configuration is environment variables (`.env`, see `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `KX_URL` | yes | — | Base URL of your KX-Bridge/Moonraker instance, e.g. `http://192.168.1.50:7125` |
| `API_KEY` | no | auto-generated | API key for the OctoPrint-compatible endpoints |
| `BLOCKED_HOSTS` | no | none | Comma-separated `Host` headers to reject outright (defense in depth if you ever expose KXDeck through a domain you later want to shut off) |
| `TZ` | no | `Europe/Madrid` | Container timezone |
| `DEBUG_REQUESTS` | no | `0` | Log every incoming request |

Two persistent volumes: `./data` (KXDeck's own settings, e.g. the Home Assistant integration) and `./render_cache` (GCode render cache — safe to delete, just gets regenerated).

## Home Assistant integration

Optional, configured entirely from the running app (Settings → Integrations → Home Assistant), no code changes needed. It works via webhooks in both directions so no HA long-lived token is ever stored in KXDeck:

- **KXDeck → HA**: pressing the toggle calls a webhook that triggers an automation you set up in HA (typically `light.toggle`).
- **HA → KXDeck**: an HA automation, triggered by the light's real state change, reports it back to KXDeck via a `rest_command`.

The Settings card shows the exact automation YAML to paste into HA, with your own values already filled in.

## Architecture

- `backend/` — Python (aiohttp). Proxies to KX-Bridge, serves the small set of endpoints KXDeck's own widgets need, and injects the widgets bundle into the native panel's HTML at `/` (see `backend/kx_home.py`).
- `frontend/src/widgets/entry.tsx` — the single bundle injected into the native panel. Most cards mount in an isolated shadow root; a couple (like the light toggle next to the camera) deliberately mount without one, to reuse KX-Bridge's own native CSS classes.
- No separate KXDeck SPA/page exists — the injected panel *is* the app.

## License

MIT — see [LICENSE](LICENSE). KXDeck is a separate program that talks to KX-Bridge over HTTP; no KX-Bridge source is included or linked here.
