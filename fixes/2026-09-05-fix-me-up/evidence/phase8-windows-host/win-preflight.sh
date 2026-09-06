#!/usr/bin/env bash
# Phase 8 preflight: is `build-win-native` reachable, and if so, what is on it?
#
# Plan task 1 ("deploy the current release binary over SSH and capture
# `--version` identity there") has one precondition the spec does not state
# because it was assumed: the host has to be up. On 2026-09-06 it was not, and
# the reason took four probes to pin down (see `reachability.md` beside this
# file). This script is those probes, in order, so the next attempt is one
# command instead of four — and so a future `not performed` is never a shrug.
#
# It is READ-ONLY. It starts nothing, deploys nothing and writes nothing
# anywhere; the deploy itself is the operator runbook's step, deliberately not
# automated against a host no one has been able to reach yet.
#
# Honest limit: only the *unreachable* branch has ever run (2026-09-06, output
# quoted in `reachability.md`). The identity-capture branch below has never been
# executed against a live host — treat its PowerShell as a first draft and check
# what it prints before pasting it into the checklist.
#
# Usage:
#
#   ./win-preflight.sh                # probe the host; capture identity if it is up
#   ./win-preflight.sh --lan-probe    # also ask a reachable neighbour on the
#                                     # target LAN whether it can see the host
#                                     # (opt-in: it logs into a third machine)
#   ./win-preflight.sh --host H --port P --neighbour N
#
# Exit status: 0 = host reachable and identity captured, 1 = host unreachable
# (diagnosis printed), 2 = reachable but the identity capture failed.

set -uo pipefail

HOST=build-win-native   # ssh alias: the Windows/PowerShell side, port 2222
PORT=2222
NEIGHBOUR=monster       # a host on the same LAN (192.168.100.0/24) that answers
LAN_PROBE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --neighbour) NEIGHBOUR=$2; shift 2 ;;
    --lan-probe) LAN_PROBE=1; shift ;;
    -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

say() { printf '\n== %s\n' "$1"; }

# The IP `ssh` will actually dial, resolved from ~/.ssh/config rather than
# assumed — the alias is the thing under test, not the address.
ADDR=$(ssh -G "$HOST" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
ADDR=${ADDR:-$HOST}

say "target"
echo "alias:    $HOST"
echo "address:  $ADDR port $PORT"

say "local route"
route -n get "$ADDR" 2>&1 | sed -n '1,6p' || ip route get "$ADDR" 2>&1 | head -2

say "tcp reachability"
if command -v nc >/dev/null 2>&1; then
  nc -vz -G 6 "$ADDR" "$PORT" 2>&1 | head -2
  TCP=${PIPESTATUS[0]}
else
  timeout 8 bash -c "cat < /dev/null > /dev/tcp/$ADDR/$PORT" 2>&1
  TCP=$?
fi

if [ "$TCP" -eq 0 ]; then
  say "identity capture (the point of the exercise)"
  # PowerShell on the far side. `where.exe` is the Windows `which -a`: it lists
  # every candidate on PATH, which is what makes D2 §2.2 candidate 1 (a stale
  # binary preferred over the deployed one) visible rather than invisible.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
    '[System.Environment]::OSVersion.VersionString;
     (Get-CimInstance Win32_OperatingSystem).Caption;
     $env:COMPUTERNAME;
     where.exe excalidraw-preview;
     excalidraw-preview --version'
  rc=$?
  [ $rc -eq 0 ] || { echo "identity capture failed (ssh rc=$rc)" >&2; exit 2; }
  echo
  echo "Paste the above into the acceptance checklist's build-identity table."
  exit 0
fi

say "host is NOT reachable — diagnosis"
echo "TCP connect to $ADDR:$PORT failed (rc=$TCP)."
echo "Rule out the boring causes before blaming the network:"
echo "  * a control host on the same LAN answering proves the route is fine;"
echo "  * a failed/incomplete ARP entry for $ADDR proves the host is down."

if [ "$LAN_PROBE" -eq 1 ]; then
  say "LAN probe via $NEIGHBOUR (opt-in)"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$NEIGHBOUR" "
    ping -c 2 -W 2 $ADDR 2>&1 | tail -2
    ip neigh show $ADDR 2>/dev/null
    command -v qm >/dev/null 2>&1 && qm list 2>&1 | head -20
    command -v pvecm >/dev/null 2>&1 && pvecm status 2>&1 | sed -n '/Quorum information/,/Flags/p'
  " 2>&1 | sed 's/^/  /'
  echo
  echo "An ARP entry in state FAILED/INCOMPLETE, plus the VM listed 'stopped',"
  echo "means the host is powered off — start it before re-running. If"
  echo "'Quorate: No' also appears, the hypervisor cannot start it at all until"
  echo "cluster quorum is restored; that is an infrastructure step, not a"
  echo "Phase 8 step."
else
  echo "Re-run with --lan-probe to have $NEIGHBOUR answer both questions."
fi

exit 1
