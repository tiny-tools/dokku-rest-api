import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_ALLOWLIST } from "./allowlist.js";
import { globMatch, type Scope } from "./scopes.js";

export const DEFAULT_DB_PATH = "/var/lib/dokku/data/api/storage.db";

export interface TokenRow {
  id: number;
  name: string;
  token_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: number;
}

export interface PermissionRow {
  id: number;
  token_id: number;
  app_pattern: string;
  scope: Scope;
}

export interface AllowlistRow {
  id: number;
  token_id: number | null;
  command_prefix: string;
  allowed_flags_regex: string;
  require_app_match: number;
  scope: Scope;
  description: string | null;
}

export interface AuditEntry {
  token_id: number | null;
  method: string;
  path: string;
  app: string | null;
  command: string | null;
  status: number;
  exit_code: number | null;
  remote_addr: string | null;
}

// Versioned migrations; each entry runs once, in order.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NULL,
    last_used_at TEXT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE token_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    app_pattern TEXT NOT NULL,
    scope TEXT NOT NULL,
    UNIQUE (token_id, app_pattern, scope)
  );

  CREATE TABLE cli_allowlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NULL REFERENCES tokens(id) ON DELETE CASCADE,
    command_prefix TEXT NOT NULL,
    allowed_flags_regex TEXT NOT NULL DEFAULT '^.*$',
    require_app_match INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT 'cli',
    description TEXT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    token_id INTEGER NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    app TEXT NULL,
    command TEXT NULL,
    status INTEGER NOT NULL,
    exit_code INTEGER NULL,
    remote_addr TEXT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX idx_perm_token ON token_permissions(token_id);
  CREATE INDEX idx_allowlist_cmd ON cli_allowlist(command_prefix);
  CREATE INDEX idx_audit_created ON audit_log(created_at);
  `,
];

export const TOKEN_PREFIX = "dk_live_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string = process.env.DOKKU_API_DB || DEFAULT_DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        if (v === 0) this.seedAllowlist();
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  private seedAllowlist(): void {
    const insert = this.db.prepare(
      `INSERT INTO cli_allowlist (command_prefix, allowed_flags_regex, require_app_match, scope, description)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of DEFAULT_ALLOWLIST) {
      insert.run(e.command, e.flags, e.requireApp ? 1 : 0, e.scope, e.description);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- tokens -------------------------------------------------------------

  createToken(name: string, expiresAt: string | null): { token: string; row: TokenRow } {
    const token = generateToken();
    const info = this.db
      .prepare("INSERT INTO tokens (name, token_prefix, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(name, token.slice(0, 12), hashToken(token), expiresAt);
    return { token, row: this.getTokenById(Number(info.lastInsertRowid))! };
  }

  getTokenById(id: number): TokenRow | undefined {
    return this.db
      .prepare("SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked FROM tokens WHERE id = ?")
      .get(id) as TokenRow | undefined;
  }

  getTokenByName(name: string): TokenRow | undefined {
    return this.db
      .prepare("SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked FROM tokens WHERE name = ?")
      .get(name) as TokenRow | undefined;
  }

  findTokenBySecret(secret: string): TokenRow | undefined {
    return this.db
      .prepare(
        "SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked FROM tokens WHERE token_hash = ?",
      )
      .get(hashToken(secret)) as TokenRow | undefined;
  }

  listTokens(): TokenRow[] {
    return this.db
      .prepare("SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked FROM tokens ORDER BY name")
      .all() as unknown as TokenRow[];
  }

  revokeToken(id: number): void {
    this.db.prepare("UPDATE tokens SET revoked = 1 WHERE id = ?").run(id);
  }

  touchToken(id: number): void {
    this.db
      .prepare("UPDATE tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(id);
  }

  // --- permissions --------------------------------------------------------

  addPermission(tokenId: number, appPattern: string, scope: Scope): void {
    this.db
      .prepare("INSERT OR IGNORE INTO token_permissions (token_id, app_pattern, scope) VALUES (?, ?, ?)")
      .run(tokenId, appPattern, scope);
  }

  removePermission(tokenId: number, appPattern: string, scope: Scope): number {
    const info = this.db
      .prepare("DELETE FROM token_permissions WHERE token_id = ? AND app_pattern = ? AND scope = ?")
      .run(tokenId, appPattern, scope);
    return Number(info.changes);
  }

  listPermissions(tokenId?: number): (PermissionRow & { token_name: string })[] {
    const sql = `SELECT p.id, p.token_id, p.app_pattern, p.scope, t.name AS token_name
                 FROM token_permissions p JOIN tokens t ON t.id = p.token_id
                 ${tokenId === undefined ? "" : "WHERE p.token_id = ?"}
                 ORDER BY t.name, p.app_pattern, p.scope`;
    const stmt = this.db.prepare(sql);
    return (tokenId === undefined ? stmt.all() : stmt.all(tokenId)) as unknown as (PermissionRow & {
      token_name: string;
    })[];
  }

  // True when the token holds `scope` on an app pattern matching `app`.
  // `app === null` means "not app-bound" and requires the scope on "*".
  hasScope(tokenId: number, scope: Scope, app: string | null): boolean {
    const perms = this.listPermissions(tokenId).filter((p) => p.scope === scope);
    return perms.some((p) => (app === null ? p.app_pattern === "*" : globMatch(p.app_pattern, app)));
  }

  // --- allow-list ---------------------------------------------------------

  addAllowlistEntry(e: Omit<AllowlistRow, "id">): number {
    const info = this.db
      .prepare(
        `INSERT INTO cli_allowlist (token_id, command_prefix, allowed_flags_regex, require_app_match, scope, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.token_id, e.command_prefix, e.allowed_flags_regex, e.require_app_match, e.scope, e.description);
    return Number(info.lastInsertRowid);
  }

  removeAllowlistEntry(id: number): number {
    return Number(this.db.prepare("DELETE FROM cli_allowlist WHERE id = ?").run(id).changes);
  }

  listAllowlist(): (AllowlistRow & { token_name: string | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, t.name AS token_name FROM cli_allowlist a LEFT JOIN tokens t ON t.id = a.token_id
         ORDER BY a.command_prefix, a.id`,
      )
      .all() as unknown as (AllowlistRow & { token_name: string | null })[];
  }

  allowlistFor(tokenId: number): AllowlistRow[] {
    return this.db
      .prepare("SELECT * FROM cli_allowlist WHERE token_id IS NULL OR token_id = ? ORDER BY token_id DESC, id")
      .all(tokenId) as unknown as AllowlistRow[];
  }

  // --- audit & settings ---------------------------------------------------

  audit(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (token_id, method, path, app, command, status, exit_code, remote_addr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.token_id, e.method, e.path, e.app, e.command, e.status, e.exit_code, e.remote_addr);
  }

  listAudit(limit: number): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT a.created_at, t.name AS token, a.method, a.path, a.app, a.command, a.status, a.exit_code, a.remote_addr
         FROM audit_log a LEFT JOIN tokens t ON t.id = a.token_id ORDER BY a.id DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null || value === "") {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    } else {
      this.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
  }

  listSettings(): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
  }
}
