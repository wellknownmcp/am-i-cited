/**
 * Per-user BYOK vault — encrypted storage for users' engine API keys.
 *
 * Design (full write-up: docs/byok.md):
 * - AES-256-GCM, one random IV per write, auth tag stored alongside.
 * - Master key from AMICITED_VAULT_KEY (64 hex chars = 32 bytes). The server
 *   REFUSES to start without it — there is no default key, ever.
 * - One file per user under data/vault/<sha256(userId)>.json. The user id
 *   never appears on disk in clear.
 * - Keys are write-only: the vault can return them to the probe runner, but
 *   the API surface only ever exposes a masked status (last 4 chars).
 * - Every mutation appends an audit line (who/what/when — never the value).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ENGINES = ['perplexity', 'openai', 'anthropic'];

function masterKey() {
  const hex = process.env.AMICITED_VAULT_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'AMICITED_VAULT_KEY is required (64 hex chars). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

export class Vault {
  constructor(dataDir) {
    this.key = masterKey(); // throws at construction: fail fast, no fallback
    this.dir = join(dataDir, 'vault');
    this.auditPath = join(dataDir, 'vault-audit.log');
    mkdirSync(this.dir, { recursive: true });
  }

  #path(userId) {
    return join(this.dir, createHash('sha256').update(String(userId)).digest('hex') + '.json');
  }

  #load(userId) {
    try { return JSON.parse(readFileSync(this.#path(userId), 'utf8')); } catch { return { engines: {} }; }
  }

  #audit(userId, action, engine) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      user_hash: createHash('sha256').update(String(userId)).digest('hex').slice(0, 16),
      action, engine,
    });
    appendFileSync(this.auditPath, line + '\n');
  }

  #encrypt(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  #decrypt({ iv, tag, data }) {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  setKey(userId, engine, apiKey) {
    if (!ENGINES.includes(engine)) throw new Error(`Unknown engine: ${engine} (expected ${ENGINES.join('/')})`);
    const k = String(apiKey ?? '').trim();
    if (k.length < 8 || k.length > 512) throw new Error('api_key looks invalid (8-512 chars expected)');
    const store = this.#load(userId);
    store.engines[engine] = { ...this.#encrypt(k), last4: k.slice(-4), setAt: new Date().toISOString() };
    writeFileSync(this.#path(userId), JSON.stringify(store), { mode: 0o600 });
    this.#audit(userId, 'set', engine);
    return this.status(userId);
  }

  deleteKey(userId, engine) {
    const store = this.#load(userId);
    const existed = Boolean(store.engines[engine]);
    delete store.engines[engine];
    writeFileSync(this.#path(userId), JSON.stringify(store), { mode: 0o600 });
    this.#audit(userId, 'delete', engine);
    return { deleted: existed, engine };
  }

  deleteAll(userId) {
    if (existsSync(this.#path(userId))) rmSync(this.#path(userId));
    this.#audit(userId, 'delete_all', '*');
    return { deleted: true };
  }

  /** Masked view — the only thing the API surface ever returns. */
  status(userId) {
    const store = this.#load(userId);
    return {
      engines: Object.fromEntries(ENGINES.map((e) => [e, store.engines[e]
        ? { configured: true, last4: store.engines[e].last4, setAt: store.engines[e].setAt }
        : { configured: false }])),
    };
  }

  /** Decrypted keys — for the probe runner only. NEVER serialize into a response or a log. */
  keysFor(userId) {
    const store = this.#load(userId);
    const out = {};
    for (const e of ENGINES) if (store.engines[e]) out[e] = this.#decrypt(store.engines[e]);
    return out;
  }
}

export { ENGINES };
