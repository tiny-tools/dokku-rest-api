import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 1024 * 1024;

// Errors thrown from handlers are rendered as RFC 9457 problem details.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail ?? title);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

export function sendProblem(res: ServerResponse, err: HttpError, instance?: string): void {
  const payload =
    JSON.stringify(
      { type: "about:blank", title: err.title, status: err.status, detail: err.detail, instance, ...err.extra },
      null,
      2,
    ) + "\n";
  res.writeHead(err.status, {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...err.headers,
  });
  res.end(payload);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Payload Too Large", `body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/([a-z.+-]*\+)?json\b/i.test(type)) {
    throw new HttpError(415, "Unsupported Media Type", "send the body as application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Malformed JSON", "request body is not valid JSON");
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBool(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new HttpError(400, "Invalid query parameter", `expected a boolean, got "${value}"`);
}
