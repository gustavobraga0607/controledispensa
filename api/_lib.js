// Código compartilhado da API (Vercel Functions) que guarda os dados no Postgres do Neon.
//
// O navegador nunca vê a senha do banco (DATABASE_URL fica só no servidor).
// Não há login: cada casa tem uma chave secreta que vai no link de convite.
// Quem tem o link acessa a casa; sem ele a API responde 401.

import crypto from 'node:crypto';
import pg from 'pg';

export const COLLECTIONS = new Set(['groups', 'products', 'movements', 'meta', 'users']);

let pool = null;
let schemaReady = null;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw httpError(500, 'DATABASE_URL não configurada. Conecte o banco Neon ao projeto na Vercel (Storage → Neon).');
  }
  if (!pool) {
    const url = process.env.DATABASE_URL;
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
    pool = new pg.Pool({ connectionString: url, max: 3, ssl: local ? false : true });
  }
  return pool;
}

// Cria as tabelas na primeira chamada (não precisa rodar nada manualmente no Neon).
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `create table if not exists houses (
           id text primary key,
           name text not null,
           key_hash text not null unique,
           created_at timestamptz not null default now()
         );
         create table if not exists docs (
           house_id text not null references houses(id) on delete cascade,
           col text not null,
           id text not null,
           data jsonb not null,
           deleted boolean not null default false,
           updated_at bigint not null,
           primary key (house_id, col, id)
         );
         create index if not exists docs_sync_idx on docs (house_id, updated_at);
         create table if not exists applied_ops (
           house_id text not null,
           op_id text not null,
           applied_at timestamptz not null default now(),
           primary key (house_id, op_id)
         );`,
      )
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

export function newKey() {
  return crypto.randomBytes(18).toString('base64url');
}

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// Descobre a casa pela chave enviada no cabeçalho X-House-Key.
export async function houseFromRequest(req) {
  const key = req.headers['x-house-key'];
  if (!key) throw httpError(401, 'Abra o link de convite da casa neste aparelho.');
  const { rows } = await getPool().query('select id, name from houses where key_hash = $1', [hashKey(key)]);
  if (!rows.length) throw httpError(401, 'Link de convite inválido ou trocado. Peça o link novo.');
  return rows[0];
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Envolve um handler: cria as tabelas, lê o JSON e devolve erros de forma padronizada.
export function handler(fn) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(payload));
    };
    try {
      await ensureSchema();
      const body = req.method === 'GET' ? {} : await readBody(req);
      const url = new URL(req.url, 'http://x');
      send(200, await fn({ req, body, query: Object.fromEntries(url.searchParams) }));
    } catch (err) {
      if (!err.status) console.error(err);
      send(err.status || 500, { error: err.status ? err.message : `Erro no servidor: ${err.message}` });
    }
  };
}

export const now = () => Date.now();
