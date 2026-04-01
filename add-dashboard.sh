#!/bin/bash
# Run from ~/aq-outreach-bot
# This adds a /dashboard route that serves the HTML dashboard

# 1. Copy dashboard.html into the project
cp ~/Downloads/dashboard.html .

# 2. Add the route to serve it (insert before "Start server" line)
# We'll add: import { readFileSync } from "fs"; at the top
# And: app.get("/dashboard", ...) before the server start

# Add the fs import after the twilio import
sed -i '' 's/import twilio from "twilio";/import twilio from "twilio";\nimport { readFileSync } from "fs";/' outreach-bot.js

# Add the dashboard route before "Start server"
sed -i '' '/\/\/ ── Start server/i\
// ── Dashboard ───────────────────────────────────────────────\
\
app.get("/dashboard", (req, res) => {\
  res.setHeader("Content-Type", "text/html");\
  res.send(readFileSync("./dashboard.html", "utf-8"));\
});\
' outreach-bot.js

echo "Done! Dashboard route added."
echo "Now run:"
echo "  git add outreach-bot.js dashboard.html"
echo "  git commit -m 'feat: add /dashboard HTML page'"
echo "  git push origin main"
echo ""
echo "Then visit: https://aq-outreach-bot-production.up.railway.app/dashboard"
