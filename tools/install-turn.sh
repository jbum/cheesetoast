#!/bin/sh
# Install or update the TURN relay (coturn) on the server.  Run from the repo:
#   tools/install-turn.sh
# Creates the shared secret once (~/ctm-match/turn.secret on the server, mode 600;
# the matchmaker reads it), installs server/turnserver.conf with it, and a
# certbot renewal hook that copies ct's certificate where coturn can read it.
set -e
cd "$(dirname "$0")/.."
H=you@your-server
scp -q server/turnserver.conf "$H:/tmp/turnserver.conf"
ssh "$H" sh -s <<'REMOTE'
set -e
command -v turnserver >/dev/null || { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn >/dev/null; }
S=~/ctm-match/turn.secret
[ -s "$S" ] || { (umask 077; openssl rand -hex 32 > "$S"); }
# the config, with the secret (readable by root and coturn only)
{ cat /tmp/turnserver.conf; echo "static-auth-secret=$(cat "$S")"; } | sudo install -m 640 -o root -g turnserver /dev/stdin /etc/turnserver.conf
rm -f /tmp/turnserver.conf
# the certificate, now and on every renewal
HOOK=/etc/letsencrypt/renewal-hooks/deploy/coturn-ct.sh
sudo tee "$HOOK" >/dev/null <<'H'
#!/bin/sh
# copy ct.krazydad.com's certificate for coturn (tools/install-turn.sh)
L=/etc/letsencrypt/live/ct.krazydad.com
install -d -m 750 -o root -g turnserver /etc/coturn
install -m 640 -o root -g turnserver "$L/fullchain.pem" /etc/coturn/fullchain.pem
install -m 640 -o root -g turnserver "$L/privkey.pem" /etc/coturn/privkey.pem
systemctl try-restart coturn
H
sudo chmod 755 "$HOOK"
sudo "$HOOK"
# Debian ships coturn disabled until this is set
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
sudo systemctl enable -q coturn
sudo systemctl restart coturn
sleep 1
systemctl is-active coturn
sudo ss -lunpt | grep -E 'turnserver' | awk '{print $1, $5}' | sort -u
REMOTE
