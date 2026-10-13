#!/bin/sh
# Copy the static game files (and optionally the score server) into place.
#
#   CT_DEPLOY=user@host:path/to/docroot [CT_DEPLOY_SERVER=user@host:path] tools/deploy.sh
#
# CT_DEPLOY_SERVICE names the score server's systemd unit (default ct-scores).
#
# A target without "host:" is a local directory: that's how the GitHub Actions
# runner on the web server deploys (.github/workflows/deploy.yml).
#
# Only what the browser needs goes up (index.html, manifest, css, js, assets, games/);
# files that no longer exist here are removed from the deployed copy.
set -e
cd "$(dirname "$0")/.."
: "${CT_DEPLOY:?set CT_DEPLOY=user@host:path (or a local path), the site document root}"

# run a command where the target lives: over ssh for host:path, else locally
on_target() {   # target, command
  case "$1" in
    *:*) ssh "${1%%:*}" "$2" ;;
    *) sh -c "$2" ;;
  esac
}
target_dir() { case "$1" in *:*) echo "${1#*:}" ;; *) echo "$1" ;; esac; }

rsync -az --delete --exclude='.DS_Store' \
  index.html manifest.webmanifest css js assets games "$CT_DEPLOY/"
dir=$(target_dir "$CT_DEPLOY")
# which commit is live (the game reports it in multiplayer diagnostics)
ver="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo +)"
on_target "$CT_DEPLOY" "printf '{\"v\": \"%s\", \"at\": \"%s\"}\n' '$ver' '$(date -u +%Y-%m-%dT%H:%M:%SZ)' > '$dir/version.json'"
# make sure the web server can read everything
on_target "$CT_DEPLOY" "find '$dir' -type d -exec chmod 755 {} + && find '$dir' -type f -exec chmod 644 {} +"
echo "deployed to $CT_DEPLOY"

# Score server (server/), when CT_DEPLOY_SERVER is set.  Only the code goes up;
# the database, logs, API key and password file stay put.
if [ -n "$CT_DEPLOY_SERVER" ]; then
  rsync -az server/scores_server.py server/mod.html server/ct-scores.service "$CT_DEPLOY_SERVER/"
  svc=${CT_DEPLOY_SERVICE:-ct-scores}
  on_target "$CT_DEPLOY_SERVER" "sudo systemctl restart $svc && sleep 1 && systemctl is-active $svc"
  echo "score server updated at $CT_DEPLOY_SERVER"
fi

# Multiplayer matchmaker (server/match_server.py), when CT_DEPLOY_MATCH is set
# (the multiplayer test site only); its systemd unit is CT_DEPLOY_MATCH_SERVICE.
if [ -n "$CT_DEPLOY_MATCH" ]; then
  # restart only when its code changed: a restart forgets everyone waiting
  changed=$(rsync -az -i server/match_server.py server/ct-match.service "$CT_DEPLOY_MATCH/")
  msvc=${CT_DEPLOY_MATCH_SERVICE:-ctm-match}
  if [ -n "$changed" ]; then
    on_target "$CT_DEPLOY_MATCH" "sudo systemctl restart $msvc && sleep 1 && systemctl is-active $msvc"
    echo "matchmaker updated at $CT_DEPLOY_MATCH"
  else
    echo "matchmaker unchanged (not restarted)"
  fi
fi
