FROM registry.librechat.ai/danny-avila/librechat-dev:latest

ARG IVA_PORT=8723

# Keep the stock LibreChat bundle intact and add one stable, framework-independent
# loader. The script itself is served by Iva, so rebuilding Iva updates the inbox
# without copying or patching LibreChat's hashed frontend assets.
RUN IVA_PORT="$IVA_PORT" node -e 'const fs=require("node:fs"); const file="/app/client/dist/index.html"; const html=fs.readFileSync(file,"utf8"); const tag=`<script defer src="http://127.0.0.1:${process.env.IVA_PORT}/iva/notifications/client.js"></script>`; if(!html.includes("</body>")) throw new Error("LibreChat index has no closing body tag"); fs.writeFileSync(file, html.includes(tag) ? html : html.replace("</body>", `${tag}\n</body>`));'
