/**
 * Email delivery adapter.
 *
 * Two modes, chosen automatically:
 *
 *  * **SMTP** — when `SMTP_HOST` is configured, messages are delivered over
 *    SMTP over TLS.
 *  * **File outbox** — the documented local-development flow. When no SMTP
 *    host is set, each message is written to `storage/mail-outbox/*.eml` and
 *    (in development only) the action link is printed to the server console.
 *    Nothing silently pretends to have been emailed: the UI tells the user
 *    that mail is written to the outbox.
 *
 * DEXTube deliberately does **not** bundle a heavyweight mail library. The
 * SMTP implementation below is a small, auditable subset of RFC 5321 covering
 * plain and STARTTLS delivery with AUTH LOGIN, which is what the listed
 * providers (Mailgun, Postmark, SES SMTP, Gmail) all accept.
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

const log = logger.child({ mod: "email" });

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; the text body is always sent too. */
  html?: string;
}

export interface SendResult {
  delivered: boolean;
  transport: "smtp" | "file-outbox";
  /** Filesystem path when the file-outbox transport was used. */
  outboxPath?: string;
  error?: string;
}

export function outboxDir(): string {
  return path.resolve(process.cwd(), "storage/mail-outbox");
}

export async function sendMail(message: MailMessage): Promise<SendResult> {
  const config = getConfig();
  if (!config.email.configured) {
    return writeToOutbox(message);
  }
  try {
    await sendSmtp(message);
    return { delivered: true, transport: "smtp" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("smtp delivery failed; falling back to the file outbox", { err: detail });
    const fallback = await writeToOutbox(message);
    return { ...fallback, error: detail };
  }
}

/** Writes a `.eml` file and logs the action link so local dev can proceed. */
async function writeToOutbox(message: MailMessage): Promise<SendResult> {
  const dir = outboxDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = message.to.replace(/[^A-Za-z0-9._@-]/g, "_");
  const file = path.join(dir, `${stamp}-${safeTo}.eml`);
  const eml = [
    `From: ${getConfig().email.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    message.text,
    "",
  ].join("\r\n");
  await fs.writeFile(file, eml, { mode: 0o640 });

  // Only surface links in development; production operators read the outbox.
  if (!getConfig().isProd) {
    logger.info("email written to outbox (SMTP not configured)", {
      to: message.to,
      subject: message.subject,
      outboxPath: file,
      link: extractLink(message.text),
    });
  }
  return { delivered: false, transport: "file-outbox", outboxPath: file };
}

function extractLink(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

/* -------------------------------------------------------------------- SMTP */

interface SmtpResponse {
  code: number;
  lines: string[];
}

/**
 * Minimal SMTP client: connect → optional STARTTLS → optional AUTH LOGIN →
 * MAIL FROM / RCPT TO / DATA → QUIT. Implicit TLS is used when SMTP_SECURE=true.
 */
async function sendSmtp(message: MailMessage): Promise<void> {
  const config = getConfig();
  const host = config.email.host;
  if (!host) throw new Error("SMTP host is not configured.");

  const hostname = new URL(config.appUrl).hostname || "localhost";
  const from = config.email.from;
  const fromAddress = from.match(/<([^>]+)>/)?.[1] ?? from;

  let socket: net.Socket = config.email.secure
    ? tls.connect({ host, port: config.email.port, servername: host })
    : net.connect({ host, port: config.email.port });

  const buffer: { response: SmtpResponse | null; error: Error | null; resolvers: Array<(r: SmtpResponse) => void> } = {
    response: null,
    error: null,
    resolvers: [],
  };

  let pending = "";
  let lineBuffer = "";

  const onData = (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    let index: number;
    while ((index = lineBuffer.indexOf("\r\n")) !== -1) {
      const line = lineBuffer.slice(0, index);
      lineBuffer = lineBuffer.slice(index + 2);
      pending += `${line}\n`;
      // A final response line has a space (not a dash) after the code.
      if (/^\d{3} /.test(line)) {
        const response: SmtpResponse = {
          code: Number(line.slice(0, 3)),
          lines: pending.trimEnd().split("\n"),
        };
        pending = "";
        const resolver = buffer.resolvers.shift();
        if (resolver) resolver(response);
        else buffer.response = response;
      }
    }
  };

  socket.on("data", onData);
  socket.on("error", (error) => {
    buffer.error = error;
    const resolver = buffer.resolvers.shift();
    if (resolver) resolver({ code: 0, lines: [error.message] });
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    if (config.email.secure) socket.once("secureConnect", resolve);
    setTimeout(() => reject(new Error("SMTP connection timed out")), 15_000).unref?.();
  });

  const read = (): Promise<SmtpResponse> => {
    if (buffer.response) {
      const response = buffer.response;
      buffer.response = null;
      return Promise.resolve(response);
    }
    if (buffer.error) return Promise.reject(buffer.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP read timed out")), 20_000);
      buffer.resolvers.push((response) => {
        clearTimeout(timer);
        if (response.code === 0) reject(new Error(response.lines[0]));
        else resolve(response);
      });
    });
  };

  const write = (text: string) => new Promise<void>((resolve) => socket.write(text, () => resolve()));

  const expect = async (allowed: number[], label: string) => {
    const response = await read();
    if (!allowed.includes(response.code)) {
      throw new Error(`SMTP ${label} failed: ${response.lines.join(" ")}`);
    }
    return response;
  };

  await expect([220], "greeting");
  await write(`EHLO ${hostname}\r\n`);
  const ehlo = await expect([250], "EHLO");

  if (!config.email.secure && /STARTTLS/i.test(ehlo.lines.join("\n"))) {
    await write("STARTTLS\r\n");
    await expect([220], "STARTTLS");
    socket = tls.connect({ socket, servername: host, host });
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    socket.on("data", onData);
    await write(`EHLO ${hostname}\r\n`);
    await expect([250], "EHLO after STARTTLS");
  }

  if (config.email.user && config.email.password) {
    await write("AUTH LOGIN\r\n");
    await expect([334], "AUTH LOGIN");
    await write(`${Buffer.from(config.email.user).toString("base64")}\r\n`);
    await expect([334], "AUTH username");
    await write(`${Buffer.from(config.email.password).toString("base64")}\r\n`);
    await expect([235], "AUTH password");
  }

  await write(`MAIL FROM:<${fromAddress}>\r\n`);
  await expect([250], "MAIL FROM");
  await write(`RCPT TO:<${message.to}>\r\n`);
  await expect([250, 251], "RCPT TO");
  await write("DATA\r\n");
  await expect([354], "DATA");
  await write(`${buildMime(message)}\r\n.\r\n`);
  await expect([250], "message body");
  await write("QUIT\r\n");
  socket.end();
}

function buildMime(message: MailMessage): string {
  const headers = [
    `From: ${getConfig().email.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  if (message.html) {
    const boundary = `dextube-${Date.now().toString(36)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      message.text,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      message.html,
      "",
      `--${boundary}--`,
    ].join("\r\n");
  }
  return [
    ...headers,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    message.text,
  ].join("\r\n");
}

function encodeHeader(value: string): string {
  // Non-ASCII subjects are RFC 2047 encoded to avoid mojibake.
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value).toString("base64")}?=`;
}

/* ------------------------------------------------------------- templates */

export function verificationEmail(displayName: string, link: string): MailMessage & { to: string } {
  return {
    to: "",
    subject: "Confirm your DEXTube email address",
    text: [
      `Hi ${displayName},`,
      "",
      "Welcome to DEXTube. Confirm your email address to unlock uploading, comments and notifications:",
      "",
      link,
      "",
      "This link expires in 24 hours and can only be used once.",
      "If you did not create a DEXTube account you can ignore this message.",
      "",
      "— DEXTube",
    ].join("\n"),
  };
}

export function passwordResetEmail(displayName: string, link: string): MailMessage & { to: string } {
  return {
    to: "",
    subject: "Reset your DEXTube password",
    text: [
      `Hi ${displayName},`,
      "",
      "Use this single-use link to choose a new password:",
      "",
      link,
      "",
      "The link expires in 1 hour. If you did not request it, no action is needed —",
      "your password has not been changed.",
      "",
      "— DEXTube",
    ].join("\n"),
  };
}

export function newVideoEmail(channelName: string, videoTitle: string, link: string): MailMessage & { to: string } {
  return {
    to: "",
    subject: `${channelName} uploaded: ${videoTitle}`,
    text: [
      `${channelName} just published a new video on DEXTube:`,
      "",
      videoTitle,
      link,
      "",
      "You are receiving this because you subscribed with email notifications enabled.",
      "Manage this in DEXTube → Settings → Notifications.",
    ].join("\n"),
  };
}
