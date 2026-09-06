# Phase 8 evidence — why `build-win-native` was not deployed to

Date: 2026-09-06 (15:53–15:57 local). Host running the probes: Ken's macOS
workstation, the same machine Phases 1–7 ran on.

Plan Phase 8 task 1 is *"deploy the current release binary to `build-win-native`
over SSH (PowerShell, port 2222) and capture `--version` identity there"*. It was
**not performed**, and this file is the diagnosis, so that `not performed` is a
finding rather than a shrug. Reproduce the whole chain with
[`win-preflight.sh --lan-probe`](./win-preflight.sh).

## 1. The alias resolves; the host does not answer

`~/.ssh/config` maps `build-win-native` → `192.168.100.64` port 2222 (the
Windows/PowerShell side; `build-win` is the same box's WSL side on port 22 and is
**not** the target — spec §6.4).

```
$ ssh -o BatchMode=yes -o ConnectTimeout=10 build-win-native 'echo CONNECTED'
ssh: connect to host 192.168.100.64 port 2222: Network is unreachable

$ nc -vz -G 6 192.168.100.64 2222   # Windows/PowerShell side
nc: connectx to 192.168.100.64 port 2222 (tcp) failed: Network is unreachable
$ nc -vz -G 6 192.168.100.64 22     # WSL side, for completeness
nc: connectx to 192.168.100.64 port 22 (tcp) failed: Network is unreachable
```

Re-run with the tool sandbox disabled: identical. So it is not a sandbox policy.

## 2. It is not the network either

The workstation is on `192.168.10.0/24` and the build LAN is `192.168.100.0/24`,
which invites the easy wrong conclusion "wrong site, no route". Two controls kill
it:

```
$ nc -vz -G 6 github.com 443
Connection to github.com port 443 [tcp/https] succeeded!        # internet: up

$ nc -vz -G 6 192.168.100.14 22                                 # monster, same LAN
Connection to 192.168.100.14 port 22 [tcp/ssh] succeeded!       # that LAN: routed
```

`route -n get 192.168.100.64` returns the ordinary default route via
`192.168.10.1` on `en0`. Packets for that subnet leave and are delivered — for
hosts that exist. `192.168.100.143` (`build-linux`) is unreachable in the same
way, which is the first hint that this is about hosts, not routes.

## 3. From a neighbour on the same L2 segment: the host is not there

`monster` (`192.168.100.14`) is on the build LAN and answers. Asked to look for
the target (read-only probes only):

```
$ ssh monster 'ping -c 2 -W 2 192.168.100.64; ip neigh show 192.168.100.64'
2 packets transmitted, 0 received, 100% packet loss, time 1033ms
192.168.100.64 dev vmbr0.100 FAILED          # later re-probe: INCOMPLETE
```

ARP resolution failing on the same broadcast domain is conclusive: **nothing is
answering for that address.** The host is powered off, not firewalled, not
mis-addressed, and not refusing our key.

## 4. Why it is off, and why Phase 8 did not turn it on

`build-win` is a guest on that hypervisor, and it is stopped:

```
$ ssh monster 'qm list'
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       701 build-win            stopped    32768            400.00 0
```

Starting it is exactly the action Phase 8 wanted, and the plan names this host,
so it was attempted:

```
$ ssh monster 'qm start 701; qm status 701'
cluster not ready - no quorum?
status: stopped
```

```
$ ssh monster 'pvecm status'
Cluster information:  Name: venice-cluster   Nodes: 2
Quorum information:   Quorate: No
Votequorum:           Expected votes: 4   Total votes: 2   Quorum: 3 Activity blocked
Membership:           0x00000001 192.168.100.2 · 0x00000004 192.168.100.14 (local)
```

Two of the cluster's four votes are missing, so `Activity blocked`: the
hypervisor will not start *any* guest until quorum returns. Forcing it
(`pvecm expected …`) is a change to the user's cluster configuration, not a
Phase 8 step, and was **not** done. Nothing on that infrastructure was modified
by this phase: one refused `qm start`, and otherwise read-only probes.

**Operator remediation:** restore cluster quorum (bring the other Proxmox nodes
back), `qm start 701` on `monster`, wait for `build-win-native` to answer on
2222, then re-run `win-preflight.sh` — it captures the identity rows on its own —
and follow the Windows runbook in the acceptance checklist. Note the script's own
honest limit: only its *unreachable* branch has ever executed (everything quoted
above); its identity-capture branch is a first draft that no live host has run.

## 5. No Windows artifact could be built here either

Even with the host up, "deploy the current release binary" has no macOS-side
shortcut, and it is worth recording precisely how far a cross-build gets, since
AGENT.md's note ("cross-checking from macOS fails in `aws-lc-sys`, not in our
code") is what the runbook's build-on-host step rests on. Both targets were
tried at this commit (rustc 1.98.1, `aws-lc-sys` 0.41.0):

| Target | Command | Result |
|---|---|---|
| `x86_64-pc-windows-msvc` | `cargo check --target x86_64-pc-windows-msvc -p excalidraw-preview-binary --all-targets` | **fails**, exactly as AGENT.md records — `aws-lc-sys` build script, `jitterentropy-base-windows.h:49: fatal error: 'windows.h' file not found`. Our crate is never reached. |
| `x86_64-pc-windows-gnu` | same, with `CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc` `AR_…=x86_64-w64-mingw32-ar` | **passes** — `aws-lc-sys` finds mingw's `windows.h`, and `excalidraw-preview-binary v0.6.0` type-checks for Windows with `muda`, `tao`, `webview2-com` and `rust-embed` in the graph. `--all-targets`, so the bin, its `#[cfg(test)]` unit and `tests/integration.rs` were all checked (`target/x86_64-pc-windows-gnu/debug/deps/` holds both `excalidraw_preview` rmeta units and `integration-*`). Zero warnings. |

So AGENT.md's trap is real but is specifically the **MSVC** target lacking the
Windows SDK headers; with mingw headers the same source type-checks for Windows
from macOS. That is a *compile-level* result only: it links nothing, embeds no
WebView2 loader, and cannot be shipped or deployed — and a `-gnu` artifact would
not be "the current release binary" anyway (releases build MSVC). It de-risks the
Windows column at the level it can: the `#[cfg(target_os = "windows")]` menu
attachment (`main.rs:3022-3029`, `menu.init_for_hwnd`) and every Windows twin in
the test files compile at this commit. It cannot say a single pixel about the
matrix.

## 6. What this does *not* excuse

The Windows GUI cells were never going to be executable in this session — they
need an interactive Windows desktop (RDP or physical console) and a human, which
spec §6.4 states outright. The host being down removes the *other* half too (SSH
deployment plus identity capture), which is the half that was in reach. Both are
recorded `not performed` in the acceptance checklist with these reasons, per the
escalation rule resolved in the decision log's Phase 8 entry.
