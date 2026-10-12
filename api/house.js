// /api/house
//   GET                          → { exists }                       (sem chave)
//   GET  com X-House-Key         → { house: { id, name } }
//   POST { action: 'create', name }  → cria a casa (só se ainda não existir nenhuma) → { key, house }
//   POST { action: 'rename', name }  → renomeia
//   POST { action: 'rotate' }        → gera um link novo; o antigo deixa de funcionar → { key }
import { handler, getPool, houseFromRequest, httpError, hashKey, newKey, newId } from './_lib.js';

export default handler(async ({ req, body }) => {
  const db = getPool();
  if (req.method === 'GET') {
    if (req.headers['x-house-key']) return { house: await houseFromRequest(req) };
    const { rows } = await db.query('select count(*)::int as n from houses');
    return { exists: rows[0].n > 0 };
  }
  if (req.method !== 'POST') throw httpError(405, 'Método não permitido');

  if (body.action === 'create') {
    const name = String(body.name || 'Nossa casa').trim().slice(0, 60) || 'Nossa casa';
    // Uma casa por instalação, para ninguém usar o seu banco criando casas novas.
    // Defina ALLOW_NEW_HOUSES=1 na Vercel para permitir várias casas.
    if (process.env.ALLOW_NEW_HOUSES !== '1') {
      const { rows } = await db.query('select count(*)::int as n from houses');
      if (rows[0].n > 0) throw httpError(403, 'A casa já foi criada. Peça o link de convite para quem criou.');
    }
    const key = newKey();
    const house = { id: newId(), name };
    await db.query('insert into houses (id, name, key_hash) values ($1, $2, $3)', [house.id, house.name, hashKey(key)]);
    return { key, house };
  }

  const house = await houseFromRequest(req);
  if (body.action === 'rename') {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Informe o nome da casa');
    await db.query('update houses set name = $1 where id = $2', [name, house.id]);
    return { house: { ...house, name } };
  }
  if (body.action === 'rotate') {
    const key = newKey();
    await db.query('update houses set key_hash = $1 where id = $2', [hashKey(key), house.id]);
    return { key };
  }
  throw httpError(400, 'Ação desconhecida');
});
