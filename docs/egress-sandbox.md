# Egress Sandbox

## Status

Optional profile. Off unless installed, and most hosts should leave it off.

Assets live in [`deploy/sandbox/`](../deploy/sandbox). Linux, systemd and
nftables only.

## What it is for

[Hosted mode](./hosted-mode.md) bounds what an *operator* can do: three routes on
the sessions they were granted. It does not bound what the *agent* can do,
and the RFC says so plainly — an operator who can send text to a session is
talking to a tool with a shell. The boundary that carries weight is the machine
and its credentials.

This profile is that boundary, for hosts that want one. It default-denies
outbound network access for the uid that runs agent sessions, and permits it
back through a domain allowlist.

**Do not install this by reflex.** It is the right answer when the sessions on a
box are driven by people you do not fully trust, or work on material that must
not leave. It is the wrong answer for a box whose whole purpose is to reach
things — an admin's own agent, a machine wired into a dozen third-party APIs.
There the allowlist needs a new entry for every integration and buys nothing
against the actual failure mode, which is a well-intentioned instruction that
does damage. Backups are the control there, not a firewall.

## What it does

Three layers, and each one is load-bearing:

| | |
|---|---|
| `nftables` | default-deny outbound for the runtime uid; its own table, so `nft flush ruleset` from ufw or docker cannot take it along |
| `tinyproxy` | loopback-only, `FilterDefaultDeny`, `ConnectPort 443` — a hostname absent from the allowlist is unreachable |
| DNS | fully closed for that uid, which is what makes the other two mean anything |

Anything speaking HTTP goes through the proxy, where the rule is a **name**.
Anything that cannot — Postgres, Redis, a broker — is pinned by
address-and-port in `pinned-hosts`, refreshed on a timer.

### Why DNS is a whole layer

This is the part that is not obvious, and it was found the wrong way round:
with UDP 53 dropped and everything looking correct, `resolvectl query` from the
runtime user demonstrably still sent a name upstream.

Blocking UDP 53 does nothing on a stock Ubuntu box. glibc resolves through the
`resolve` NSS module over a UNIX socket, and `resolvectl` goes over D-Bus — and
in both cases systemd-resolved performs the lookup as **its own** uid, which any
"not the agent" rule accepts. Neither path emits a packet a filter can see.

So the installer does two more things, both host-wide:

- `/etc/nsswitch.conf` set to `hosts: files dns`, closing the NSS path
- `systemd-resolved` **masked**, which is the only thing that closes the D-Bus
  path — disabling alone leaves a socket-activated unit that comes straight back

A static `/etc/resolv.conf` is written first, from the resolvers the box was
already using, so it is never without one.

Left open, DNS is an arbitrary-rate covert channel out of the box wearing the
one uid the table exists to contain.

## Installing

Prerequisites, on Debian/Ubuntu:

```bash
apt-get install -y nftables tinyproxy dnsutils util-linux
```

Then, on the box, as root:

```bash
cd deploy/sandbox
cp sandbox.conf.example sandbox.conf   # set SANDBOX_USER and SANDBOX_AIMUX_UNIT
./install.sh                           # prints the plan and stops
./install.sh --yes                     # applies it
```

`SANDBOX_USER` must not be the account you administer the box with. The policy
matches on uid, and it cannot tell an agent apart from a human sharing one.

The installer parses the ruleset with `nft -c` before loading anything, so a
typo fails immediately rather than at the next boot. It never overwrites
`allowlist.txt` or `pinned-hosts` once they exist — those two files *are* the
policy, and an upgrade that quietly reset them would silently change what the
agent can reach.

Two steps are left to you, and it says so at the end:

1. `systemctl restart <your aimux unit>` — the drop-in does not reach a running
   daemon. Until then agents launch without the proxy variables and every
   outbound call is dropped rather than proxied.
2. `./verify.sh`.

### The drop-in

aimux does not ship a systemd unit; the host owns that. `install.sh` writes
[`10-sandbox.conf`](../deploy/sandbox/systemd/aimux.service.d/10-sandbox.conf)
into `<your-unit>.d/`, which does two things:

- `Requires=aimux-egress.service`, not merely `After=`. With ordering alone,
  restarting aimux while the policy happened to be stopped would produce a
  daemon with unrestricted outbound and no sign anything was wrong.
- Sets `HTTPS_PROXY` and friends **on the daemon**. The daemon launches every
  pane through `env -i` with a fixed allowlist
  ([`src/managed-launch-env.ts`](../src/managed-launch-env.ts)), so a proxy
  variable set anywhere else reaches the daemon and stops there. Both cases are
  set, because Node reads the upper-case spelling, Rust's `reqwest` reads
  either, and curl reads the lower-case one.

## Verifying

```bash
./verify.sh
```

It probes as the sandboxed uid rather than reading the ruleset, because reading
the ruleset is not evidence — see the DNS section above. It checks that an
allowlisted host connects, an unlisted one gets `403`, a direct connection
bypassing the proxy is dropped, all three DNS paths are dead, and that each
pinned endpoint is reachable on its port *and not on another one*.

It reads `%{http_connect}` rather than `%{http_code}`: for a tunnelled request
the latter reads `000` whether the proxy refused with 403 or was never
listening, so a dead proxy would score as a working denial.

The resolver has its own test, which is safe to run on a live box — the table it
builds has the sets but no chain, so it hooks nothing:

```bash
sudo deploy/sandbox/test/resolve-pinned-hosts.test.sh
```

## Adding a capability

Editing [`allowlist.txt`](../deploy/sandbox/allowlist.txt) and reloading
tinyproxy. **Anchor every line** — an unanchored `openai\.com` also matches
`openai.com.exfiltrate.example`, which is a hostname an attacker controls.

The shipped file enables model APIs only. Package registries and git forges are
present but commented out, because each is a real widening and a sandbox whose
allowlist grew by default is not a sandbox. Enabling GitHub in particular gives
an agent `git push`, which is an unmetered way for anything in the working tree
to leave the box.

The OpenAI entries were verified end-to-end from a sandboxed uid. The Anthropic
entries come from published endpoints and were not; `verify.sh` is how you find
out on your host. A missing name shows up as an agent that starts fine and then
hangs on its first turn.

## What it does not solve

- **A model API is itself a channel out.** An agent that wants to leak can put
  data in a prompt. This bounds where it can go, not whether a determined
  injection can say anything at all.
- **Pinned endpoints are IP rules, and IP rules go stale.** A managed database's
  addresses are usually not contractually stable. Two things are built for that:
  set entries expire unless re-confirmed, and the resolver exits non-zero when a
  name stops resolving, so it surfaces as a failed unit rather than as an agent
  that mysteriously lost its database days later.
- **Loopback is not filtered**, and cannot be from a daemon sharing the uid.
- **It is not host hardening.** Root still runs apt and a human with a shell is
  unaffected. This bounds one uid.

## Removing it

```bash
./uninstall.sh --yes
```

Order matters, and the script encodes it: DNS is restored last, with the static
`resolv.conf` working right up until systemd-resolved is back to answer through
the symlink. Doing this by hand once produced a box that briefly could not
resolve anything.

It also deletes the nft table explicitly, because the unit deliberately does not
flush on stop — stopping a unit should never be a quiet way to unfilter a
running agent. `/etc/aimux/sandbox` is left in place; it holds your allowlist,
your pinned hosts, and the backups.
