# aimux egress sandbox

Optional. Default-denies outbound network access for the uid that runs agent
sessions, and permits it back through a domain allowlist. Linux + systemd +
nftables only.

Read [docs/security.md](../../docs/security.md) before running anything here,
including the part about when *not* to install it.

```bash
cp sandbox.conf.example sandbox.conf   # edit
sudo ./install.sh                      # prints the plan and stops
sudo ./install.sh --yes
sudo ./verify.sh
```

| | |
|---|---|
| `aimux-egress.nft` | the policy; loaded before the network exists |
| `tinyproxy.conf` | loopback proxy, deny-by-default, CONNECT to 443 only |
| `allowlist.txt` | **the policy you edit** — hostnames, anchored |
| `pinned-hosts.example` | host+port pairs for protocols the proxy cannot carry |
| `resolve-pinned-hosts.sh` | refreshes those addresses; fails loudly when one stops resolving |
| `install.sh` / `uninstall.sh` / `verify.sh` | apply, reverse, prove |
| `test/` | resolver tests; safe on a live box |
