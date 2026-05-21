# Aimux Deployment Guide

## Prerequisites

- Clerk account with a production application
- Cloudflare account with Workers + Durable Objects enabled
- Domain: aimux.com (or your domain) with DNS managed by Cloudflare
- Vercel account (for the web app) or EAS (for native builds)

## 1. Clerk Setup

1. Create a Clerk application at https://dashboard.clerk.com
2. Enable email + password sign-in method
3. Note your keys:
   - **Publishable key** (pk_live_...) — used by the app
   - **Secret key** (sk_live_...) — used by the daemon and relay

## 2. Relay Server (Cloudflare Worker)

```bash
cd relay
yarn install

# Login to Cloudflare
wrangler login

# Set the Clerk secret key
wrangler secret put CLERK_SECRET_KEY
# Paste your sk_live_... key

# Deploy (dev)
wrangler deploy

# Deploy (production with custom domain)
wrangler deploy --env production
```

The relay will be available at:
- Dev: `https://aimux-relay.<your-subdomain>.workers.dev`
- Production: `https://relay.aimux.com` (after DNS setup)

### DNS for relay.aimux.com

Add a CNAME record in Cloudflare DNS:
- Name: `relay`
- Target: `aimux-relay.<your-subdomain>.workers.dev`
- Proxy: enabled (orange cloud)

Or use Cloudflare custom domains (configured in wrangler.toml).

## 3. Web App

### Environment Variables

Set in your hosting platform (Vercel, etc.):

```
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
EXPO_PUBLIC_AIMUX_RELAY_URL=wss://relay.aimux.com
```

### Deploy to Vercel

```bash
cd app
vercel deploy --prod
```

### DNS for aimux.com

Point aimux.com to Vercel:
- A record → Vercel's IP
- Or CNAME → cname.vercel-dns.com

## 4. Local Daemon Setup

Once `AIMUX_RELAY_URL` points at your deployed relay, users authorize
their local daemon via the browser:

```bash
aimux login
```

This opens the web app at `${EXPO_PUBLIC_WEB_APP_URL}/cli-auth`, mints a
long-lived (~90d) HS256 daemon token at the relay, and stores it locally
at `~/.aimux/auth.json`. The daemon picks it up on next start, or
`aimux remote enable` connects without a restart.

`AIMUX_RELAY_URL` may also be set in the environment as an override.
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

Environment variables are baked into the native bundle at build time via `app.config.ts`.

## Architecture

```
User's machine                    Cloud                        User's phone/laptop
┌──────────┐                ┌──────────────┐                ┌──────────────┐
│  aimux   │───WS tunnel───│  Cloudflare   │───WS tunnel───│  aimux app   │
│  daemon  │                │  Relay (DO)   │                │  (web/native)│
└──────────┘                └──────────────┘                └──────────────┘
     │                            │                               │
     │ localhost:43190            │ relay.aimux.com                │
     │ (direct access)           │ (Clerk JWT auth)               │
     │                            │                               │
     └────────────────────────────┴───────────────────────────────┘
                          All authenticated via Clerk
```

## Security Notes

- The relay verifies Clerk JWTs on both daemon and client connections
- Each user gets an isolated Durable Object — no cross-user data leakage
- The daemon's proxy route only forwards to localhost metadata servers
- WS tokens are passed as query params (standard for browser WS auth)
- The daemon skips auth when CLERK_SECRET_KEY is unset (LOCAL_MODE)
