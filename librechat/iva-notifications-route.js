const crypto = require("node:crypto");
const express = require("express");
const { requireJwtAuth } = require("~/server/middleware");

const router = express.Router();
const ivaBase = `http://127.0.0.1:${process.env.IVA_PORT || "8723"}/iva/notifications`;
let reportChats;
function chats() {
  if (!reportChats) {
    const mongoose = require("mongoose");
    const db = require("~/models");
    reportChats = require("./iva-report-chats").createReportChats({
      models: mongoose.models,
      receipts: mongoose.connection.collection("iva_report_chats"),
      refreshStats: db.refreshChatProjectStats,
    });
  }
  return reportChats;
}

async function ivaJson(user, suffix) {
  const headers = signedHeaders({ user });
  if (!headers) throw new Error("Notification identity is not configured");
  const response = await fetch(`${ivaBase}${suffix}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = new Error("Iva inbox request failed");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function syncUser(user) {
  let offset = 0;
  let count = 0;
  for (;;) {
    const page = await ivaJson(user, `?offset=${offset}`);
    for (const item of page.notifications) {
      if (item.kind !== "report") continue;
      await chatFor(user, item.id);
      count++;
    }
    if (!page.hasMore) return count;
    offset += page.notifications.length;
    if (!page.notifications.length) throw new Error("Invalid inbox pagination");
  }
}

async function chatFor(user, id) {
  const principal = String(user.id || user._id);
  const existing = await chats().lookup(principal, id);
  return existing !== undefined
    ? existing
    : chats().ensure(
        principal,
        await ivaJson(user, `/${encodeURIComponent(id)}`),
      );
}

// Internal delivery hook: only the shared server secret can materialize reports
// while no browser is open. Readers still pass JWT and Iva's account allowlist.
router.post("/sync", async (req, res) => {
  const secret = String(process.env.LIBRECHAT_NOTIFICATION_SECRET || "").trim();
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(String(req.headers.authorization || ""));
  if (
    !secret ||
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const emails = String(process.env.LIBRECHAT_NOTIFICATION_USERS || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (!emails.length) throw new Error("Inbox readers are not configured");
    const mongoose = require("mongoose");
    const users = await mongoose.models.User.find({ email: { $in: emails } })
      .select("_id email")
      .lean();
    let reports = 0;
    for (const user of users) reports += await syncUser(user);
    return res.json({ users: users.length, reports });
  } catch (error) {
    console.error("[iva-notifications] sync failed:", error);
    return res
      .status(502)
      .json({ error: "Report chat synchronization failed" });
  }
});

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
router.use(express.json({ limit: "128kb" }));

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
  return relay(res, `${ivaBase}${suffix}`, {
    method: req.method,
    headers: { ...headers, "content-type": "application/json" },
    ...(req.method === "POST" ? { body: JSON.stringify(req.body || {}) } : {}),
  });
}

router.get("/", async (req, res) => {
  try {
    const page = await ivaJson(
      req.user,
      `?offset=${Math.max(0, Number(req.query.offset) || 0)}`,
    );
    for (const item of page.notifications) {
      if (item.kind !== "report") continue;
      const chat = await chatFor(req.user, item.id);
      if (chat) item.conversationId = chat.conversationId;
    }
    res.set("cache-control", "no-store");
    return res.json(page);
  } catch (error) {
    return res
      .status(error.status || 502)
      .json({ error: "Iva inbox unavailable" });
  }
});
router.post("/read-all", (req, res) => forward(req, res, "/read-all"));
router.post("/:id/read", (req, res) =>
  forward(req, res, `/${encodeURIComponent(req.params.id)}/read`),
);
router.get("/:id/chat", async (req, res) => {
  try {
    const detail = await ivaJson(
      req.user,
      `/${encodeURIComponent(req.params.id)}`,
    );
    if (detail.notification.kind !== "report")
      return res.status(400).json({ error: "Not a report" });
    const chat = await chats().ensure(
      String(req.user.id || req.user._id),
      detail,
    );
    return chat
      ? res.json(chat)
      : res.status(410).json({ error: "Report chat was deleted" });
  } catch (error) {
    return res
      .status(error.status || 502)
      .json({ error: "Report chat unavailable" });
  }
});
router.get("/:id", (req, res) =>
  forward(req, res, `/${encodeURIComponent(req.params.id)}`),
);
router.post("/:id/messages", (_req, res) =>
  res
    .status(410)
    .json({ error: "Open the report's LibreChat conversation to continue" }),
);

module.exports = router;
