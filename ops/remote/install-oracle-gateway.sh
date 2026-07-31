#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  sudo NEXUS_TUNNEL_PUBLIC_KEY='ssh-ed25519 ...' \
    ./ops/remote/install-oracle-gateway.sh HOST [cloudflare|direct]

Installs a dedicated reverse-tunnel identity and a Caddy route. Cloudflare
mode expects an existing :80 Caddy site behind a Cloudflare Tunnel. Direct
mode expects public TCP 80/443 and lets Caddy obtain the TLS certificate.
EOF
}

public_host=${1:-}
gateway_mode=${2:-cloudflare}
public_key=${NEXUS_TUNNEL_PUBLIC_KEY:-}
tunnel_user=nexusos-tunnel
tunnel_port=3410
caddy_file=/etc/caddy/Caddyfile
caddy_snippet=/etc/caddy/nexusos-remote.caddy
ssh_dropin=/etc/ssh/sshd_config.d/60-nexusos-tunnel.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if ! printf '%s' "$public_host" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$'; then
  usage >&2
  exit 1
fi
if [ "$gateway_mode" != cloudflare ] && [ "$gateway_mode" != direct ]; then
  usage >&2
  exit 1
fi
case "$public_key" in
  ssh-ed25519\ *) ;;
  *)
    echo "NEXUS_TUNNEL_PUBLIC_KEY must contain one ssh-ed25519 public key." >&2
    exit 1
    ;;
esac
case "$public_key" in
  *'
'*|*''*)
    echo "The tunnel public key must be one line." >&2
    exit 1
    ;;
esac
command -v caddy >/dev/null
command -v sshd >/dev/null
test -f "$caddy_file"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
caddy_backup="${caddy_file}.before-nexusos-${timestamp}"
cp -p "$caddy_file" "$caddy_backup"

if ! id "$tunnel_user" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$tunnel_user"
fi
tunnel_home=$(getent passwd "$tunnel_user" | cut -d: -f6)
install -d -m 0700 -o "$tunnel_user" -g "$tunnel_user" "$tunnel_home/.ssh"
authorized_key="restrict,port-forwarding,permitlisten=\"127.0.0.1:${tunnel_port}\" ${public_key}"
printf '%s\n' "$authorized_key" >"$tunnel_home/.ssh/authorized_keys"
chown "$tunnel_user:$tunnel_user" "$tunnel_home/.ssh/authorized_keys"
chmod 0600 "$tunnel_home/.ssh/authorized_keys"

cat >"$ssh_dropin" <<EOF
Match User ${tunnel_user}
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowAgentForwarding no
    AllowTcpForwarding remote
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
EOF
sshd -t

template_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$gateway_mode" = cloudflare ]; then
  template="$template_dir/nexusos-cloudflare.caddy.template"
else
  template="$template_dir/nexusos-direct.caddy.template"
fi
sed "s/__NEXUS_PUBLIC_HOST__/${public_host}/g" "$template" >"$caddy_snippet"
chmod 0644 "$caddy_snippet"

if [ "$gateway_mode" = cloudflare ]; then
  if ! grep -Fq "import $caddy_snippet" "$caddy_file"; then
    awk -v import_line="    import $caddy_snippet" '
      !inserted && $0 ~ /^:80[[:space:]]*\{/ {
        print
        print import_line
        inserted=1
        next
      }
      { print }
      END {
        if (!inserted) {
          print "Cloudflare mode requires a top-level :80 Caddy site." >"/dev/stderr"
          exit 42
        }
      }
    ' "$caddy_file" >"${caddy_file}.nexusos-new" || {
      rm -f "${caddy_file}.nexusos-new"
      exit 1
    }
    mv "${caddy_file}.nexusos-new" "$caddy_file"
  fi
else
  if ! grep -Fq "import $caddy_snippet" "$caddy_file"; then
    printf '\nimport %s\n' "$caddy_snippet" >>"$caddy_file"
  fi
fi

if ! caddy validate --config "$caddy_file"; then
  cp -p "$caddy_backup" "$caddy_file"
  echo "Caddy validation failed; the prior file was restored." >&2
  exit 1
fi
caddy fmt --overwrite "$caddy_file"
systemctl reload ssh
systemctl reload caddy

echo "NexusOS gateway ready:"
echo "  URL: https://${public_host}"
echo "  reverse listener: 127.0.0.1:${tunnel_port}"
echo "  tunnel user: ${tunnel_user}"
echo "  Caddy backup: ${caddy_backup}"
