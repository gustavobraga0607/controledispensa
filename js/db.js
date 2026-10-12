// Persistência local com IndexedDB. Tudo fica no aparelho, funciona offline.

const DB_NAME = 'controle-dispensa';
const DB_VERSION = 1;
const STORES = ['groups', 'products', 'movements', 'meta'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('products')) {
        const s = db.createObjectStore('products', { keyPath: 'id' });
        s.createIndex('barcode', 'barcode', { unique: false });
        s.createIndex('groupId', 'groupId', { unique: false });
      }
      if (!db.objectStoreNames.contains('movements')) {
        const s = db.createObjectStore('movements', { keyPath: 'id' });
        s.createIndex('at', 'at', { unique: false });
        s.createIndex('productId', 'productId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function all(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, id) {
  return wrap((await store(name)).get(id));
}

export async function put(name, value) {
  await wrap((await store(name, 'readwrite')).put(value));
  return value;
}

export async function remove(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}

export async function findProductByBarcode(barcode) {
  const s = await store('products');
  return wrap(s.index('barcode').get(String(barcode)));
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// Movimenta o estoque de um produto e registra o histórico (para relatórios e desfazer).
export async function move(productId, type, qty = 1) {
  const db = await open();
  const tx = db.transaction(['products', 'movements', 'groups'], 'readwrite');
  const products = tx.objectStore('products');
  const product = await wrap(products.get(productId));
  if (!product) throw new Error('Produto não encontrado');
  const group = await wrap(tx.objectStore('groups').get(product.groupId));
  const delta = type === 'in' ? qty : -qty;
  product.qty = Math.max(0, (Number(product.qty) || 0) + delta);
  if (type === 'in') product.lastInAt = Date.now();
  products.put(product);
  const movement = {
    id: uid(),
    productId,
    productName: product.name,
    groupId: product.groupId,
    groupName: group ? group.name : '',
    type,
    qty,
    at: Date.now(),
  };
  tx.objectStore('movements').put(movement);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return { product, movement };
}

// Desfaz um movimento (ex.: bipou o produto errado).
export async function undo(movementId) {
  const db = await open();
  const tx = db.transaction(['products', 'movements'], 'readwrite');
  const movements = tx.objectStore('movements');
  const mv = await wrap(movements.get(movementId));
  if (!mv) return null;
  const products = tx.objectStore('products');
  const product = await wrap(products.get(mv.productId));
  if (product) {
    const delta = mv.type === 'in' ? -mv.qty : mv.qty;
    product.qty = Math.max(0, (Number(product.qty) || 0) + delta);
    products.put(product);
  }
  movements.delete(movementId);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return product;
}

export async function exportAll() {
  const data = { app: 'controle-dispensa', version: 1, exportedAt: new Date().toISOString() };
  for (const name of STORES) data[name] = await all(name);
  return data;
}

export async function importAll(data) {
  if (!data || data.app !== 'controle-dispensa') throw new Error('Arquivo de backup inválido');
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const name of STORES) {
    const s = tx.objectStore(name);
    s.clear();
    for (const row of data[name] || []) s.put(row);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
