FROM registry.librechat.ai/danny-avila/librechat-dev:latest

ARG IVA_PORT=8723

COPY iva-notifications-route.js /app/api/server/routes/iva-notifications.js
COPY iva-report-chats.cjs /app/api/server/routes/iva-report-chats.js
RUN sed -i "1i const ivaNotifications = require('./iva-notifications');" /app/api/server/routes/index.js \
  && sed -i "/module.exports = {/a\\  ivaNotifications," /app/api/server/routes/index.js \
  && sed -i "/app.use('\/api\/user'/i\\  app.use('/api/iva/notifications', routes.ivaNotifications);" /app/api/server/index.js

# Keep the stock LibreChat bundle intact and add one stable, framework-independent
# loader. The script itself is served by Iva, so rebuilding Iva updates the inbox
# without copying or patching LibreChat's hashed frontend assets.
RUN IVA_PORT="$IVA_PORT" node -e 'const fs=require("node:fs"); const file="/app/client/dist/index.html"; const html=fs.readFileSync(file,"utf8"); const tag=`<script defer src="/api/iva/notifications/client.js"></script>`; if(!html.includes("</body>")) throw new Error("LibreChat index has no closing body tag"); fs.writeFileSync(file, html.includes(tag) ? html : html.replace("</body>", `${tag}\n</body>`));'
