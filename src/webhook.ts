// Invoked by the post-deploy trigger. Never fails the deploy.
import { createHmac } from "node:crypto";
import { Store } from "./db.js";

const [app, imageTag] = process.argv.slice(2);
let url: string | undefined;
let secret: string | undefined;
try {
  const store = new Store();
  url = store.getSetting("webhook-url");
  secret = store.getSetting("webhook-secret");
  store.close();
} catch (err) {
  console.error(` !     dokku-api webhook: cannot read settings: ${String(err)}`);
}

if (url && app) {
  const payload = JSON.stringify({ event: "post-deploy", app, image_tag: imageTag ?? null, timestamp: new Date().toISOString() });
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "dokku-api-webhook" };
  if (secret) headers["X-Dokku-Api-Signature"] = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const res = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(5000) });
    if (!res.ok) console.error(` !     dokku-api webhook: ${url} answered ${res.status}`);
  } catch (err) {
    console.error(` !     dokku-api webhook: ${String(err)}`);
  }
}
