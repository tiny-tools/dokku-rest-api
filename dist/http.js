export const MAX_BODY_BYTES = 1024 * 1024;
// Errors thrown from handlers are rendered as RFC 9457 problem details.
export class HttpError extends Error {
    status;
    title;
    detail;
    extra;
    headers;
    constructor(status, title, detail, extra = {}, headers = {}) {
        super(detail ?? title);
        this.status = status;
        this.title = title;
        this.detail = detail;
        this.extra = extra;
        this.headers = headers;
    }
}
export function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body, null, 2) + "\n";
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        ...headers,
    });
    res.end(payload);
}
export function sendProblem(res, err, instance) {
    const payload = JSON.stringify({ type: "about:blank", title: err.title, status: err.status, detail: err.detail, instance, ...err.extra }, null, 2) + "\n";
    res.writeHead(err.status, {
        "Content-Type": "application/problem+json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        ...err.headers,
    });
    res.end(payload);
}
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new HttpError(413, "Payload Too Large", `body exceeds ${MAX_BODY_BYTES} bytes`);
        chunks.push(chunk);
    }
    if (size === 0)
        return undefined;
    const type = req.headers["content-type"] ?? "";
    if (!/^application\/([a-z.+-]*\+)?json\b/i.test(type)) {
        throw new HttpError(415, "Unsupported Media Type", "send the body as application/json");
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new HttpError(400, "Malformed JSON", "request body is not valid JSON");
    }
}
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseBool(value, fallback) {
    if (value === null)
        return fallback;
    if (["1", "true", "yes", "on"].includes(value.toLowerCase()))
        return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase()))
        return false;
    throw new HttpError(400, "Invalid query parameter", `expected a boolean, got "${value}"`);
}
