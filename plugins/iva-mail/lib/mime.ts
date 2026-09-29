import { randomBytes } from "node:crypto";
import { MailError, safeHeader } from "./config.ts";

export type Address = {
  readonly name: string;
  readonly address: string;
  readonly header: string;
};

export type Draft = {
  readonly to: Address[];
  readonly cc: Address[];
  readonly bcc: Address[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
};

export type ParsedMessage = {
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly truncated: boolean;
  readonly attachments: Array<{
    filename: string | null;
    contentType: string;
    size: number;
  }>;
};

const MAX_RECIPIENTS = 50;
const MAX_BODY_CHARS = 200_000;

function splitAddressList(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    else if (!quoted && character === "<") angle += 1;
    else if (!quoted && character === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && angle === 0 && character === ",") {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result.map((item) => item.trim()).filter(Boolean);
}

function parseAddress(value: string, field: string): Address {
  safeHeader(value, field, 2_000);
  const bracketed = value.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/u);
  let name = bracketed?.[1]?.trim() ?? "";
  const address = (bracketed?.[2] ?? value).trim();
  if (name.startsWith('"') && name.endsWith('"'))
    name = name.slice(1, -1).replaceAll('\\"', '"');
  if (
    address.split("@").length !== 2 ||
    /[\s<>(),;:\\"[\]]/u.test(address) ||
    address.startsWith("@") ||
    address.endsWith("@")
  )
    throw new MailError(`${field} contains an invalid email address`);
  const header = name
    ? `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${address}>`
    : address;
  return { name, address, header };
}

export function parseAddresses(
  value: unknown,
  field: string,
  required = false,
): Address[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value
        : value === undefined || value === null
          ? []
          : null;
  if (raw === null)
    throw new MailError(`${field} must be a string or an array of strings`);
  const parsed = raw
    .flatMap(splitAddressList)
    .map((item) => parseAddress(item, field));
  if (required && parsed.length === 0)
    throw new MailError(`${field} must contain at least one address`);
  if (parsed.length > MAX_RECIPIENTS)
    throw new MailError(`${field} has more than ${MAX_RECIPIENTS} addresses`);
  return parsed;
}

export function canonicalDraft(arguments_: Record<string, unknown>): Draft {
  const to = parseAddresses(arguments_.to, "to", true);
  const cc = parseAddresses(arguments_.cc, "cc");
  const bcc = parseAddresses(arguments_.bcc, "bcc");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS)
    throw new MailError(`message has more than ${MAX_RECIPIENTS} recipients`);
  const subject = safeHeader(arguments_.subject ?? "", "subject");
  if (typeof arguments_.body !== "string")
    throw new MailError("body must be a string");
  if (arguments_.body.length > MAX_BODY_CHARS)
    throw new MailError(`body is longer than ${MAX_BODY_CHARS} characters`);
  const inReplyTo =
    arguments_.in_reply_to === undefined || arguments_.in_reply_to === null
      ? null
      : safeHeader(arguments_.in_reply_to, "in_reply_to");
  const references =
    arguments_.references === undefined || arguments_.references === null
      ? null
      : safeHeader(arguments_.references, "references", 4_000);
  return {
    to,
    cc,
    bcc,
    subject,
    body: arguments_.body,
    inReplyTo,
    references,
  };
}

export function validateStoredDraft(value: unknown): Draft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MailError("prepared message is damaged");
  const draft = value as Record<string, unknown>;
  const restore = (field: string): string[] => {
    const list = draft[field];
    if (!Array.isArray(list))
      throw new MailError("prepared message is damaged");
    return list.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new MailError("prepared message is damaged");
      const header = (item as Record<string, unknown>).header;
      if (typeof header !== "string")
        throw new MailError("prepared message is damaged");
      return header;
    });
  };
  return canonicalDraft({
    to: restore("to"),
    cc: restore("cc"),
    bcc: restore("bcc"),
    subject: draft.subject,
    body: draft.body,
    in_reply_to: draft.inReplyTo,
    references: draft.references,
  });
}

export function draftPreview(draft: Draft): string {
  const lines = [`To: ${draft.to.map((item) => item.header).join(", ")}`];
  if (draft.cc.length)
    lines.push(`Cc: ${draft.cc.map((item) => item.header).join(", ")}`);
  if (draft.bcc.length)
    lines.push(`Bcc: ${draft.bcc.map((item) => item.header).join(", ")}`);
  lines.push(`Subject: ${draft.subject}`, "", draft.body);
  return lines.join("\n");
}

function decodeMimeWords(value: string): string {
  return value.replaceAll(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/gu,
    (_match, charset: string, encoding: string, content: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(content, "base64")
            : decodeQuotedPrintable(content.replaceAll("_", " "));
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return Buffer.from(
          content,
          encoding.toLowerCase() === "b" ? "base64" : "utf8",
        ).toString("utf8");
      }
    },
  );
}

function decodeQuotedPrintable(value: string): Buffer {
  const unfolded = value.replaceAll(/=\r?\n/gu, "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const pair = unfolded.slice(index + 1, index + 3);
    if (unfolded[index] === "=" && /^[0-9A-F]{2}$/iu.test(pair)) {
      bytes.push(Number.parseInt(pair, 16));
      index += 2;
    } else bytes.push(unfolded.charCodeAt(index) & 0xff);
  }
  return Buffer.from(bytes);
}

function parseHeaders(source: string): Record<string, string> {
  const unfolded = source.replaceAll(/\r?\n[ \t]+/gu, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/gu)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = decodeMimeWords(line.slice(colon + 1).trim());
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

function headerParameter(value: string, name: string): string | null {
  const expression = new RegExp(
    `(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`,
    "iu",
  );
  const match = value.match(expression);
  return match ? decodeMimeWords(match[1] ?? match[2] ?? "") : null;
}

function splitEntity(raw: Buffer): {
  headers: Record<string, string>;
  body: Buffer;
} {
  const marker = raw.indexOf("\r\n\r\n");
  const fallback = marker === -1 ? raw.indexOf("\n\n") : -1;
  const index = marker === -1 ? fallback : marker;
  const skip = marker === -1 ? 2 : 4;
  if (index === -1) return { headers: {}, body: Buffer.alloc(0) };
  return {
    headers: parseHeaders(raw.subarray(0, index).toString("utf8")),
    body: raw.subarray(index + skip),
  };
}

function decodedBody(body: Buffer, transferEncoding: string): Buffer {
  const encoding = transferEncoding.trim().toLowerCase();
  if (encoding === "base64")
    return Buffer.from(body.toString("ascii").replaceAll(/\s/gu, ""), "base64");
  if (encoding === "quoted-printable")
    return decodeQuotedPrintable(body.toString("latin1"));
  return body;
}

function collectParts(
  raw: Buffer,
  text: string[],
  html: string[],
  attachments: ParsedMessage["attachments"],
): void {
  const { headers, body } = splitEntity(raw);
  const contentType = headers["content-type"] ?? "text/plain; charset=utf-8";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const boundary = headerParameter(contentType, "boundary");
  if (mediaType.startsWith("multipart/") && boundary) {
    const delimiter = `--${boundary}`;
    const source = body.toString("latin1");
    for (const section of source.split(delimiter).slice(1)) {
      if (section.startsWith("--")) break;
      const clean = section.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
      if (clean)
        collectParts(Buffer.from(clean, "latin1"), text, html, attachments);
    }
    return;
  }
  const disposition = headers["content-disposition"] ?? "";
  const filename =
    headerParameter(disposition, "filename") ??
    headerParameter(contentType, "name");
  const decoded = decodedBody(body, headers["content-transfer-encoding"] ?? "");
  if (/^attachment\b/iu.test(disposition) || filename) {
    attachments.push({
      filename,
      contentType: mediaType,
      size: decoded.length,
    });
    return;
  }
  const charset = headerParameter(contentType, "charset") ?? "utf-8";
  let value: string;
  try {
    value = new TextDecoder(charset).decode(decoded);
  } catch {
    value = decoded.toString("utf8");
  }
  if (mediaType === "text/plain") text.push(value);
  else if (mediaType === "text/html")
    html.push(
      value
        .replaceAll(/<br\s*\/?\s*>|<\/p\s*>|<\/div\s*>/giu, "\n")
        .replaceAll(/<[^>]+>/gu, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .trim(),
    );
}

export function parseMessage(raw: Buffer, maxBodyChars: number): ParsedMessage {
  const { headers } = splitEntity(raw);
  const plain: string[] = [];
  const rich: string[] = [];
  const attachments: ParsedMessage["attachments"] = [];
  collectParts(raw, plain, rich, attachments);
  const complete = (plain.length ? plain : rich).join("\n\n").trim();
  return {
    headers,
    body: complete.slice(0, maxBodyChars),
    truncated: complete.length > maxBodyChars,
    attachments,
  };
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function addressHeader(address: Address): string {
  return address.name
    ? `${encodeHeader(address.name)} <${address.address}>`
    : address.address;
}

function base64Lines(value: string): string {
  return (
    Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/gu)
      ?.join("\r\n") ?? ""
  );
}

export function composeMessage(
  draft: Draft,
  from: Address,
): { message: string; messageId: string } {
  const domain = from.address.split("@")[1];
  const messageId = `<${randomBytes(18).toString("hex")}@${domain}>`;
  const lines = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `From: ${addressHeader(from)}`,
    `To: ${draft.to.map(addressHeader).join(", ")}`,
  ];
  if (draft.cc.length)
    lines.push(`Cc: ${draft.cc.map(addressHeader).join(", ")}`);
  lines.push(`Subject: ${encodeHeader(draft.subject)}`);
  if (draft.inReplyTo) {
    lines.push(
      `In-Reply-To: ${draft.inReplyTo}`,
      `References: ${draft.references ? `${draft.references} ${draft.inReplyTo}` : draft.inReplyTo}`,
    );
  }
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(draft.body),
  );
  return { message: lines.join("\r\n"), messageId };
}
