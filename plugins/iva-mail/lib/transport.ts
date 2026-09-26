import { createConnection, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { MailError } from "./config.ts";

type MailSocket = Socket | TLSSocket;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForConnect(
  socket: MailSocket,
  event: "connect" | "secureConnect",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, success);
      socket.off("error", failure);
    };
    const success = () => {
      cleanup();
      resolve();
    };
    const failure = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once(event, success);
    socket.once("error", failure);
  });
}

function tlsOptions(host: string) {
  return isIP(host) ? {} : { servername: host };
}

export async function openSocket(
  host: string,
  port: number,
  secure: boolean,
  timeout: number,
): Promise<MailSocket> {
  const socket = secure
    ? connectTls({ host, port, ...tlsOptions(host) })
    : createConnection({ host, port });
  socket.setTimeout(timeout, () =>
    socket.destroy(new Error("connection timed out")),
  );
  await waitForConnect(socket, secure ? "secureConnect" : "connect");
  return socket;
}

export async function upgradeTls(
  socket: Socket,
  host: string,
  timeout: number,
): Promise<TLSSocket> {
  const secure = connectTls({ socket, ...tlsOptions(host) });
  secure.setTimeout(timeout, () =>
    secure.destroy(new Error("connection timed out")),
  );
  await waitForConnect(secure, "secureConnect");
  return secure;
}

/** Sequential byte reader. IMAP literals make line-only readers insufficient. */
export class SocketReader {
  private readonly socket: MailSocket;
  private buffer = Buffer.alloc(0);

  constructor(socket: MailSocket) {
    this.socket = socket;
  }

  detach(): void {}

  private async more(): Promise<void> {
    const immediate = this.socket.read() as Buffer | null;
    if (immediate) {
      this.buffer = Buffer.concat([this.buffer, immediate]);
      return;
    }
    if (this.socket.readableEnded || this.socket.destroyed)
      throw new Error("mail server closed the connection");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.socket.off("readable", readable);
        this.socket.off("end", ended);
        this.socket.off("close", ended);
        this.socket.off("error", failed);
      };
      const readable = () => {
        cleanup();
        const chunk = this.socket.read() as Buffer | null;
        if (!chunk)
          return reject(new Error("mail server produced no readable data"));
        this.buffer = Buffer.concat([this.buffer, chunk]);
        resolve();
      };
      const ended = () => {
        cleanup();
        reject(new Error("mail server closed the connection"));
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.socket.once("readable", readable);
      this.socket.once("end", ended);
      this.socket.once("close", ended);
      this.socket.once("error", failed);
    });
  }

  async line(): Promise<string> {
    while (true) {
      const end = this.buffer.indexOf("\r\n");
      if (end !== -1) {
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 2);
        return line;
      }
      await this.more();
    }
  }

  async bytes(size: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.more();
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }
}

export type ImapResult = { lines: string[]; literals: Buffer[] };

export class ImapClient {
  private socket: MailSocket;
  private reader: SocketReader;
  private sequence = 0;

  private constructor(socket: MailSocket) {
    this.socket = socket;
    this.reader = new SocketReader(socket);
  }

  static async connect(options: {
    host: string;
    port: number;
    secure: boolean;
    startTls: boolean;
    timeout: number;
  }): Promise<ImapClient> {
    const socket = await openSocket(
      options.host,
      options.port,
      options.secure,
      options.timeout,
    );
    const client = new ImapClient(socket);
    try {
      const greeting = await client.reader.line();
      if (!/^\* (?:OK|PREAUTH)\b/iu.test(greeting))
        throw new MailError(`IMAP rejected the connection: ${greeting}`);
      if (!options.secure && options.startTls) {
        await client.execute("STARTTLS");
        client.reader.detach();
        client.socket = await upgradeTls(
          client.socket,
          options.host,
          options.timeout,
        );
        client.reader = new SocketReader(client.socket);
      }
      return client;
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  async execute(command: string): Promise<ImapResult> {
    const tag = `A${String(++this.sequence).padStart(4, "0")}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const lines: string[] = [];
    const literals: Buffer[] = [];
    while (true) {
      const line = await this.reader.line();
      lines.push(line);
      const literal = line.match(/\{(\d+)\}$/u);
      if (literal) literals.push(await this.reader.bytes(Number(literal[1])));
      if (line.startsWith(`${tag} `)) {
        if (!new RegExp(`^${tag} OK\\b`, "u").test(line))
          throw new MailError(
            `IMAP command failed: ${line.slice(tag.length + 1)}`,
          );
        return { lines, literals };
      }
    }
  }

  async login(username: string, password: string): Promise<void> {
    await this.execute(`LOGIN ${imapQuote(username)} ${imapQuote(password)}`);
  }

  async append(mailbox: string, message: Buffer): Promise<void> {
    const tag = `A${String(++this.sequence).padStart(4, "0")}`;
    this.socket.write(
      `${tag} APPEND ${imapQuote(mailbox)} (\\Seen) {${message.length}}\r\n`,
    );
    while (true) {
      const line = await this.reader.line();
      if (line.startsWith("+")) break;
      if (line.startsWith(`${tag} `))
        throw new MailError(
          `IMAP APPEND failed: ${line.slice(tag.length + 1)}`,
        );
    }
    this.socket.write(message);
    this.socket.write("\r\n");
    while (true) {
      const line = await this.reader.line();
      if (!line.startsWith(`${tag} `)) continue;
      if (!new RegExp(`^${tag} OK\\b`, "u").test(line))
        throw new MailError(
          `IMAP APPEND failed: ${line.slice(tag.length + 1)}`,
        );
      return;
    }
  }

  async close(): Promise<void> {
    try {
      await this.execute("LOGOUT");
    } catch {
      // Closing is best-effort after the requested operation has completed.
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.reader.detach();
    this.socket.destroy();
  }
}

export function imapQuote(value: string): string {
  if (/[\r\n\0]/u.test(value))
    throw new MailError("IMAP value contains a forbidden character");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export class SmtpClient {
  private socket: MailSocket;
  private reader: SocketReader;

  private constructor(socket: MailSocket) {
    this.socket = socket;
    this.reader = new SocketReader(socket);
  }

  static async connect(options: {
    host: string;
    port: number;
    secure: boolean;
    startTls: boolean;
    timeout: number;
  }): Promise<SmtpClient> {
    const socket = await openSocket(
      options.host,
      options.port,
      options.secure,
      options.timeout,
    );
    const client = new SmtpClient(socket);
    try {
      await client.response(220);
      await client.command("EHLO iva.local", 250);
      if (!options.secure && options.startTls) {
        await client.command("STARTTLS", 220);
        client.reader.detach();
        client.socket = await upgradeTls(
          client.socket,
          options.host,
          options.timeout,
        );
        client.reader = new SocketReader(client.socket);
        await client.command("EHLO iva.local", 250);
      }
      return client;
    } catch (error) {
      client.reader.detach();
      client.socket.destroy();
      throw error;
    }
  }

  private async response(
    expected: number | readonly number[],
  ): Promise<string[]> {
    const expectedCodes = Array.isArray(expected) ? expected : [expected];
    const lines: string[] = [];
    while (true) {
      const line = await this.reader.line();
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])/u);
      if (!match) throw new MailError(`invalid SMTP response: ${line}`);
      if (match[2] === "-") continue;
      if (!expectedCodes.includes(Number(match[1])))
        throw new MailError(`SMTP command failed: ${lines.join(" | ")}`);
      return lines;
    }
  }

  async command(
    command: string,
    expected: number | readonly number[],
  ): Promise<string[]> {
    this.socket.write(`${command}\r\n`);
    return this.response(expected);
  }

  async authenticate(username: string, password: string): Promise<void> {
    await this.command("AUTH LOGIN", 334);
    await this.command(Buffer.from(username).toString("base64"), 334);
    await this.command(Buffer.from(password).toString("base64"), 235);
  }

  async authenticatePlain(username: string, password: string): Promise<void> {
    const payload = Buffer.from(`\0${username}\0${password}`).toString(
      "base64",
    );
    await this.command(`AUTH PLAIN ${payload}`, 235);
  }

  async send(
    from: string,
    recipients: string[],
    message: string,
  ): Promise<void> {
    await this.command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients)
      await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await this.command("DATA", 354);
    const dotted = message
      .replaceAll(/\r?\n/gu, "\r\n")
      .replaceAll(/^\./gmu, "..");
    this.socket.write(`${dotted}\r\n.\r\n`);
    await this.response(250);
  }

  async close(): Promise<void> {
    try {
      await this.command("QUIT", 221);
    } catch {
      // Closing is best-effort after the requested operation has completed.
    } finally {
      this.reader.detach();
      this.socket.destroy();
    }
  }
}

export function transportError(prefix: string, error: unknown): MailError {
  return error instanceof MailError
    ? error
    : new MailError(`${prefix}: ${reason(error)}`);
}
