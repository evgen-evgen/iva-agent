const crypto = require("node:crypto");
const express = require("express");
const { requireJwtAuth } = require("~/server/middleware");

const router = express.Router();
const ivaBase = `http://127.0.0.1:${process.env.IVA_PORT || "8723"}/iva/notifications`;

async function relay(res, url, options) {
  try {
    const response = await fetch(url, options);
    const contentType = response.headers.get("content-type");
    if (contentType) res.set("content-type", contentType);
    res.set("cache-control", "no-store");
    return res
      .status(response.status)
      .send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("[iva-notifications] proxy failed:", error);
    return res
      .status(502)
      .json({ error: "Iva notification service is unavailable" });
  }
}

router.get("/client.js", (_req, res) =>
  relay(res, `${ivaBase}/client.js`, {
    headers: {
      Authorization: `Bearer ${process.env.OPEN_WEBUI_API_KEY || ""}`,
    },
  }),
);

router.use(requireJwtAuth);

function signedHeaders(req) {
  const id = String(req.user?.id || req.user?._id || "").trim();
  const email = String(req.user?.email || "")
    .trim()
    .toLowerCase();
  const secret = String(process.env.LIBRECHAT_NOTIFICATION_SECRET || "").trim();
  if (!id || !email || !secret) return null;
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\0${id}\0${email}`)
    .digest("hex");
  return {
    "x-librechat-user-id": id,
    "x-librechat-user-email": email,
    "x-iva-notification-timestamp": timestamp,
    "x-iva-notification-signature": signature,
  };
}

async function forward(req, res, suffix = "") {
  const headers = signedHeaders(req);
  if (!headers) {
    return res
      .status(503)
      .json({ error: "Notification identity is not configured" });
  }
  return relay(res, `${ivaBase}${suffix}`, { method: req.method, headers });
}

router.get("/", (req, res) => forward(req, res));
router.post("/read-all", (req, res) => forward(req, res, "/read-all"));
router.post("/:id/read", (req, res) =>
  forward(req, res, `/${encodeURIComponent(req.params.id)}/read`),
);

module.exports = router;
