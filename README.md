# DARGAZE — Into the Ash

A browser-based, third-person 3D co-op adventure. Three orphan boys discover a puzzle in a leafless forest tree and fall into a volcanic world. The first playable chapter is **The Ember Cliffs**: recover three Ember Crystals, attune a checkpoint, place the crystals on the altar, and open the gate while two companion slots are filled by AI.

The repository includes a Vite/Three.js client, a Node/TypeScript/Socket.IO authoritative game service, shared Zod schemas and level data, PostgreSQL migrations, Redis-backed rate limiting/room snapshots, automated tests, and a Docker deployment with Caddy TLS termination.

> **Deployment note:** pushing the source to GitHub does not run the game. GitHub Pages can serve only the static client; authentication, co-op WebSockets, PostgreSQL and Redis require the included Node/Docker stack on an application host. No public host/domain or third-party credentials were supplied, so the app is not yet running at a permanent public URL. See the HTTPS deployment steps below.

## What is playable

- Procedural 3D forest prologue, rotatable three-symbol tree puzzle, portal transition, and a volcanic level with lava rivers, cliffs, ash, embers, dead trees, ruins, bones, torch/lava lights, a Black Shadow, altar and gate.
- Third-person WASD/arrow + mouse-drag controls, jump, interaction, mobile virtual stick/buttons, health, party health, objective progress, checkpoint, lava damage/respawn, and local AI followers.
- Create a private 3-slot co-op room, short random room code and 30-minute cryptographic invite; code/link join; ready state, host start/kick/privacy controls, regenerate invite, chat filtering, emotes, danger markers, and mute/report controls.
- Unfilled slots are AI-controlled. A disconnected character is AI-covered and can be reclaimed by the same player during the five-minute grace window. AI companions follow, steer away from the lava seam, help attune the altar when a player is nearby, and can revive a downed friend.
- Server-side input validation, sequence checks, authoritative movement and interactions, 20 Hz snapshots, client prediction/interpolation, reconnect overlay/rejoin, and shared room progress/checkpoint.
- Guest sessions plus email/password, Google OAuth, email verification/reset (SMTP), rotating refresh cookies, 15-minute access JWTs, optional encrypted TOTP, session listing/revocation, progressive login lockout, optional Cloudflare Turnstile, and account deletion.

The visuals and story are asset-free and generated from Three.js geometry. This is a playable vertical slice, not a finished commercial release; Level 2 is an unlock screen and is intentionally an easy extension point.

## Quick start (client + co-op API)

Requires Node.js 22+ and npm 10+.

```bash
npm install
npm run dev
```

Open the Vite URL printed by the client (normally `http://localhost:5173`). The Vite server proxies `/api` and `/socket.io` to the API at port `3001`. Guest sessions, solo play and in-memory co-op rooms work without external services. **Registered accounts, persistent sessions/progress, Redis rate limiting and persistent room snapshots require PostgreSQL/Redis** and the full Docker stack or configured local services.

Useful commands:

```bash
npm run test       # Zod/input, auth-token and three-slot room tests
npm run typecheck
npm run build
```

## Full stack with HTTPS

1. Copy `.env.example` to `.env`.
2. Replace `PUBLIC_DOMAIN` with a real DNS name pointing to the host. Generate distinct secrets, e.g. `openssl rand -hex 32`, for `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET` and `TOTP_ENCRYPTION_KEY`. Do not use the sample values in production.
3. Configure `SMTP_URL` and `EMAIL_FROM` for verification/reset mail. Configure Google OAuth with the callback URL `https://<PUBLIC_DOMAIN>/api/auth/google/callback` if you want Google sign-in. `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are optional; set both to render and verify CAPTCHA challenges.
4. Start the stack:

```bash
docker compose up --build -d
docker compose logs -f api caddy
```

Caddy obtains and renews a certificate for `PUBLIC_DOMAIN`, serves the static client, and proxies API/WebSocket traffic. Only Caddy publishes ports 80/443; PostgreSQL and Redis stay on the private Compose network. Caddy redirects/serves HTTPS and the app requires HTTPS/WSS in production. For `PUBLIC_DOMAIN=localhost`, Caddy uses a local internal certificate which may need to be trusted by your browser. Public automatic HTTPS requires valid DNS and inbound ports 80/443.

The Postgres schema is initialized from `server/migrations/001_init.sql` on first database creation. Existing volumes are not reinitialized; apply future migrations explicitly.

## Folder structure

```text
client/
  src/app.ts                 menus, intro, lobby, HUD, account/chat UI
  src/game/World.ts          procedural Three.js scenes, actors, local simulation
  src/game/Ambience.ts       generated wind/rumble/heartbeat ambience
  src/network/               auth and Socket.IO clients
  Dockerfile nginx.conf      static deployment + browser security headers
server/
  src/index.ts               Express hardening, routes, startup
  src/auth.ts                guest, email, Google, JWT, refresh, TOTP and sessions
  src/socket.ts              handshake auth, Zod message validation, 20 Hz tick
  src/room-manager.ts        3-slot room lifecycle, authoritative gameplay and AI
  src/db.ts rate-limit.ts    Postgres, Redis adapter, Redis-backed REST/socket limits
  migrations/                users, sessions, reset/verification tokens, progress
shared/
  src/index.ts               shared types, strict Zod schemas and editable level data
  src/index.test.ts
Caddyfile docker-compose.yml server/Dockerfile client/Dockerfile
```

## Controls and level editing

- **WASD / arrows:** move relative to the camera; drag the world to look around.
- **Space:** jump. **E:** collect, attune, place or enter when prompted. **Esc:** pause/resume. **Right-click:** danger ping in co-op. **Enter:** open co-op chat.
- On touch devices, use the on-screen joystick and jump/interact buttons.

Edit `LEVELS.emberCliffs` in `shared/src/index.ts` to change objective text, start/checkpoint/altar/gate locations, or crystal placements. The world builder reads the same shared data, and the server independently validates interaction distance against it. Add a new level object there and a corresponding scene builder in `client/src/game/World.ts` to extend the campaign.

## Security checklist

- [ ] Replace all sample secrets; keep `.env` out of Git. Use separate high-entropy database, Redis, JWT and TOTP encryption secrets.
- [ ] Point `PUBLIC_DOMAIN`, `PUBLIC_URL`, `FRONTEND_ORIGINS` and Google redirect URI at the actual HTTPS origin. Never expose Postgres/Redis publicly.
- [ ] Configure SMTP before enabling account registration; verification and password-reset links are one-use and expire. Never log tokens, passwords or chat contents.
- [ ] Configure Google OAuth and/or Cloudflare Turnstile only with provider credentials stored server-side.
- [ ] Keep Caddy, Node, Postgres, Redis and npm dependencies patched; run `npm audit` and add the desired audit severity to CI.
- [ ] Back up Postgres and Redis data; define retention, monitoring/alerting and an incident/report process before launch.
- [ ] Review privacy/terms for your jurisdiction and product, age rating and parental-consent obligations before public release.
- [ ] For multi-process game scaling, use a shared authoritative room coordinator/placement layer. Redis adapter and snapshot storage are included; the in-process simulation manager is intended for a single game-server instance or sticky room placement.

## Tests

`npm test` covers strong-password/name/chat/input schema behavior, access-token scope/expiry, three-slot room creation and joining, full-room rejection, reconnect reclaim, and host/ready rules. The server's Socket.IO layer validates every application message before it reaches gameplay. Add integration tests against disposable Postgres/Redis and browser E2E coverage before production launch.
