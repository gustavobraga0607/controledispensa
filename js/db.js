// Dados na nuvem (Firebase: Authentication + Cloud Firestore).
//
// Cada família tem uma "casa" (households/{casaId}) com os produtos, grupos, movimentações e
// as pessoas que participam. O Firestore mantém uma cópia local, então o app continua
// funcionando sem internet e sincroniza quando a conexão volta.
//
// As leituras vêm de um cache em memória alimentado por listeners em tempo real; assim as telas
// abrem na hora e mudanças feitas por outra pessoa aparecem sozinhas.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
  onSnapshot,
  query,
  where,
  increment,
  arrayUnion,
  arrayRemove,
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { firebaseConfig as fileConfig } from './firebase-config.js';

const COLLECTIONS = ['groups', 'products', 'movements', 'meta', 'users'];
const HISTORY_DAYS = 400; // movimentações carregadas (relatório de até 12 meses + folga)
const CONFIG_KEY = 'dispensa:firebaseConfig';
const HOUSEHOLD_KEY = 'dispensa:household';

let app = null;
let auth = null;
let fs = null;
let authUser = null;
let house = null; // { id, name, inviteCode, members }
let unsubs = [];
let ready = Promise.resolve();
const cache = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const changeListeners = new Set();

// ---------- configuração ----------

export function getConfig() {
  if (fileConfig && fileConfig.apiKey) return fileConfig;
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
  } catch {
    return null;
  }
}

export function isConfigured() {
  return Boolean(getConfig());
}

export function configFromFile() {
  return Boolean(fileConfig && fileConfig.apiKey);
}

// Aceita o trecho copiado do console do Firebase (objeto JS) ou JSON puro.
export function parseConfig(text) {
  const body = String(text).match(/\{[\s\S]*\}/);
  if (!body) throw new Error('Cole o bloco firebaseConfig = { ... } do console do Firebase.');
  const json = body[0]
    .replace(/\/\/.*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}');
  const cfg = JSON.parse(json);
  if (!cfg.apiKey || !cfg.projectId) throw new Error('Configuração incompleta: faltam apiKey ou projectId.');
  return cfg;
}

export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

// ---------- inicialização e login ----------

// Inicia o Firebase e resolve com o usuário logado (ou null) assim que o login for conhecido.
export function init() {
  const cfg = getConfig();
  if (!cfg) return Promise.resolve(null);
  app = initializeApp(cfg);
  auth = getAuth(app);
  fs = initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  // Projetos "demo-*" usam os emuladores locais do Firebase (desenvolvimento e testes).
  if (cfg.projectId.startsWith('demo-')) {
    connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(fs, location.hostname, 8080);
  }
  return new Promise((resolve) => {
    let first = true;
    onAuthStateChanged(auth, async (user) => {
      const changed = !first && (user?.uid || null) !== (authUser?.uid || null);
      authUser = user;
      if (!user) closeHousehold();
      if (first) {
        first = false;
        resolve(user);
      } else if (changed) {
        emit({ type: 'auth' });
      }
    });
  });
}

export function currentAuthUser() {
  return authUser;
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/email-already-in-use': 'Já existe uma conta com esse e-mail. Use "Entrar".',
  'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
  'auth/popup-closed-by-user': 'Login cancelado.',
  'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Tente de novo ou use e-mail e senha.',
  'auth/network-request-failed': 'Sem internet. Conecte-se para entrar.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  'auth/operation-not-allowed': 'Esse tipo de login não está ativado no projeto Firebase.',
  'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
};

function friendly(err) {
  const msg = AUTH_ERRORS[err?.code];
  return msg ? new Error(msg) : err;
}

export async function loginEmail(email, password) {
  try {
    return (await signInWithEmailAndPassword(auth, email, password)).user;
  } catch (err) {
    throw friendly(err);
  }
}

export async function signupEmail(name, email, password) {
  try {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(user, { displayName: name });
    return user;
  } catch (err) {
    throw friendly(err);
  }
}

export async function loginGoogle() {
  try {
    return (await signInWithPopup(auth, new GoogleAuthProvider())).user;
  } catch (err) {
    throw friendly(err);
  }
}

export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) {
    throw friendly(err);
  }
}

export async function logout() {
  closeHousehold();
  localStorage.removeItem(HOUSEHOLD_KEY);
  await signOut(auth);
}

// ---------- casa (household) ----------

export function household() {
  return house;
}

export function lastHouseholdId() {
  return localStorage.getItem(HOUSEHOLD_KEY);
}

export async function myHouseholds() {
  const snap = await getDocs(query(collection(fs, 'households'), where('members', 'array-contains', authUser.uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para não confundir
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function memberProfile(profile) {
  return {
    id: authUser.uid,
    name: profile.name || authUser.displayName || (authUser.email || '').split('@')[0] || 'Eu',
    icon: profile.icon || '🙂',
    email: authUser.email || '',
    joinedAt: Date.now(),
  };
}

export async function createHousehold(name, profile) {
  const ref = doc(collection(fs, 'households'));
  const code = randomCode();
  const batch = writeBatch(fs);
  batch.set(ref, { name, members: [authUser.uid], inviteCode: code, createdBy: authUser.uid, createdAt: Date.now() });
  batch.set(doc(fs, 'invites', code), { householdId: ref.id, createdAt: Date.now() });
  batch.set(doc(ref, 'users', authUser.uid), memberProfile(profile));
  await batch.commit();
  await openHousehold(ref.id);
  return house;
}

export async function joinHousehold(code, profile) {
  code = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  let invite;
  try {
    invite = await getDoc(doc(fs, 'invites', code));
  } catch (err) {
    throw new Error(err.code === 'unavailable' ? 'Sem internet. Conecte-se para entrar na casa.' : err.message);
  }
  if (!invite.exists()) throw new Error('Código de convite não encontrado. Confira as letras e números.');
  const hid = invite.data().householdId;
  const ref = doc(fs, 'households', hid);
  await updateDoc(ref, { members: arrayUnion(authUser.uid), joinCode: code });
  await setDoc(doc(ref, 'users', authUser.uid), memberProfile(profile));
  await openHousehold(hid);
  return house;
}

// Gera um código novo (o antigo deixa de funcionar).
export async function newInviteCode() {
  const code = randomCode();
  const ref = doc(fs, 'households', house.id);
  const batch = writeBatch(fs);
  batch.set(doc(fs, 'invites', code), { householdId: house.id, createdAt: Date.now() });
  if (house.inviteCode) batch.delete(doc(fs, 'invites', house.inviteCode));
  batch.update(ref, { inviteCode: code });
  await batch.commit();
  return code;
}

export async function renameHousehold(name) {
  await commitLater(updateDoc(doc(fs, 'households', house.id), { name }));
  house.name = name;
}

export async function leaveHousehold() {
  const ref = doc(fs, 'households', house.id);
  await deleteDoc(doc(ref, 'users', authUser.uid));
  await updateDoc(ref, { members: arrayRemove(authUser.uid) });
  closeHousehold();
  localStorage.removeItem(HOUSEHOLD_KEY);
}

export function profile() {
  return authUser && house ? cache.users.get(authUser.uid) || null : null;
}

export async function saveProfile(data) {
  const current = profile() || memberProfile({});
  return put('users', { ...current, ...data, id: authUser.uid });
}

function closeHousehold() {
  unsubs.forEach((u) => u());
  unsubs = [];
  house = null;
  for (const c of COLLECTIONS) cache[c].clear();
}

// Abre a casa e começa a escutar as coleções. Resolve quando os dados iniciais chegaram.
export function openHousehold(hid) {
  closeHousehold();
  localStorage.setItem(HOUSEHOLD_KEY, hid);
  const ref = doc(fs, 'households', hid);
  const waits = [];
  const listen = (name, target, onData) =>
    new Promise((resolve, reject) => {
      let first = true;
      const unsub = onSnapshot(
        target,
        (snap) => {
          onData(snap);
          if (first) {
            first = false;
            resolve();
          } else if (!snap.metadata.hasPendingWrites) {
            // Mudança vinda de outro aparelho.
            emit({ type: 'remote', collection: name });
          }
        },
        (err) => {
          if (first) reject(err);
          else console.error(name, err);
        },
      );
      unsubs.push(unsub);
    });

  waits.push(
    listen('household', ref, (snap) => {
      if (!snap.exists() || !(snap.data().members || []).includes(authUser.uid)) {
        house = null;
        return;
      }
      house = { id: snap.id, ...snap.data() };
    }),
  );
  for (const name of COLLECTIONS) {
    let target = collection(ref, name);
    if (name === 'movements') target = query(target, where('at', '>=', Date.now() - HISTORY_DAYS * 864e5));
    waits.push(
      listen(name, target, (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type === 'removed') cache[name].delete(change.doc.id);
          else cache[name].set(change.doc.id, { ...change.doc.data(), id: change.doc.id });
        }
      }),
    );
  }
  ready = Promise.all(waits).then(
    () => {
      if (!house) throw new Error('Você não faz parte desta casa.');
      return house;
    },
    (err) => {
      closeHousehold();
      localStorage.removeItem(HOUSEHOLD_KEY);
      throw err.code === 'permission-denied' ? new Error('Sem acesso a esta casa.') : err;
    },
  );
  return ready;
}

// Avisos de mudanças: { type: 'remote', collection } ou { type: 'auth' }.
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

function col(name) {
  if (!house) throw new Error('Nenhuma casa aberta.');
  return collection(fs, 'households', house.id, name);
}

// Gravações não esperam o servidor: offline elas ficam na fila e sobem quando a internet voltar.
function commitLater(promise) {
  promise.catch((err) => {
    console.error(err);
    emit({ type: 'error', error: err });
  });
  return Promise.resolve();
}

function stamp() {
  const me = profile();
  return { userId: authUser?.uid || null, userName: me?.name || authUser?.displayName || authUser?.email || '', userIcon: me?.icon || '' };
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

function keyOf(name, value) {
  return name === 'meta' ? value.key : value.id;
}

export async function put(name, value) {
  const id = keyOf(name, value);
  const data = { ...value };
  cache[name].set(id, { ...data, id });
  await commitLater(setDoc(doc(col(name), id), data));
  return value;
}

export async function remove(name, id) {
  cache[name].delete(id);
  await commitLater(deleteDoc(doc(col(name), id)));
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

// Movimenta o estoque de um produto e registra quem fez.
// Usa increment() para somar corretamente quando dois celulares mexem ao mesmo tempo.
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
  const changes = { qty: increment(delta) };
  if (type === 'in') changes.lastInAt = Date.now();
  const batch = writeBatch(fs);
  batch.update(doc(col('products'), productId), changes);
  batch.set(doc(col('movements'), movement.id), movement);
  product.qty = current + delta;
  if (type === 'in') product.lastInAt = changes.lastInAt;
  cache.movements.set(movement.id, movement);
  await commitLater(batch.commit());
  return { product: { ...product }, movement };
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
  const batch = writeBatch(fs);
  const product = cache.products.get(mv.productId);
  if (product) {
    const delta = mv.type === 'in' ? -Math.min(mv.qty, Number(product.qty) || 0) : mv.qty;
    batch.update(doc(col('products'), mv.productId), { qty: increment(delta) });
    product.qty = (Number(product.qty) || 0) + delta;
  }
  batch.delete(doc(col('movements'), movementId));
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
  batch.set(doc(col('movements'), entry.id), entry);
  cache.movements.delete(movementId);
  cache.movements.set(entry.id, entry);
  await commitLater(batch.commit());
  return product ? { ...product } : null;
}

export async function exportAll() {
  await ready;
  const data = { app: 'controle-dispensa', version: 2, household: house?.name || '', exportedAt: new Date().toISOString() };
  for (const name of COLLECTIONS) data[name] = await all(name);
  return data;
}

// Restaura um backup (ou importa os dados antigos que estavam só no aparelho).
// `replace`: apaga antes os dados atuais da casa. As pessoas (contas) nunca são importadas.
export async function importAll(data, { replace = true } = {}) {
  if (!data || data.app !== 'controle-dispensa') throw new Error('Arquivo de backup inválido');
  await ready;
  const ops = [];
  for (const name of ['groups', 'products', 'movements', 'meta']) {
    if (replace) for (const id of cache[name].keys()) ops.push((b) => b.delete(doc(col(name), id)));
    for (const row of data[name] || []) {
      const id = keyOf(name, row);
      if (id) ops.push((b) => b.set(doc(col(name), id), row));
    }
  }
  // Firestore aceita até 500 operações por lote.
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
  return ops.length;
}
