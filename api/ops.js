// POST /api/ops { ops: [...] } → aplica as alterações enviadas pelo app (fila de gravações).
//
// Operações:
//   { id, op: 'put',    col, docId, data }                 grava o documento inteiro
//   { id, op: 'remove', col, docId }                       exclui
//   { id, op: 'inc',    col, docId, field, delta, set }    soma `delta` no campo (nunca abaixo de 0)
//                                                          e grava os campos de `set`
// Cada operação tem um id: se o celular reenviar (internet caiu no meio), ela não é aplicada duas vezes.
import { handler, getPool, houseFromRequest, httpError, COLLECTIONS } from './_lib.js';

const MAX_OPS = 500;

export default handler(async ({ req, body }) => {
  if (req.method !== 'POST') throw httpError(405, 'Método não permitido');
  const house = await houseFromRequest(req);
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length > MAX_OPS) throw httpError(413, `Envie no máximo ${MAX_OPS} operações por vez`);
  for (const op of ops) {
    if (!op || typeof op.id !== 'string' || !COLLECTIONS.has(op.col) || typeof op.docId !== 'string' || !op.docId) {
      throw httpError(400, 'Operação inválida');
    }
  }

  const client = await getPool().connect();
  let applied = 0;
  try {
    await client.query('begin');
    for (const op of ops) {
      const fresh = await client.query(
        'insert into applied_ops (house_id, op_id) values ($1, $2) on conflict do nothing returning op_id',
        [house.id, op.id],
      );
      if (!fresh.rowCount) continue; // já aplicada antes
      const at = Date.now();
      if (op.op === 'put') {
        await client.query(
          `insert into docs (house_id, col, id, data, deleted, updated_at) values ($1, $2, $3, $4, false, $5)
           on conflict (house_id, col, id) do update set data = excluded.data, deleted = false, updated_at = excluded.updated_at`,
          [house.id, op.col, op.docId, JSON.stringify(op.data ?? {}), at],
        );
      } else if (op.op === 'remove') {
        await client.query(
          `insert into docs (house_id, col, id, data, deleted, updated_at) values ($1, $2, $3, '{}', true, $4)
           on conflict (house_id, col, id) do update set data = '{}', deleted = true, updated_at = excluded.updated_at`,
          [house.id, op.col, op.docId, at],
        );
      } else if (op.op === 'inc') {
        if (!/^[A-Za-z]\w*$/.test(op.field || '')) throw httpError(400, 'Campo inválido');
        await client.query(
          `update docs
              set data = (data || $5::jsonb) || jsonb_build_object($4::text, greatest(0, coalesce((data->>$4)::numeric, 0) + $6::numeric)),
                  updated_at = $7
            where house_id = $1 and col = $2 and id = $3 and not deleted`,
          [house.id, op.col, op.docId, op.field, JSON.stringify(op.set || {}), Number(op.delta) || 0, at],
        );
      } else {
        throw httpError(400, `Operação desconhecida: ${op.op}`);
      }
      applied++;
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Limpeza ocasional do controle de operações repetidas.
  if (Math.random() < 0.02) {
    getPool().query("delete from applied_ops where applied_at < now() - interval '30 days'").catch(() => {});
  }
  return { applied, now: Date.now() };
});
