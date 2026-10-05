import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { pollMessages, readMessage } from "./lib/mail.ts";

void test("poll establishes baseline, rejects stale UIDs and keeps reads unseen", async () => {
  const keys = [
    "MAIL_IMAP_HOST",
    "MAIL_IMAP_PORT",
    "MAIL_IMAP_TLS",
    "MAIL_IMAP_STARTTLS",
    "MAIL_USERNAME",
    "MAIL_PASSWORD",
  ];
  const original = keys.map((key) => process.env[key]);
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write("* OK fixture\r\n");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, ...parts] = line.split(" ");
        const command = parts.join(" ");
        commands.push(command);
        if (command.startsWith("EXAMINE"))
          socket.write("* OK [UIDVALIDITY 77]\r\n* OK [UIDNEXT 101]\r\n");
        if (command.startsWith("UID SEARCH"))
          socket.write("* SEARCH 100 99 102 101\r\n");
        if (command.startsWith("UID FETCH")) {
          const raw = "From: sender@example.com\r\nSubject: New\r\n\r\nBody";
          socket.write(
            `* 1 FETCH (BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`,
          );
        }
        socket.write(`${tag} OK complete\r\n`);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    MAIL_IMAP_HOST: "127.0.0.1",
    MAIL_IMAP_PORT: String(address.port),
    MAIL_IMAP_TLS: "false",
    MAIL_IMAP_STARTTLS: "false",
    MAIL_USERNAME: "fixture",
    MAIL_PASSWORD: "fixture",
  });
  try {
    const baseline = await pollMessages({});
    assert.equal(baseline.baseline, true);
    assert.equal(baseline.last_uid, 100);
    assert.ok(!commands.some((x) => x.startsWith("UID ")));
    const reset = await pollMessages({ after_uid: 100, uidvalidity: "old" });
    assert.equal(reset.baseline, true);
    const next = await pollMessages({
      after_uid: 100,
      uidvalidity: "77",
      limit: 1,
    });
    assert.deepEqual(next.uids, ["101"]);
    await assert.rejects(
      readMessage({ uid: "101", uidvalidity: "old" }),
      /UIDVALIDITY changed/u,
    );
    assert.ok(!commands.some((x) => x.startsWith("UID FETCH")));
    const message = await readMessage({ uid: "101", uidvalidity: "77" });
    assert.equal(message.marked_seen, false);
    assert.ok(commands.includes("UID FETCH 101 (BODY.PEEK[])"));
    assert.ok(
      !commands.some((x) => x.startsWith("SELECT") || x.includes("STORE")),
    );
  } finally {
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
