/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { MailError } from "./lib/config.ts";
import {
  canonicalDraft,
  composeMessage,
  parseAddresses,
  parseMessage,
} from "./lib/mime.ts";
import {
  connectionStatus,
  imapSearchDate,
  prepareMessage,
  sendPrepared,
} from "./lib/mail.ts";
import { handle } from "./server.ts";

const mailEnvironmentKeys = [
  "PLUGIN_DATA",
  "MAIL_ALLOW_SEND",
  "MAIL_SMTP_HOST",
  "MAIL_SMTP_PORT",
  "MAIL_SMTP_TLS",
  "MAIL_SMTP_STARTTLS",
  "MAIL_USERNAME",
  "MAIL_PASSWORD",
  "MAIL_FROM",
  "MAIL_SMTP_AUTH",
  "MAIL_SENT_MAILBOX",
] as const;
const originalEnvironment = Object.fromEntries(
  mailEnvironmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof mailEnvironmentKeys)[number], string | undefined>;
const temporary: string[] = [];

afterEach(async () => {
  for (const key of mailEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "iva-mail-test-"));
  temporary.push(path);
  process.env.PLUGIN_DATA = path;
  return path;
}

test("header injection is rejected", () => {
  assert.throws(
    () =>
      parseAddresses("victim@example.com\nBcc: thief@example.com", "to", true),
    (error) => error instanceof MailError && /line breaks/u.test(error.message),
  );
});

test("ISO dates are normalized for IMAP search", () => {
  assert.equal(imapSearchDate("2026-09-25", "since"), '"25-Sep-2026"');
  assert.throws(() => imapSearchDate("2026-13-25", "since"), /YYYY-MM-DD/u);
  assert.throws(() => imapSearchDate("2026-02-31", "since"), /YYYY-MM-DD/u);
});

test("connection status never returns the password and supports unauthenticated SMTP", () => {
  Object.assign(process.env, {
    MAIL_SMTP_HOST: "mail.example.com",
    MAIL_SMTP_AUTH: "none",
    MAIL_FROM: "iva@example.com",
    MAIL_PASSWORD: "do-not-return",
  });
  const status = connectionStatus();
  assert.equal(status.smtp_configured, true);
  assert.equal(status.smtp_auth, "none");
  assert.doesNotMatch(JSON.stringify(status), /do-not-return/u);
});

test("prepare writes a mode-0600 token without sending", async () => {
  const root = await dataDirectory();
  // Keep this invariant observable even under an unusual inherited umask.
  await chmod(root, 0o700);
  const value = await prepareMessage({
    to: "Alice <alice@example.com>",
    subject: "Hello",
    body: "Body",
  });
  assert.equal(value.sent, false);
  assert.match(String(value.preview), /To: "Alice" <alice@example\.com>/u);
  const file = join(
    root,
    "pending",
    `${String(value.confirmation_token)}.json`,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("disabled send fails before consuming the prepared token", async () => {
  await dataDirectory();
  process.env.MAIL_ALLOW_SEND = "false";
  const prepared = await prepareMessage({
    to: "alice@example.com",
    subject: "Hello",
    body: "Body",
  });
  await assert.rejects(
    sendPrepared({ confirmation_token: prepared.confirmation_token }),
    /sending is disabled/u,
  );
  await assert.rejects(
    sendPrepared({ confirmation_token: prepared.confirmation_token }),
    /sending is disabled/u,
  );
});

test("MCP exposes the guarded mail tools", async () => {
  const response = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.ok(response);
  const result = response.result as { tools: Array<{ name: string }> };
  assert.deepEqual(
    new Set(result.tools.map((tool) => tool.name)),
    new Set([
      "mail_connection_status",
      "mail_check_connection",
      "mail_list_mailboxes",
      "mail_list_messages",
      "mail_read_message",
      "mail_prepare_message",
      "mail_send_prepared",
      "mail_discard_prepared",
    ]),
  );
});

test("composed SMTP message hides Bcc and encodes Unicode headers", () => {
  const draft = canonicalDraft({
    to: "Alice <alice@example.com>",
    bcc: "Bob <bob@example.com>",
    subject: "Привет",
    body: "Тест",
    in_reply_to: "<new@example.com>",
    references: "<old@example.com>",
  });
  const from = parseAddresses("Ива <iva@example.com>", "MAIL_FROM", true)[0];
  const { message, messageId } = composeMessage(draft, from);
  assert.deepEqual(
    [...draft.to, ...draft.cc, ...draft.bcc].map((address) => address.address),
    ["alice@example.com", "bob@example.com"],
  );
  assert.doesNotMatch(message, /^Bcc:/imu);
  assert.match(message, /^Subject: =\?UTF-8\?B\?/imu);
  assert.match(message, /^From: =\?UTF-8\?B\?/imu);
  assert.match(
    message,
    /^References: <old@example\.com> <new@example\.com>$/imu,
  );
  assert.match(messageId, /^<[a-f0-9]+@example\.com>$/u);
});

test("MIME reader decodes text and reports attachments without returning their bytes", () => {
  const raw = Buffer.from(
    [
      "From: Alice <alice@example.com>",
      "Subject: =?UTF-8?B?0KLQtdGB0YI=?=",
      'Content-Type: multipart/mixed; boundary="iva-boundary"',
      "",
      "--iva-boundary",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Привет").toString("base64"),
      "--iva-boundary",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("PDF").toString("base64"),
      "--iva-boundary--",
      "",
    ].join("\r\n"),
  );
  const parsed = parseMessage(raw, 100);
  assert.equal(parsed.headers.subject, "Тест");
  assert.equal(parsed.body, "Привет");
  assert.deepEqual(parsed.attachments, [
    { filename: "invoice.pdf", contentType: "application/pdf", size: 3 },
  ]);
});
