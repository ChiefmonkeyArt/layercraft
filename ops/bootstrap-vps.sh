#!/usr/bin/env bash
# bootstrap-vps.sh — ONE-TIME privileged setup for the restricted Layercraft
# deploy key. Run as root on the VPS by the owner. Idempotent: safe to re-run.
#
#   sudo bash bootstrap-vps.sh <ssh-ed25519 base64 blob> [git ref]
#
# It leaves behind NO broad sudo: the only new capability is a forced-command
# key that can run /usr/local/bin/layercraft-deploy (an allowlist-checking
# dispatcher) and its pinned root installer through ONE fixed sudoers rule.
#
# The dispatcher and installer are installed byte-for-byte from ops/ in the
# repository. Either the caller prepends LAYERCRAFT_DISPATCHER_B64=... and
# LAYERCRAFT_INSTALLER_B64=..., or a git ref (ideally a full commit sha, which
# can't change) is given and both files are fetched from GitHub at that ref.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
PUBKEY_BLOB="${1:-}"
REF="${2:-}"
REPO="ChiefmonkeyArt/layercraft"

if [[ -z "$PUBKEY_BLOB" || ! "$PUBKEY_BLOB" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  echo "error: expected an ssh-ed25519 public-key base64 blob (no spaces) as \$1" >&2
  exit 1
fi
PUBKEY="ssh-ed25519 ${PUBKEY_BLOB}"
getent passwd "$DEPLOY_USER" >/dev/null || { echo "error: user '$DEPLOY_USER' does not exist" >&2; exit 1; }
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
command -v nginx >/dev/null || { echo "error: nginx not found" >&2; exit 1; }
[[ -x /usr/local/bin/torii ]] || { echo "error: Torii Base 'torii' CLI not found at /usr/local/bin/torii" >&2; exit 1; }

BIN="/usr/local/bin/layercraft-deploy"
ROOT_INSTALL="/usr/local/sbin/layercraft-install-root"
STAGE_DIR="/var/lib/layercraft-deploy"
SUDOERS="/etc/sudoers.d/layercraft-deploy"
AUTHKEY="${DEPLOY_HOME}/.ssh/authorized_keys"

if [[ -z "${LAYERCRAFT_DISPATCHER_B64:-}" || -z "${LAYERCRAFT_INSTALLER_B64:-}" ]]; then
  [[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "error: give the git ref to install from as \$2" >&2; exit 1; }
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/${REPO}/${REF}/ops/$1" | base64 -w0; }
  LAYERCRAFT_DISPATCHER_B64="$(fetch layercraft-deploy)"
  LAYERCRAFT_INSTALLER_B64="$(fetch layercraft-install-root)"
fi

echo "==> deploy user: $DEPLOY_USER (home $DEPLOY_HOME)"
install_pinned() { # <b64> <dest>
  local b64="$1" dest="$2" tmp
  [[ -n "$b64" && "$b64" =~ ^[A-Za-z0-9+/=]+$ ]] || { echo "error: missing/invalid payload for $dest" >&2; exit 1; }
  tmp="$(mktemp "${dest}.XXXXXX")"
  printf '%s' "$b64" | base64 -d > "$tmp"
  bash -n "$tmp" || { rm -f "$tmp"; echo "error: $dest failed syntax check" >&2; exit 1; }
  chown root:root "$tmp"; chmod 0755 "$tmp"; mv -f "$tmp" "$dest"
  echo "==> installed $dest sha256=$(sha256sum "$dest" | cut -d' ' -f1)"
}
install -d -m 0755 /usr/local/bin /usr/local/sbin
install_pinned "$LAYERCRAFT_DISPATCHER_B64" "$BIN"
install_pinned "$LAYERCRAFT_INSTALLER_B64" "$ROOT_INSTALL"
install -d -m 0700 -o root -g root /var/backups/layercraft
install -d -m 0755 /apps

install -d -m 0755 "$STAGE_DIR"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$STAGE_DIR"

printf '# layercraft-deploy: the deploy user may run ONLY the pinned root installer.\n%s ALL=(root) NOPASSWD: %s\n' "$DEPLOY_USER" "$ROOT_INSTALL" > "$SUDOERS.tmp"
chmod 0440 "$SUDOERS.tmp"; chown root:root "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null || { rm -f "$SUDOERS.tmp"; echo "sudoers syntax error" >&2; exit 1; }
mv -f "$SUDOERS.tmp" "$SUDOERS"

install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
touch "$AUTHKEY"; chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"
ENTRY="command=\"${BIN}\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${PUBKEY} layercraft-deploy@github-actions"
grep -vF "${PUBKEY}" "$AUTHKEY" > "$AUTHKEY.tmp" 2>/dev/null || true
mv "$AUTHKEY.tmp" "$AUTHKEY"
printf '%s\n' "$ENTRY" >> "$AUTHKEY"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AUTHKEY"; chmod 0600 "$AUTHKEY"

count="$(grep -cF "$PUBKEY" "$AUTHKEY" || true)"
[[ "$count" -eq 1 ]] || { echo "error: key did not land in authorized_keys" >&2; exit 1; }
echo "==> restricted key present once in $AUTHKEY"
echo "==> host key for the deploy workflow: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print $2}')"
echo "bootstrap complete: restricted layercraft deploy key authorized"
