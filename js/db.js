// Dados do app guardados no Postgres (Neon) através da API em /api.
//
// Sem login: o aparelho guarda a chave da casa (vinda do link de convite) e o nome de quem está usando.
// Tudo fica também numa cópia local (IndexedDB): as telas abrem na hora, o app funciona sem
// internet e as alterações ficam numa fila que é enviada quando a conexão volta.

const COLLECTIONS = ['groups', 'products', 'movements', 'meta', 'users'];
const KEY_STORAGE = 'dispensa:houseKey';
const PERSON_STORAGE = 'dispensa:person';
const SYNC_EVERY_MS = 15_000;
const BATCH = 200;

const cache = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
let house = null; // { id, name }
let cursor = 0;
let outbox = [];
let ready = Promise.resolve();
let syncing = null;
let syncTimer = null;
let lastError = null;
const changeListeners = new Set();

// ---------- cópia local (IndexedDB) ----------

let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('dispensa-nuvem', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('docs', { keyPath: ['col', 'id'] });
        req.result.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function localLoad() {
  const d = await idb();
  const tx = d.transaction(['docs', 'kv'], 'readonly');
  const [docs, kv] = await Promise.all([idbReq(tx.objectStore('docs').getAll()), idbReq(tx.objectStore('kv').getAll())]);
  for (const c of COLLECTIONS) cache[c].clear();
  for (const row of docs) if (cache[row.col]) cache[row.col].set(row.id, row.data);
  const vals = Object.fromEntries(kv.map((r) => [r.k, r.v]));
  cursor = vals.cursor || 0;
  outbox = vals.outbox || [];
  house = vals.house || null;
}

// Grava em segundo plano; a fonte da verdade em memória é o `cache`.
let pendingDocs = new Map();
let pendingKv = new Map();
let flushLocalTimer = null;
function localSaveDoc(col, id, data) {
  pendingDocs.set(`${col}\u0000${id}`, { col, id, data });
  scheduleLocalFlush();
}
function localSaveKv(k, v) {
  pendingKv.set(k, v);
  scheduleLocalFlush();
}
function scheduleLocalFlush() {
  clearTimeout(flushLocalTimer);
  flushLocalTimer = setTimeout(flushLocal, 50);
}
async function flushLocal() {
  const docs = [...pendingDocs.values()];
  const kv = [...pendingKv.entries()];
  pendingDocs = new Map();
  pendingKv = new Map();
  if (!docs.length && !kv.length) return;
  try {
    const d = await idb();
    const tx = d.transaction(['docs', 'kv'], 'readwrite');
    for (const r of docs) {
      if (r.data === null) tx.objectStore('docs').delete([r.col, r.id]);
      else tx.objectStore('docs').put(r);
    }
    for (const [k, v] of kv) tx.objectStore('kv').put({ k, v });
  } catch (err) {
    console.warn('Cópia local indisponível', err);
  }
}

async function localClear() {
  const d = await idb();
  const tx = d.transaction(['docs', 'kv'], 'readwrite');
  tx.objectStore('docs').clear();
  tx.objectStore('kv').clear();
  await new Promise((resolve) => (tx.oncomplete = resolve));
}

// ---------- API ----------

export function houseKey() {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

async function api(path, { method = 'GET', body, key = houseKey() } = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-House-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Sem conexão com o servidor.'), { offline: true });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* resposta sem JSON */
  }
  if (!res.ok) {
    const msg = data?.error || (res.status === 404 ? 'Servidor não encontrado: publique o app na Vercel (veja o README).' : `Erro ${res.status}`);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return data;
}

// ---------- casa ----------

export function household() {
  return house;
}

// Sem chave: informa se já existe uma casa criada no servidor.
export async function serverStatus() {
  return api('house', { key: null });
}

export async function createHouse(name) {
  const { key, house: h } = await api('house', { method: 'POST', body: { action: 'create', name }, key: null });
  await adoptKey(key, h);
  return h;
}

// Usa a chave vinda do link de convite.
export async function joinWithKey(key) {
  key = String(key || '').trim();
  const m = key.match(/[?&]k=([\w-]+)/);
  if (m) key = m[1];
  if (!/^[\w-]{10,}$/.test(key)) throw new Error('Link de convite inválido.');
  const { house: h } = await api('house', { key });
  await adoptKey(key, h);
  return h;
}

async function adoptKey(key, h) {
  if (houseKey() !== key || house?.id !== h.id) {
    await localClear();
    for (const c of COLLECTIONS) cache[c].clear();
    cursor = 0;
    outbox = [];
  }
  localStorage.setItem(KEY_STORAGE, key);
  house = h;
  localSaveKv('house', h);
  ready = sync().catch(() => {});
  await ready;
  startAutoSync();
}

export function inviteLink() {
  const key = houseKey();
  return key ? `${location.origin}${location.pathname}#/convite?k=${key}` : null;
}

export async function renameHouse(name) {
  const { house: h } = await api('house', { method: 'POST', body: { action: 'rename', name } });
  house = h;
  localSaveKv('house', h);
}

// Gera um link novo. Os outros aparelhos precisam abrir o link novo.
export async function rotateKey() {
  const { key } = await api('house', { method: 'POST', body: { action: 'rotate' } });
  localStorage.setItem(KEY_STORAGE, key);
  return key;
}

// Desconecta este aparelho da casa (os dados continuam no servidor).
export async function forgetHouse() {
  stopAutoSync();
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(PERSON_STORAGE);
  house = null;
  outbox = [];
  cursor = 0;
  for (const c of COLLECTIONS) cache[c].clear();
  await localClear();
}

// ---------- quem está usando (sem senha) ----------

export function person() {
  let id = null;
  try {
    id = localStorage.getItem(PERSON_STORAGE);
  } catch {
    /* sem armazenamento */
  }
  const p = id ? cache.users.get(id) : null;
  return p && !p.removed ? { ...p } : null;
}

export function setPerson(id) {
  if (id) localStorage.setItem(PERSON_STORAGE, id);
  else localStorage.removeItem(PERSON_STORAGE);
}

function stamp() {
  const p = person();
  return { userId: p?.id || null, userName: p?.name || '', userIcon: p?.icon || '' };
}

// ---------- sincronização ----------

export async function init() {
  if (!houseKey()) return;
  try {
    await localLoad();
  } catch (err) {
    console.warn(err);
  }
  // Primeira vez neste aparelho: espera baixar os dados. Depois, usa a cópia local na hora.
  ready = cursor ? Promise.resolve() : sync().catch(() => {});
  if (cursor) sync().catch(() => {});
  await ready;
  startAutoSync();
}

function startAutoSync() {
  stopAutoSync();
  syncTimer = setInterval(() => document.visibilityState === 'visible' && sync().catch(() => {}), SYNC_EVERY_MS);
  window.addEventListener('online', onWake);
  document.addEventListener('visibilitychange', onWake);
}

function stopAutoSync() {
  clearInterval(syncTimer);
  window.removeEventListener('online', onWake);
  document.removeEventListener('visibilitychange', onWake);
}

function onWake() {
  if (document.visibilityState === 'visible') sync().catch(() => {});
}

// Envia a fila e baixa o que mudou. Chamadas simultâneas reaproveitam a mesma execução.
export function sync() {
  if (!houseKey()) return Promise.resolve();
  if (!syncing) {
    syncing = (async () => {
      try {
        await pushOutbox();
        const res = await api(`sync?since=${cursor}`);
        let changed = false;
        for (const d of res.docs) {
          if (!cache[d.col]) continue;
          // Não sobrescreve o que ainda está na fila para subir.
          if (outbox.some((op) => op.col === d.col && op.docId === d.id)) continue;
          const current = cache[d.col].get(d.id);
          if (d.deleted) {
            if (current) {
              cache[d.col].delete(d.id);
              localSaveDoc(d.col, d.id, null);
              changed = true;
            }
          } else {
            const data = { ...d.data, id: d.col === 'meta' ? d.data.key : d.id };
            if (JSON.stringify(current) !== JSON.stringify(data)) {
              cache[d.col].set(d.id, data);
              localSaveDoc(d.col, d.id, data);
              changed = true;
            }
          }
        }
        if (res.house && res.house.name !== house?.name) {
          house = res.house;
          localSaveKv('house', house);
          changed = true;
        }
        cursor = res.now;
        localSaveKv('cursor', cursor);
        if (lastError) {
          lastError = null;
          emit({ type: 'status' });
        }
        if (changed) emit({ type: 'remote' });
      } catch (err) {
        lastError = err;
        if (err.status === 401) {
          await forgetHouse();
          emit({ type: 'auth', error: err });
        } else {
          emit({ type: 'status' });
        }
        throw err;
      } finally {
        syncing = null;
      }
    })();
  }
  return syncing;
}

async function pushOutbox() {
  while (outbox.length) {
    const batch = outbox.slice(0, BATCH);
    try {
      await api('ops', { method: 'POST', body: { ops: batch } });
    } catch (err) {
      // Lote recusado pelo servidor (dado inválido): descarta para não travar a fila para sempre.
      if (!(err.status >= 400 && err.status < 500 && err.status !== 401)) throw err;
      console.error('Alterações recusadas pelo servidor', err, batch);
    }
    const sent = new Set(batch.map((op) => op.id));
    outbox = outbox.filter((op) => !sent.has(op.id));
    localSaveKv('outbox', outbox);
  }
}

let pushTimer = null;
function enqueue(...ops) {
  outbox.push(...ops.map((op) => ({ id: uid() + uid(), ...op })));
  localSaveKv('outbox', outbox);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync().catch(() => {}), 300);
  emit({ type: 'status' });
}

export function syncStatus() {
  return { pending: outbox.length, error: lastError ? lastError.message : null, offline: Boolean(lastError?.offline) };
}

export function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emit(evt) {
  for (const fn of changeListeners) fn(evt);
}

// ---------- dados (mesma interface usada pelas telas) ----------

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function keyOf(name, value) {
  return name === 'meta' ? value.key : value.id;
}

function setLocal(name, id, data) {
  if (data === null) cache[name].delete(id);
  else cache[name].set(id, data);
  localSaveDoc(name, id, data);
}

export async function all(name) {
  await ready;
  return [...cache[name].values()].map((v) => ({ ...v }));
}

export async function get(name, id) {
  await ready;
  const v = cache[name].get(id);
  return v ? { ...v } : undefined;
}

export async function put(name, value) {
  const id = keyOf(name, value);
  const data = { ...value, id: name === 'meta' ? value.key : value.id };
  setLocal(name, id, data);
  enqueue({ op: 'put', col: name, docId: id, data });
  return value;
}

export async function remove(name, id) {
  setLocal(name, id, null);
  enqueue({ op: 'remove', col: name, docId: id });
}

export async function findProductByBarcode(barcode) {
  await ready;
  for (const p of cache.products.values()) if (p.barcode && p.barcode === String(barcode)) return { ...p };
  return undefined;
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// Movimenta o estoque e registra quem fez. O servidor soma a diferença (não sobrescreve a quantidade),
// então duas pessoas mexendo ao mesmo tempo não perdem nenhuma baixa.
export async function move(productId, type, qty = 1) {
  await ready;
  const product = cache.products.get(productId);
  if (!product) throw new Error('Produto não encontrado');
  const group = cache.groups.get(product.groupId);
  const current = Number(product.qty) || 0;
  const delta = type === 'in' ? qty : -Math.min(qty, current);
  const movement = {
    id: uid(),
    productId,
    productName: product.name,
    groupId: product.groupId,
    groupName: group ? group.name : '',
    type,
    qty,
    at: Date.now(),
    ...stamp(),
  };
  const set = type === 'in' ? { lastInAt: movement.at } : {};
  const updated = { ...product, ...set, qty: current + delta };
  setLocal('products', productId, updated);
  setLocal('movements', movement.id, movement);
  enqueue(
    { op: 'inc', col: 'products', docId: productId, field: 'qty', delta, set },
    { op: 'put', col: 'movements', docId: movement.id, data: movement },
  );
  return { product: { ...updated }, movement };
}

// Registra no log uma ação que não mexe no estoque (cadastro, edição, exclusão…).
export async function log(action, text, extra = {}) {
  return put('movements', { id: uid(), type: 'log', action, text, qty: 0, at: Date.now(), ...stamp(), ...extra });
}

// Desfaz um movimento (ex.: bipou o produto errado).
export async function undo(movementId) {
  await ready;
  const mv = cache.movements.get(movementId);
  if (!mv) return null;
  const me = stamp();
  const ops = [];
  let product = cache.products.get(mv.productId);
  if (product) {
    const delta = mv.type === 'in' ? -Math.min(mv.qty, Number(product.qty) || 0) : mv.qty;
    product = { ...product, qty: (Number(product.qty) || 0) + delta };
    setLocal('products', product.id, product);
    ops.push({ op: 'inc', col: 'products', docId: product.id, field: 'qty', delta });
  }
  setLocal('movements', movementId, null);
  ops.push({ op: 'remove', col: 'movements', docId: movementId });
  const entry = {
    id: uid(),
    type: 'log',
    action: 'undo',
    text: `desfez ${mv.type === 'in' ? 'entrada' : 'saída'} de ${mv.qty} ${mv.productName}${mv.userName && mv.userName !== me.userName ? ` (feita por ${mv.userName})` : ''}`,
    productId: mv.productId,
    qty: 0,
    at: Date.now(),
    ...me,
  };
  setLocal('movements', entry.id, entry);
  ops.push({ op: 'put', col: 'movements', docId: entry.id, data: entry });
  enqueue(...ops);
  return product ? { ...product } : null;
}

export async function exportAll() {
  await ready;
  const data = { app: 'controle-dispensa', version: 3, household: house?.name || '', exportedAt: new Date().toISOString() };
  for (const name of COLLECTIONS) data[name] = await all(name);
  return data;
}

// Restaura um backup (ou importa os dados antigos que estavam só no aparelho).
// `replace`: apaga antes os dados atuais. As pessoas só são importadas se ainda não existirem.
export async function importAll(data, { replace = true } = {}) {
  if (!data || data.app !== 'controle-dispensa') throw new Error('Arquivo de backup inválido');
  await ready;
  const ops = [];
  for (const name of COLLECTIONS) {
    if (replace && name !== 'users') {
      for (const id of [...cache[name].keys()]) {
        setLocal(name, id, null);
        ops.push({ op: 'remove', col: name, docId: id });
      }
    }
    for (const row of data[name] || []) {
      const id = keyOf(name, row);
      if (!id || (name === 'users' && cache.users.has(id))) continue;
      const { pinHash, ...clean } = row; // PIN da versão antiga não é mais usado
      const doc = { ...clean, id };
      setLocal(name, id, doc);
      ops.push({ op: 'put', col: name, docId: id, data: doc });
    }
  }
  enqueue(...ops);
  await sync().catch(() => {});
  return ops.length;
}
