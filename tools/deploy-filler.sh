#!/bin/zsh
# Install or update the fill-in bot daemon (bots/filler.mjs) on a spare machine as a
# launchd user agent (com.krazydad.ct-filler): it watches ct.krazydad.com's
# matchmaker and sends a bot to anyone who waits 30 s for company.
#   tools/deploy-filler.sh [host]        (default: botbox)
# Logs: ~/ct-filler/filler.log on that machine.  Stop it:
#   ssh botbox launchctl bootout gui/\$(id -u)/com.krazydad.ct-filler
set -e
TARGET=${1:-botbox}
cd "$(dirname "$0")/.."
ssh ${TARGET} 'mkdir -p ~/ct-filler/bots/policies'
scp -q bots/filler.mjs bots/lib.mjs ${TARGET}:ct-filler/bots/
scp -q bots/policies/heuristic.mjs bots/policies/jev.mjs ${TARGET}:ct-filler/bots/policies/
ssh ${TARGET} 'bash -s' <<'REMOTE'
set -e
cd ~/ct-filler
export PATH=/opt/homebrew/bin:$PATH
[ -f package.json ] || echo '{"private": true, "type": "module"}' > package.json
[ -d node_modules/playwright-core ] || npm install --silent --no-audit --no-fund playwright-core >/dev/null
PL=~/Library/LaunchAgents/com.krazydad.ct-filler.plist
cat > $PL <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.krazydad.ct-filler</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>$HOME/ct-filler/bots/filler.mjs</string>
    <string>--url</string><string>https://ct.krazydad.com/</string><string>--wait</string><string>30</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME/ct-filler</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/ct-filler/filler.log</string>
  <key>StandardErrorPath</key><string>$HOME/ct-filler/filler.log</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u)/com.krazydad.ct-filler 2>/dev/null || true
for i in 1 2 3 4 5; do sleep 2; launchctl bootstrap gui/$(id -u) $PL 2>/dev/null && break; done
sleep 3
tail -2 ~/ct-filler/filler.log
REMOTE
