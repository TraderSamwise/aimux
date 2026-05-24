# Aimux Deployment Guide

## Prerequisites

- Clerk account with a production application
- Cloudflare account with Workers + Durable Objects enabled
- Domain: aimux.app with DNS managed by Cloudflare
- Vercel account (for the web app) or EAS (for native builds)
- Node.js 22+ on machines running the local aimux daemon; remote relay mode
  uses the runtime `WebSocket` implementation shipped with Node 22+

## 1. Clerk Setup

1. Create a Clerk application at https://dashboard.clerk.com
2. Enable email + password sign-in method
3. Note your keys:
   - **Publishable key** (pk*live*...) — used by the app
   - **Secret key** (sk*live*...) — used by the daemon and relay

## 2. Relay Server (Cloudflare Worker)

```bash
cd relay
yarn install

# Login to Cloudflare
wrangler login

# Set the Clerk secret key (verifies app-side session JWTs)
wrangler secret put CLERK_SECRET_KEY --env production
# Paste your sk_live_... key

# Set the daemon-token signing key (HS256 secret used to mint + verify
# long-lived daemon tokens from `aimux login`). Use a strong random
# value — anything that compromises this lets an attacker forge tokens.
# e.g. `openssl rand -base64 48` or `head -c 48 /dev/urandom | base64`
wrangler secret put RELAY_TOKEN_SECRET --env production

# Optional: enable security alert emails.
wrangler secret put RESEND_API_KEY --env production

# Deploy (production with custom domain)
wrangler deploy --env production
```

Production non-secret relay variables are committed in `relay/wrangler.toml`:

```toml
CLI_TOKEN_ALLOWED_ORIGINS = "https://aimux.app,https://www.aimux.app"
SECURITY_ACTION_BASE_URL = "https://relay.aimux.app"
SECURITY_DEVICE_POLICY = "warn"
SECURITY_EMAIL_FROM = "aimux security <security@aimux.app>"
```

Use `SECURITY_DEVICE_POLICY=warn` for the MVP so a first-time phone or browser
can still connect while the user receives alerts. Switch it to `enforce` only
after there is a device approval UI or CLI flow; enforce mode denies proxy/API
requests from pending devices.

The relay will be available at:

- Dev: `https://aimux-relay.<your-subdomain>.workers.dev`
- Production: `https://relay.aimux.app` (after DNS setup)

### DNS for relay.aimux.app

Add a CNAME record in Cloudflare DNS:

- Name: `relay`
- Target: `aimux-relay.<your-subdomain>.workers.dev`
- Proxy: enabled (orange cloud)

Or use Cloudflare custom domains (configured in `wrangler.toml`). The production
environment repeats the Durable Object binding because Wrangler environment
bindings are not inherited from the top-level Worker config.

## 3. Web App

### Environment Variables

Set in your hosting platform (Vercel, etc.):

```env
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
# Optional overrides:
# EXPO_PUBLIC_AIMUX_CONNECTION_MODE=relay
# EXPO_PUBLIC_AIMUX_RELAY_URL=wss://relay.aimux.app
```

`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is required for relay/production builds.
Local mode may omit it and will run with local-only auth.
Production builds default `EXPO_PUBLIC_AIMUX_CONNECTION_MODE` to `relay`, so
only set it when forcing a local build. Set `EXPO_PUBLIC_AIMUX_RELAY_URL` only
when pointing the app at a staging or self-hosted relay.

### Deploy to Vercel

Configure the Vercel project with:

- Root Directory: `app`
- Build Command: `yarn export:web`
- Output Directory: `dist`
- Install Command: `yarn install --frozen-lockfile`

The committed `app/vercel.json` mirrors those settings and rewrites all app
routes back to `/`, which is required because Expo is configured with
`web.output: "single"`.

```bash
cd app
vercel deploy --prod
```

### DNS for aimux.app

Point aimux.app to Vercel:

- A record → Vercel's IP
- Or CNAME → cname.vercel-dns.com

## 4. Local Daemon Setup

Once `AIMUX_RELAY_URL` points at your deployed relay, users authorize
their local daemon via the browser:

```bash
aimux login
```

This opens the web app at `${AIMUX_WEB_APP_URL}/cli-auth` (defaulting to `https://aimux.app`, or `http://localhost:8081` for `aimux-dev`), mints a
long-lived (~90d) HS256 daemon token at the relay, and stores it locally
at `~/.aimux/auth.json`. The daemon picks it up on next start, or
`aimux remote enable` connects without a restart.

The relay URL may also be overridden by setting `AIMUX_RELAY_URL` in the
environment; it defaults to `wss://relay.aimux.app`.
Server-side, the relay needs `CLERK_SECRET_KEY` (verifies the user's
Clerk session during `aimux login`) and `RELAY_TOKEN_SECRET` (signs the
HS256 daemon tokens it mints).

## 5. Native App (iOS/Android)

```bash
cd app
# TestFlight
yarn build:testflight

# Production
yarn build:production
```

Environment variables are baked into the native bundle at build time via `app.config.js`.

## Architecture

```text
User's machine                    Cloud                        User's phone/laptop
┌──────────┐                ┌──────────────┐                ┌──────────────┐
│  aimux   │───WS tunnel───│  Cloudflare   │───WS tunnel───│  aimux app   │
│  daemon  │                │  Relay (DO)   │                │  (web/native)│
└──────────┘                └──────────────┘                └──────────────┘
     │                            │                               │
     │ localhost:43190            │ relay.aimux.app                │
     │ HS256 daemon token         │ Clerk session JWT              │
     │                            │                               │
     └────────────────────────────┴───────────────────────────────┘
            Daemon: HS256 minted by relay     App: Clerk session JWT
```

## Security Notes

- The relay verifies tokens by shape: app connections present a Clerk session
  JWT (verified with `@clerk/backend` against `CLERK_SECRET_KEY`); daemon
  connections present a relay-minted HS256 token signed with `RELAY_TOKEN_SECRET`
  (issued via `POST /cli/issue-token` during `aimux login`).
- Every remote client connection sends a local daemon notification. First-time
  clients also create a security event, notify other connected clients, send
  Expo push notifications to registered native clients, and send email when
  `RESEND_API_KEY` and `SECURITY_EMAIL_FROM` are configured.
- Security alert emails and push payloads include a single-use emergency
  lockdown link. Lockdown closes relay sockets, revokes existing daemon tokens,
  and blocks remote access until the user runs `aimux security unlock` from a
  local CLI.
- Each user gets an isolated Durable Object — no cross-user data leakage.
- Within a user's DO, in-flight request IDs are routed back to the requesting
  client only, so multiple clients (e.g. desktop + phone) don't see each other's
  responses.
- The daemon's `/proxy` route only forwards to loopback hosts and applies a
  bounded timeout; out-of-allowlist hosts return 403.
- WS tokens are passed as query params (standard for browser WS auth, since
  WebSocket upgrades can't carry custom Authorization headers).
