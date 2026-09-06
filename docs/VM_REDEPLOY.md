# VM redeploy

How to update the signaling server on a VM and restart it, using a reusable `redeploy` shell function.

## Layout

| Item | Value |
| --- | --- |
| Repo path on VM | `/home/wetalk/repos/studious-robot` |
| Server path | `/home/wetalk/repos/studious-robot/server` |
| Repo owner (file ownership) | `wetalk` |
| Admin user (systemd) | `ubuntu` |
| Service unit | `robot-signal.service` |

The deploy spans two users: the checkout is owned by `wetalk`, while `systemctl` requires `sudo` as `ubuntu`. The function below handles both without an interactive shell switch.

## Manual steps

```bash
sudo -u wetalk -H bash -lc "cd /home/wetalk/repos/studious-robot && git pull --ff-only && cd server && npm i --omit=dev"
sudo systemctl restart robot-signal.service
sudo systemctl status robot-signal.service --no-pager
```

Do not use `sudo su - wetalk && cd ...`. `su -` opens an interactive shell, so anything chained after `&&` runs in the original shell only after logout, in the wrong working directory.

## Install the `redeploy` function

Run once per VM, as the `ubuntu` user:

```bash
cat >> ~/.bashrc <<'EOF'

redeploy() {
  local repo=/home/wetalk/repos/studious-robot
  local svc=robot-signal.service
  sudo -u wetalk -H bash -lc "
    set -euo pipefail
    cd '$repo'
    git pull --ff-only
    cd server
    npm i --omit=dev
  " || { echo 'redeploy: install failed, not restarting'; return 1; }
  sudo systemctl restart "$svc"
  sudo systemctl status "$svc" --no-pager
}
EOF
source ~/.bashrc
```

The `<<'EOF'` quoting is required: the quotes around `EOF` prevent `$repo` and `$svc` from being expanded while the file is written, so the function body lands verbatim.

Verify:

```bash
type redeploy   # expect: "redeploy is a function"
```

Then deploy with:

```bash
redeploy
```

## Notes

- `set -euo pipefail` aborts before the restart if `git pull` or `npm i` fails, so the service is never restarted onto a half-updated tree.
- `--ff-only` prevents surprise merge commits on the VM.
- `--omit=dev` skips devDependencies; the unit runs TypeScript directly via Node's type stripping, so no build step is needed.
- New SSH sessions pick the function up automatically. `source ~/.bashrc` is only needed in the shell where it was added.

## Troubleshooting

**`syntax error near unexpected token '('` when sourcing `~/.bashrc`**

An alias named `redeploy` is defined earlier in the file. Bash expands aliases at parse time, so it substitutes the alias text and fails on the `(` of the function definition. Keep only the function:

```bash
grep -n "alias redeploy" ~/.bashrc
sed -i "/^alias redeploy=/d" ~/.bashrc
unalias redeploy 2>/dev/null
source ~/.bashrc
```

**`npm warn install-scripts` for `@firebase/util` and `protobufjs`**

Expected. Their `postinstall` scripts are blocked by the `allowScripts` policy. Harmless in normal operation; revisit only if protobuf/gRPC behaviour looks wrong. Review with `npm install-scripts ls`.

## Verifying after deploy

A healthy restart shows `Active: active (running)` with a new main PID:

```
● robot-signal.service - robot-signal signaling server
     Loaded: loaded (/etc/systemd/system/robot-signal.service; enabled; preset: enabled)
     Active: active (running) since Sun 2026-09-06 18:56:47 UTC; 202ms ago
   Main PID: 7430 (node)
      Tasks: 6 (limit: 1036)
     Memory: 3.5M (peak: 3.5M)
     CGroup: /system.slice/robot-signal.service
             └─7430 /usr/bin/node src/index.ts
```

`Tasks`, `Memory`, and `CPU` are totals for the unit's systemd cgroup, covering every process it spawned — not just the main PID.

Follow the logs if the restart fails:

```bash
journalctl -u robot-signal.service -n 100 --no-pager
journalctl -u robot-signal.service -f
```

## Resource monitoring

Memory right after restart (~3.5 MB) is not the steady state. Once V8's heap warms up and connections open, expect roughly 70–75 MB. V8 does not return memory to the OS eagerly, so a plateau well above cold start is normal.

```bash
systemd-cgls /system.slice/robot-signal.service   # process tree in the cgroup
systemd-cgtop                                     # live per-cgroup CPU/memory
cat /sys/fs/cgroup/system.slice/robot-signal.service/memory.current   # bytes
```

Watch the trend; steady growth that never flattens indicates a leak, most likely retained signaling sessions or listeners not removed on disconnect:

```bash
watch -n 60 'cat /sys/fs/cgroup/system.slice/robot-signal.service/memory.current'
```

### Observed baseline

Measured on a 1 GB OCI instance:

| CGroup | Tasks | Memory |
| --- | --- | --- |
| `/` (system total) | 219 | 483.1M |
| `system.slice` | 122 | 451.4M |
| `…/oracle-cloud-agent.service` | 42 | 117.8M |
| `robot-signal.service` | 11 | 73.3M |
| `user.slice` (SSH session) | 6 | 165.0M |
| `nginx.service` | 3 | 6.3M |

### Optional hardening

Only apply after observing the steady state for at least a day, and always set the cap above it. A limit below current usage causes an immediate OOM kill on restart, turning `redeploy` into an outage.

```ini
[Service]
MemoryHigh=256M
MemoryMax=384M
Restart=always
RestartSec=2
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart robot-signal.service
```

With `MemoryMax`, the kernel constrains this cgroup alone instead of letting the system-wide OOM killer choose a victim such as `sshd`.

`fwupd` and `ModemManager` serve no purpose on a cloud VM and can be disabled to reclaim ~20 MB:

```bash
sudo systemctl disable --now ModemManager fwupd
```

`oracle-cloud-agent` is heavier than the application itself, but it provides metrics and management. Trim individual plugins under `/etc/oracle-cloud-agent/plugins/` rather than stopping the service.