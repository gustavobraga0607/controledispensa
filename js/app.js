import * as db from './db.js';
import { suggestGroup, guessCategory, CATEGORIES } from './similarity.js';
import { groupStock, stockStatus, shoppingList, consumptionReport, monthLabel, variation } from './logic.js';
import { startScanner, beep } from './scanner.js';

let view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back-btn');
let cleanup = null; // encerra câmera/timers ao trocar de tela

// ---------- utilidades ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = view) => root.querySelector(sel);
const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];
const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString('pt-BR');
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');

// Preferências deste aparelho (não vão para a nuvem).
function pref(key, fallback) {
  try {
    const v = localStorage.getItem(`dispensa:pref:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(`dispensa:pref:${key}`, JSON.stringify(value));
  } catch {
    /* sem armazenamento */
  }
}

function thumb(p, cls = 'thumb') {
  return p && p.photo ? `<img class="${cls}" src="${esc(p.photo)}" alt="" loading="lazy">` : `<div class="${cls}">🥫</div>`;
}

function productLabel(p) {
  return [p.name, p.size].filter(Boolean).join(' · ');
}

let toastTimer = null;
function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => {
      el.classList.remove('show');
      action.run();
    };
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2500);
}

function go(hash) {
  location.hash = hash;
}

async function loadAll() {
  const [groups, products] = await Promise.all([db.all('groups'), db.all('products')]);
  return { groups: groups.sort(byName), products: products.sort(byName) };
}

// Reduz a foto para ~480px para não pesar no armazenamento do celular.
function resizeImage(file, max = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    img.onerror = () => reject(new Error('Imagem inválida'));
    img.src = url;
  });
}

// Busca dados do produto pelo código na base pública Open Food Facts.
async function lookupBarcode(code) {
  if (!navigator.onLine || !pref('lookupOnline', true)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_pt,brands,quantity,image_front_small_url`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    let photo = null;
    if (p.image_front_small_url) {
      try {
        const blob = await (await fetch(p.image_front_small_url)).blob();
        photo = await resizeImage(blob);
      } catch {
        photo = p.image_front_small_url;
      }
    }
    return {
      name: p.product_name_pt || p.product_name || '',
      brand: (p.brands || '').split(',')[0].trim(),
      size: p.quantity || '',
      photo,
    };
  } catch {
    return null;
  }
}

// ---------- telas ----------

const routes = [
  [/^\/$/, home, 'Dispensa', 'home'],
  [/^\/estoque$/, estoque, 'Estoque', 'estoque'],
  [/^\/produto\/novo$/, productForm, 'Novo produto', 'estoque', true],
  [/^\/produto\/([\w-]+)$/, productDetail, 'Produto', 'estoque', true],
  [/^\/produto\/([\w-]+)\/editar$/, productForm, 'Editar produto', 'estoque', true],
  [/^\/grupos$/, grupos, 'Grupos de produtos', 'estoque', true],
  [/^\/grupo\/([\w-]+)$/, grupoForm, 'Grupo', 'estoque', true],
  [/^\/bipar\/(saida|entrada)$/, bipar, 'Bipar produtos', 'bipar'],
  [/^\/compras$/, compras, 'Lista de compras', 'compras'],
  [/^\/relatorio$/, relatorio, 'Relatório de consumo', 'relatorio'],
  [/^\/mais$/, mais, 'Mais opções', 'home', true],
  [/^\/historico$/, historico, 'Histórico', 'home', true],
  [/^\/casa$/, casa, 'Casa e pessoas', 'home', true],
  [/^\/convite$/, convite, 'Convite', 'home'],
  [/^\/entrar$/, entrar, 'Quem está usando?', 'home'],
  [/^\/pessoa\/([\w-]+)$/, pessoaForm, 'Pessoa', 'home', true],
];

// Telas que funcionam antes de abrir a casa / escolher a pessoa.
const OPEN_ROUTES = /^\/(casa|convite)$/;
const NO_PERSON_ROUTES = /^\/(casa|convite|entrar|pessoa\/novo)$/;
// Telas que se atualizam sozinhas quando outra pessoa mexe nos dados.
const LIVE_ROUTES = /^\/(|estoque|compras|relatorio|historico|grupos)$/;

async function router() {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignora */
    }
    cleanup = null;
  }
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  // Antes de usar: este aparelho precisa estar ligado a uma casa e saber quem está usando.
  if (!OPEN_ROUTES.test(path) && !db.houseKey()) return go('#/casa');
  if (!NO_PERSON_ROUTES.test(path) && db.houseKey() && !db.person()) return go(`#/entrar?next=${encodeURIComponent(raw)}`);
  currentPath = path;
  for (const [re, fn, title, tab, back] of routes) {
    const m = path.match(re);
    if (!m) continue;
    titleEl.textContent = title;
    backBtn.hidden = !back;
    $$('.tabbar a', document).forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    // Troca o <main> por um novo para descartar os listeners da tela anterior.
    const fresh = view.cloneNode(false);
    view.replaceWith(fresh);
    view = fresh;
    window.scrollTo(0, 0);
    try {
      await fn({ args: m.slice(1), params, path });
    } catch (err) {
      console.error(err);
      view.innerHTML = `<div class="card"><b>Ops!</b><p class="muted">${esc(err.message)}</p></div>`;
    }
    return;
  }
  go('#/');
}

// Uma tela por vez: a próxima só começa depois que a anterior terminou de desenhar.
let rendering = Promise.resolve();
let currentPath = null;
const navigate = () => (rendering = rendering.then(router, router));

backBtn.onclick = () => (history.length > 1 ? history.back() : go('#/'));
window.addEventListener('hashchange', navigate);

// ----- Início -----
async function home() {
  const { groups, products } = await loadAll();
  const list = shoppingList(groups, products);
  const totalItems = products.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const recent = (await db.all('movements')).sort((a, b) => b.at - a.at).slice(0, 5);

  view.innerHTML = `
    <div class="big-actions">
      <a href="#/bipar/saida" class="hero"><span>📷</span><b>Retirar da dispensa</b><span class="small muted">Bipe o que está usando</span></a>
      <a href="#/bipar/entrada"><span>🧺</span><b>Guardar compras</b><span class="small muted">Bipe o que chegou do mercado</span></a>
      <a href="#/compras"><span>🛒</span><b>Lista de compras</b><span class="small muted">${list.required.length} item(ns) para comprar</span></a>
      <a href="#/produto/novo"><span>➕</span><b>Cadastrar produto</b><span class="small muted">Com foto e código de barras</span></a>
    </div>
    <div class="stats">
      <div class="stat"><b>${products.length}</b><span>produtos</span></div>
      <div class="stat"><b>${fmt(totalItems)}</b><span>itens na dispensa</span></div>
      <div class="stat"><b style="color:${list.required.length ? 'var(--danger)' : 'inherit'}">${list.required.length}</b><span>abaixo do mínimo</span></div>
    </div>
    ${
      list.required.length
        ? `<h2>Acabando</h2><div class="card"><ul class="list">${list.required
            .slice(0, 6)
            .map(
              (r) => `<li class="item"><div class="info"><b>${esc(r.group.name)}</b><span class="small muted">Tem ${fmt(r.stock)} · mínimo ${fmt(r.min)}</span></div><span class="badge danger">comprar ${fmt(r.buy)}</span></li>`,
            )
            .join('')}</ul></div>`
        : ''
    }
    ${
      recent.length
        ? `<h2>Últimas movimentações</h2><div class="card log"><ul class="list">${recent.map(movementRow).join('')}</ul>
           <a href="#/historico" class="btn sm" style="margin-top:8px">Ver histórico</a></div>`
        : ''
    }
    ${
      !products.length
        ? `<div class="card"><b>Primeiros passos</b><ol class="small muted" style="padding-left:18px;margin:8px 0 0">
            <li>Cadastre os produtos que você costuma comprar (foto + código de barras).</li>
            <li>O app junta marcas diferentes do mesmo produto em um <b>grupo</b> (ex.: Creme de Leite).</li>
            <li>Defina o estoque mínimo e máximo de cada grupo.</li>
            <li>Ao usar um produto, bipe para dar saída. A lista de compras se monta sozinha.</li></ol></div>`
        : ''
    }
    ${
      (await db.all('users')).length < 2
        ? `<div class="card"><b>👥 Chame a família</b>
            <p class="small muted" style="margin:6px 0 10px">Envie o link de convite para cada pessoa abrir no próprio celular. Tudo fica sincronizado e o histórico mostra quem retirou e quem guardou.</p>
            <a class="btn sm primary" href="#/casa">Enviar link de convite</a></div>`
        : ''
    }
    <p class="center" style="margin-top:18px"><a href="#/mais" class="btn sm">⚙️ Casa, grupos, histórico e backup</a></p>`;
}

function who(m) {
  return m.userName ? `${m.userIcon || '👤'} ${m.userName}` : 'Sem usuário';
}

function movementRow(m) {
  const d = new Date(m.at);
  const when = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (m.type === 'log') {
    return `<li class="item"><div class="info"><b>${esc(m.text)}</b><span class="small muted">${esc(who(m))} · ${when}</span></div><span class="badge warn">📝</span></li>`;
  }
  const verb = m.type === 'in' ? 'guardou' : 'retirou';
  const sign = m.type === 'in' ? `<span class="badge">+${fmt(m.qty)}</span>` : `<span class="badge danger">−${fmt(m.qty)}</span>`;
  return `<li class="item"><div class="info"><b>${esc(m.productName)}</b><span class="small muted"><b class="who">${esc(who(m))}</b> ${verb} · ${when}</span></div>${sign}</li>`;
}

// ----- Estoque -----
async function estoque({ params }) {
  const { groups, products } = await loadAll();
  const filter = params.get('cat') || '';
  const cats = CATEGORIES.filter((c) => groups.some((g) => (g.category || 'Outros') === c));

  view.innerHTML = `
    <div class="input-btn" style="margin-bottom:12px">
      <input type="search" id="q" placeholder="Buscar produto, marca ou código…" autocomplete="off">
      <a href="#/produto/novo" class="btn primary">＋</a>
    </div>
    <div class="chips">
      <a class="chip ${filter ? '' : 'active'}" href="#/estoque">Todos</a>
      <a class="chip ${filter === '_comprar' ? 'active' : ''}" href="#/estoque?cat=_comprar">⚠️ Acabando</a>
      ${cats.map((c) => `<a class="chip ${filter === c ? 'active' : ''}" href="#/estoque?cat=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
    </div>
    <div id="groups"></div>
    <p class="center"><a href="#/grupos" class="btn sm">Gerenciar grupos e estoque mín./máx.</a></p>`;

  const render = () => {
    const q = $('#q').value.trim().toLowerCase();
    const html = groups
      .map((g) => {
        const items = products.filter((p) => p.groupId === g.id);
        const stock = groupStock(g.id, products);
        const status = stockStatus(stock, g);
        if (filter === '_comprar' && status !== 'comprar') return '';
        if (filter && filter !== '_comprar' && (g.category || 'Outros') !== filter) return '';
        const shown = q
          ? items.filter((p) => `${p.name} ${p.brand} ${p.barcode} ${g.name}`.toLowerCase().includes(q))
          : items;
        if (q && !shown.length && !g.name.toLowerCase().includes(q)) return '';
        const max = Math.max(Number(g.max) || 0, stock, 1);
        const badge =
          status === 'comprar' ? '<span class="badge danger">comprar</span>' : status === 'ok' ? '<span class="badge warn">ok</span>' : status === 'cheio' ? '<span class="badge">cheio</span>' : '';
        return `<details class="card status-${status}" ${q || filter === '_comprar' ? 'open' : ''}>
          <summary class="group-head">
            ${thumb(items.find((p) => p.photo))}
            <div class="info">
              <div class="row"><b>${esc(g.name)}</b>${badge}</div>
              <span class="small muted">${items.length} marca(s) · mín ${fmt(g.min || 0)} / máx ${fmt(g.max || 0)}</span>
              ${g.max ? `<div class="bar"><i style="width:${Math.min(100, (stock / max) * 100)}%"></i><span class="min-mark" style="left:${Math.min(100, ((g.min || 0) / max) * 100)}%"></span></div>` : ''}
            </div>
            <span class="qty">${fmt(stock)}</span>
          </summary>
          <ul class="list">
            ${(q ? shown : items)
              .map(
                (p) => `<li class="item">
                  <a href="#/produto/${p.id}">${thumb(p)}</a>
                  <a class="info" href="#/produto/${p.id}" style="color:inherit;text-decoration:none"><b>${esc(productLabel(p))}</b><span class="small muted">${esc(p.brand || '')}</span></a>
                  <button class="btn sm" data-move="out" data-id="${p.id}" aria-label="Retirar">−</button>
                  <span class="qty">${fmt(p.qty || 0)}</span>
                  <button class="btn sm" data-move="in" data-id="${p.id}" aria-label="Adicionar">＋</button>
                </li>`,
              )
              .join('')}
            <li class="item"><a class="btn sm" href="#/grupo/${g.id}">Editar grupo</a><a class="btn sm" href="#/produto/novo?group=${g.id}">＋ Outra marca</a></li>
          </ul>
        </details>`;
      })
      .join('');
    $('#groups').innerHTML =
      html ||
      `<div class="empty"><span>📦</span>${products.length ? 'Nada encontrado.' : 'Nenhum produto cadastrado ainda.'}<br><br><a href="#/produto/novo" class="btn primary">Cadastrar produto</a></div>`;
  };

  $('#q').addEventListener('input', render);
  $('#groups').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    e.preventDefault();
    const { product } = await db.move(b.dataset.id, b.dataset.move, 1);
    const p = products.find((x) => x.id === product.id);
    p.qty = product.qty;
    b.parentElement.querySelector('.qty').textContent = fmt(product.qty);
    const det = b.closest('details');
    const g = groups.find((x) => x.id === p.groupId);
    const total = groupStock(g.id, products);
    det.querySelector('summary .qty').textContent = fmt(total);
  });
  render();
}

// ----- Detalhe do produto -----
async function productDetail({ args }) {
  const p = await db.get('products', args[0]);
  if (!p) throw new Error('Produto não encontrado');
  const g = await db.get('groups', p.groupId);
  const movs = (await db.all('movements')).filter((m) => m.productId === p.id).sort((a, b) => b.at - a.at);
  titleEl.textContent = p.name;
  view.innerHTML = `
    <div class="card center">
      ${p.photo ? `<img src="${esc(p.photo)}" alt="" style="max-width:220px;width:100%;border-radius:12px">` : '<div style="font-size:4rem">🥫</div>'}
      <h2 style="margin:10px 0 2px">${esc(productLabel(p))}</h2>
      <p class="muted">${esc(p.brand || 'Sem marca')}${p.barcode ? ` · <code>${esc(p.barcode)}</code>` : ''}</p>
      <p>Grupo: <a href="#/grupo/${g?.id}">${esc(g?.name || '—')}</a></p>
      <div class="row" style="justify-content:center">
        <button class="btn" data-move="out">− Retirar</button>
        <span class="qty" id="qty" style="font-size:1.6rem;min-width:3ch">${fmt(p.qty || 0)}</span>
        <button class="btn" data-move="in">＋ Adicionar</button>
      </div>
    </div>
    <div class="row"><a class="btn block" href="#/produto/${p.id}/editar">✏️ Editar</a><button class="btn danger block" id="del">🗑️ Excluir</button></div>
    <h2>Movimentações</h2>
    <div class="card log">${movs.length ? `<ul class="list">${movs.slice(0, 30).map(movementRow).join('')}</ul>` : '<p class="muted">Nenhuma ainda.</p>'}</div>`;

  $$('[data-move]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { product } = await db.move(p.id, b.dataset.move, 1);
      $('#qty').textContent = fmt(product.qty);
    }),
  );
  $('#del').onclick = async () => {
    if (!confirm(`Excluir "${p.name}"? O histórico de consumo é mantido no relatório.`)) return;
    await db.remove('products', p.id);
    await db.log('product-delete', `excluiu o produto ${p.name}`, { productId: p.id });
    toast('Produto excluído');
    go('#/estoque');
  };
}

// ----- Cadastro/edição de produto -----
async function productForm({ args, params }) {
  const { groups, products } = await loadAll();
  const editing = args[0] ? await db.get('products', args[0]) : null;
  const fromEntrada = params.get('from') === 'entrada';
  const p = editing || { barcode: params.get('barcode') || '', name: '', brand: '', size: '', photo: null, groupId: params.get('group') || '' };
  let photo = p.photo;
  let groupTouched = Boolean(p.groupId);

  view.innerHTML = `
    <form id="f" class="card" autocomplete="off">
      <div class="photo-pick">
        <span id="photo-prev">${thumb({ photo })}</span>
        <div>
          <div class="row wrap" style="gap:6px">
            <label class="btn sm" for="photo" style="margin:0;color:var(--text)">📸 ${photo ? 'Nova foto' : 'Tirar foto'}</label>
            <label class="btn sm" for="photo-gallery" style="margin:0;color:var(--text)">🖼️ Galeria</label>
          </div>
          <input type="file" id="photo" accept="image/*" capture="environment" hidden>
          <input type="file" id="photo-gallery" accept="image/*" hidden>
          ${photo ? '<button type="button" class="btn sm" id="photo-clear" style="margin-top:6px">Remover</button>' : ''}
        </div>
      </div>

      <label for="barcode">Código de barras</label>
      <div class="input-btn">
        <input id="barcode" inputmode="numeric" value="${esc(p.barcode)}" placeholder="Bipe ou digite">
        <button type="button" class="btn" id="scan-btn" aria-label="Ler com a câmera">📷</button>
      </div>
      <div id="scan-area"></div>
      <div id="lookup" class="small muted"></div>

      <label for="name">Nome do produto *</label>
      <input id="name" required value="${esc(p.name)}" placeholder="Ex.: Creme de Leite 200g">
      <div class="grid2">
        <div><label for="brand">Marca</label><input id="brand" value="${esc(p.brand)}" placeholder="Ex.: Nestlé"></div>
        <div><label for="size">Tamanho</label><input id="size" value="${esc(p.size)}" placeholder="Ex.: 200g"></div>
      </div>

      <label for="group">Grupo (produtos equivalentes)</label>
      <select id="group">
        <option value="">— Criar novo grupo —</option>
        ${groups.map((g) => `<option value="${g.id}" ${g.id === p.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>
      <div id="suggest" class="suggest" hidden></div>
      <div id="new-group">
        <label for="group-name">Nome do novo grupo</label>
        <input id="group-name" placeholder="Ex.: Creme de Leite">
        <div class="grid2">
          <div><label for="min">Estoque mínimo</label><input id="min" type="number" min="0" step="1" inputmode="numeric" value="1"></div>
          <div><label for="max">Estoque máximo</label><input id="max" type="number" min="0" step="1" inputmode="numeric" value="3"></div>
        </div>
        <label for="category">Seção do mercado</label>
        <select id="category">${CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      </div>

      ${
        editing
          ? ''
          : `<label for="qty">Quantidade que tem em casa agora</label><input id="qty" type="number" min="0" step="1" inputmode="numeric" value="${fromEntrada ? Math.max(1, Number(params.get('qty')) || 1) : 0}">`
      }
      <button class="btn primary block" style="margin-top:16px" type="submit">Salvar</button>
    </form>`;

  const el = (id) => $('#' + id);
  const showNewGroup = () => (el('new-group').hidden = Boolean(el('group').value));

  const refreshSuggestion = () => {
    const name = el('name').value.trim();
    const box = el('suggest');
    if (!name) {
      box.hidden = true;
      return;
    }
    const others = products.filter((x) => x.id !== p.id);
    const s = suggestGroup({ name, brand: el('brand').value }, groups, others);
    if (s.group) {
      box.hidden = false;
      box.innerHTML = `🔗 Parece com <b>${esc(s.group.name)}</b> (${Math.round(s.score * 100)}% parecido). ${
        others.filter((x) => x.groupId === s.group.id).length
          ? `Já tem: ${others.filter((x) => x.groupId === s.group.id).map((x) => esc(x.brand || x.name)).join(', ')}.`
          : ''
      }`;
      if (!groupTouched) el('group').value = s.group.id;
    } else {
      box.hidden = false;
      box.innerHTML = `✨ Produto novo: será criado o grupo <b>${esc(s.newName || name)}</b>.`;
      if (!groupTouched) el('group').value = '';
      if (!el('group-name').dataset.touched) {
        el('group-name').value = s.newName || name;
        el('category').value = guessCategory(s.newName || name);
      }
    }
    showNewGroup();
  };

  let lookedUp = '';
  const tryLookup = async () => {
    const code = el('barcode').value.trim();
    if (!code || code === lookedUp || editing) return;
    lookedUp = code;
    const existing = await db.findProductByBarcode(code);
    if (existing) {
      el('lookup').innerHTML = `⚠️ Este código já está cadastrado: <a href="#/produto/${existing.id}">${esc(existing.name)}</a>`;
      return;
    }
    el('lookup').textContent = '🔎 Buscando dados do produto…';
    const info = await lookupBarcode(code);
    if (!info) {
      el('lookup').textContent = '';
      return;
    }
    el('lookup').textContent = '✅ Dados preenchidos pela base Open Food Facts. Confira!';
    if (!el('name').value && info.name) el('name').value = info.name;
    if (!el('brand').value && info.brand) el('brand').value = info.brand;
    if (!el('size').value && info.size) el('size').value = info.size;
    if (!photo && info.photo) {
      photo = info.photo;
      el('photo-prev').innerHTML = thumb({ photo });
    }
    refreshSuggestion();
  };

  // Câmera (capture) ou galeria: o mesmo tratamento para os dois.
  const onPhoto = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      photo = await resizeImage(file);
      el('photo-prev').innerHTML = thumb({ photo });
    } catch (err) {
      toast(err.message);
    }
  };
  el('photo').addEventListener('change', onPhoto);
  el('photo-gallery').addEventListener('change', onPhoto);
  view.addEventListener('click', (e) => {
    if (e.target.id !== 'photo-clear') return;
    photo = null;
    el('photo-prev').innerHTML = thumb({});
    e.target.remove();
  });

  let stopScan = null;
  const closeScan = () => {
    if (stopScan) stopScan();
    stopScan = null;
    el('scan-area').innerHTML = '';
  };
  cleanup = closeScan;
  el('scan-btn').onclick = async () => {
    if (stopScan) return closeScan();
    el('scan-area').innerHTML = '<div class="scanner" style="margin-top:8px"><video></video><div class="frame"></div></div>';
    const area = el('scan-area');
    try {
      const stopFn = await startScanner($('#scan-area video'), (code) => {
        beep(true);
        el('barcode').value = code;
        closeScan();
        tryLookup();
      });
      if (!document.contains(area)) return stopFn();
      stopScan = stopFn;
    } catch (err) {
      el('scan-area').innerHTML = `<p class="small" style="color:var(--danger)">${esc(err.message)}</p>`;
    }
  };

  el('barcode').addEventListener('change', tryLookup);
  el('barcode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tryLookup();
      el('name').focus();
    }
  });
  let t = null;
  ['name', 'brand'].forEach((id) =>
    el(id).addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(refreshSuggestion, 250);
    }),
  );
  el('group').addEventListener('change', () => {
    groupTouched = true;
    showNewGroup();
  });
  el('group-name').addEventListener('input', () => {
    el('group-name').dataset.touched = '1';
    el('category').value = guessCategory(el('group-name').value);
  });

  showNewGroup();
  if (!editing && p.barcode) tryLookup();
  if (editing || p.groupId) {
    el('suggest').hidden = true;
  } else if (p.name) refreshSuggestion();

  el('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const barcode = el('barcode').value.trim();
    if (barcode) {
      const dup = await db.findProductByBarcode(barcode);
      if (dup && dup.id !== p.id) return toast(`Código já usado em "${dup.name}"`);
    }
    let groupId = el('group').value;
    if (!groupId) {
      const name = el('group-name').value.trim() || el('name').value.trim();
      const existing = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
      if (existing) groupId = existing.id;
      else {
        const min = Number(el('min').value) || 0;
        const g = await db.put('groups', {
          id: db.uid(),
          name,
          category: el('category').value,
          min,
          max: Math.max(Number(el('max').value) || 0, min),
          createdAt: Date.now(),
        });
        groupId = g.id;
        await db.log('group-create', `criou o grupo ${g.name}`);
      }
    }
    const saved = await db.put('products', {
      ...p,
      id: p.id || db.uid(),
      barcode,
      name: el('name').value.trim(),
      brand: el('brand').value.trim(),
      size: el('size').value.trim(),
      photo,
      groupId,
      qty: p.qty || 0,
      createdAt: p.createdAt || Date.now(),
    });
    const initial = editing ? 0 : Number(el('qty').value) || 0;
    if (initial > 0) await db.move(saved.id, 'in', initial);
    await db.log(editing ? 'product-edit' : 'product-create', `${editing ? 'editou' : 'cadastrou'} o produto ${saved.name}`, { productId: saved.id });
    toast(editing ? 'Produto atualizado' : 'Produto cadastrado');
    if (fromEntrada) go('#/bipar/entrada');
    else if (editing) history.back();
    else go(`#/produto/${saved.id}`);
  });
}

// ----- Grupos -----
async function grupos() {
  const { groups, products } = await loadAll();
  view.innerHTML = `
    <p class="muted small">Grupos juntam produtos equivalentes de marcas diferentes. O estoque mínimo e máximo vale para o grupo inteiro.</p>
    <div class="card"><ul class="list">
      ${
        groups
          .map((g) => {
            const n = products.filter((p) => p.groupId === g.id).length;
            return `<li><a class="item" href="#/grupo/${g.id}"><div class="info"><b>${esc(g.name)}</b>
              <span class="small muted">${esc(g.category || 'Outros')} · ${n} produto(s) · mín ${fmt(g.min || 0)} / máx ${fmt(g.max || 0)}</span></div>
              <span class="qty">${fmt(groupStock(g.id, products))}</span></a></li>`;
          })
          .join('') || '<li class="empty">Nenhum grupo ainda.</li>'
      }
    </ul></div>
    <a class="btn block" href="#/grupo/novo">＋ Novo grupo</a>`;
}

async function grupoForm({ args }) {
  const { groups, products } = await loadAll();
  const isNew = args[0] === 'novo';
  const g = isNew ? { id: db.uid(), name: '', category: 'Outros', min: 1, max: 3 } : groups.find((x) => x.id === args[0]);
  if (!g) throw new Error('Grupo não encontrado');
  const items = products.filter((p) => p.groupId === g.id);
  titleEl.textContent = isNew ? 'Novo grupo' : g.name;

  view.innerHTML = `
    <form id="f" class="card">
      <label for="name">Nome do grupo</label>
      <input id="name" required value="${esc(g.name)}" placeholder="Ex.: Creme de Leite">
      <label for="category">Seção do mercado</label>
      <select id="category">${CATEGORIES.map((c) => `<option ${c === g.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <div class="grid2">
        <div><label for="min">Estoque mínimo</label><input id="min" type="number" min="0" step="1" inputmode="numeric" value="${g.min ?? 0}"></div>
        <div><label for="max">Estoque máximo</label><input id="max" type="number" min="0" step="1" inputmode="numeric" value="${g.max ?? 0}"></div>
      </div>
      <p class="small muted" style="margin-top:8px">Quando o total do grupo ficar igual ou abaixo do mínimo, ele entra na lista de compras com a quantidade para chegar ao máximo.</p>
      <button class="btn primary block" type="submit">Salvar</button>
    </form>
    ${
      isNew
        ? ''
        : `<h2>Produtos neste grupo (${items.length})</h2>
      <div class="card"><ul class="list">${
        items.map((p) => `<li><a class="item" href="#/produto/${p.id}">${thumb(p)}<div class="info"><b>${esc(productLabel(p))}</b><span class="small muted">${esc(p.brand)}</span></div><span class="qty">${fmt(p.qty || 0)}</span></a></li>`).join('') ||
        '<li class="muted">Nenhum produto.</li>'
      }</ul></div>
      ${
        groups.length > 1
          ? `<h2>Juntar com outro grupo</h2>
        <div class="card"><p class="small muted">Use quando dois grupos são o mesmo produto. Os produtos deste grupo passam para o escolhido e este grupo é apagado.</p>
        <div class="input-btn"><select id="merge-into">${groups.filter((x) => x.id !== g.id).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
        <button class="btn" id="merge">Juntar</button></div></div>`
          : ''
      }
      <button class="btn danger block" id="del" style="margin-top:12px" ${items.length ? 'disabled title="Mova ou exclua os produtos antes"' : ''}>Excluir grupo</button>`
    }`;

  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const min = Number($('#min').value) || 0;
    await db.put('groups', { ...g, name: $('#name').value.trim(), category: $('#category').value, min, max: Math.max(Number($('#max').value) || 0, min) });
    await db.log(isNew ? 'group-create' : 'group-edit', `${isNew ? 'criou' : 'editou'} o grupo ${$('#name').value.trim()} (mín ${min} / máx ${Math.max(Number($('#max').value) || 0, min)})`);
    toast('Grupo salvo');
    history.back();
  });
  $('#merge')?.addEventListener('click', async () => {
    const target = groups.find((x) => x.id === $('#merge-into').value);
    if (!confirm(`Mover ${items.length} produto(s) para "${target.name}" e apagar "${g.name}"?`)) return;
    for (const p of items) await db.put('products', { ...p, groupId: target.id });
    await db.remove('groups', g.id);
    await db.log('group-merge', `juntou o grupo ${g.name} com ${target.name}`);
    toast('Grupos unidos');
    go(`#/grupo/${target.id}`);
  });
  $('#del')?.addEventListener('click', async () => {
    if (!confirm(`Excluir o grupo "${g.name}"?`)) return;
    await db.remove('groups', g.id);
    await db.log('group-delete', `excluiu o grupo ${g.name}`);
    go('#/grupos');
  });
}

// ----- Bipar (saída/entrada) -----
async function bipar({ args }) {
  const mode = args[0];
  const out = mode === 'saida';
  const session = [];

  view.innerHTML = `
    <div class="segmented">
      <a href="#/bipar/saida" class="${out ? 'active out' : ''}">➖ Retirar</a>
      <a href="#/bipar/entrada" class="${out ? '' : 'active in'}">➕ Guardar</a>
    </div>
    ${
      out
        ? ''
        : `<div class="card qty-picker">
      <label for="bip-qty" style="margin-top:0">Quantidade a guardar no próximo bipe</label>
      <div class="row">
        <button type="button" class="btn" data-step="-1" aria-label="Diminuir">−</button>
        <input id="bip-qty" type="number" min="1" step="1" inputmode="numeric" value="1">
        <button type="button" class="btn" data-step="1" aria-label="Aumentar">＋</button>
      </div>
      <div class="chips" style="margin:8px 0 0">${[2, 3, 4, 6, 12].map((n) => `<button type="button" class="chip" data-qty="${n}">${n}</button>`).join('')}</div>
    </div>`
    }
    <div class="scanner" id="scanner"><video></video><div class="frame"></div><div class="msg" id="cam-msg">Abrindo câmera…</div></div>
    <form id="manual" class="input-btn">
      <input id="code" inputmode="numeric" placeholder="Ou digite / use leitor USB e Enter" autocomplete="off">
      <button class="btn" type="submit">OK</button>
    </form>
    <p class="small muted" style="margin-top:6px">${
      out
        ? 'Cada bipe tira 1 unidade do estoque.'
        : 'Escolha a quantidade e bipe o produto uma vez só. Depois do bipe a quantidade volta para 1. Produto desconhecido abre o cadastro.'
    }</p>
    <h2>Nesta sessão</h2>
    <div class="card log"><ul class="list" id="session"><li class="muted">Nenhum produto bipado ainda.</li></ul></div>`;

  const scannerEl = $('#scanner');
  const flash = (ok) => {
    scannerEl.classList.remove('flash-ok', 'flash-err');
    void scannerEl.offsetWidth;
    scannerEl.classList.add(ok ? 'flash-ok' : 'flash-err');
    setTimeout(() => scannerEl.classList.remove('flash-ok', 'flash-err'), 400);
  };

  const renderSession = () => {
    $('#session').innerHTML = session.length
      ? session
          .map(
            (s, i) => `<li class="item">${thumb(s.product)}<div class="info"><b>${esc(productLabel(s.product))}</b>
              <span class="small muted">${esc(s.product.brand || '')} · agora tem ${fmt(s.product.qty)}${s.warning ? ` · ${esc(s.warning)}` : ''}</span></div>
              <span class="badge ${out ? 'danger' : ''}">${out ? '−' : '+'}${fmt(s.movement.qty)}</span>
              <button class="btn sm" data-undo="${i}">Desfazer</button></li>`,
          )
          .join('')
      : '<li class="muted">Nenhum produto bipado ainda.</li>';
  };

  $('#session').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-undo]');
    if (!b) return;
    const [s] = session.splice(Number(b.dataset.undo), 1);
    await db.undo(s.movement.id);
    toast('Desfeito');
    renderSession();
  });

  // Quantidade por bipe (só na entrada): evita bipar várias vezes o mesmo item.
  const qtyInput = $('#bip-qty');
  const getQty = () => (qtyInput ? Math.max(1, Math.floor(Number(qtyInput.value)) || 1) : 1);
  const setQty = (n) => qtyInput && (qtyInput.value = Math.max(1, n));
  $('.qty-picker')?.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    const pick = e.target.closest('[data-qty]');
    if (step) setQty(getQty() + Number(step.dataset.step));
    if (pick) setQty(Number(pick.dataset.qty));
  });

  let stop = null;
  let busy = false;
  const handle = async (code) => {
    code = String(code).trim();
    if (!code || busy) return;
    busy = true;
    try {
      const product = await db.findProductByBarcode(code);
      if (!product) {
        beep(false);
        flash(false);
        if (out) {
          toast(`Código ${code} não cadastrado`, { label: 'Cadastrar', run: () => go(`#/produto/novo?barcode=${encodeURIComponent(code)}`) });
        } else {
          toast('Produto novo! Vamos cadastrar.');
          go(`#/produto/novo?barcode=${encodeURIComponent(code)}&from=entrada&qty=${getQty()}`);
        }
        return;
      }
      let warning = '';
      if (out && !(Number(product.qty) > 0)) warning = 'estoque já estava zerado';
      const qty = out ? 1 : getQty();
      const res = await db.move(product.id, out ? 'out' : 'in', qty);
      setQty(1);
      beep(true);
      flash(true);
      session.unshift({ ...res, warning });
      renderSession();
      const group = await db.get('groups', product.groupId);
      if (out && group) {
        const total = groupStock(group.id, await db.all('products'));
        if (stockStatus(total, group) === 'comprar') toast(`${group.name}: restam ${fmt(total)}. Foi para a lista de compras 🛒`);
        else toast(`−1 ${product.name}`);
      } else toast(`${out ? '−' : '+'}${fmt(qty)} ${product.name}`);
    } finally {
      busy = false;
    }
  };

  $('#manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#code').value;
    $('#code').value = '';
    handle(v);
  });

  cleanup = () => stop && stop();
  const camMsg = $('#cam-msg');
  // Não espera a câmera (o pedido de permissão pode demorar) para liberar a navegação.
  startScanner($('#scanner video'), handle).then(
    (s) => {
      // Se o usuário saiu da tela enquanto a câmera abria, desliga.
      if (!document.contains(scannerEl)) return s();
      stop = s;
      camMsg.remove();
    },
    (err) => {
      camMsg.textContent = `📷 ${err.name === 'NotAllowedError' ? 'Permita o acesso à câmera para bipar.' : err.message} Você ainda pode digitar o código abaixo.`;
    },
  );
}

// ----- Lista de compras -----
async function compras() {
  const { groups, products } = await loadAll();
  const list = shoppingList(groups, products);
  const checked = await db.getMeta('shopChecked', {});

  const section = (items, optional) => {
    let lastCat = null;
    return items
      .map((r) => {
        const cat = r.group.category || 'Outros';
        const head = cat !== lastCat ? `<div class="cat-title">${esc(cat)}</div>` : '';
        lastCat = cat;
        const brands = [...new Set(r.products.map((p) => p.brand).filter(Boolean))];
        return `${head}<label class="shop-item ${checked[r.group.id] ? 'done' : ''}" style="margin:0;color:inherit;font-weight:400">
          <input type="checkbox" data-g="${r.group.id}" ${checked[r.group.id] ? 'checked' : ''}>
          ${thumb(r.preferred)}
          <div class="info"><b>${esc(r.group.name)}</b>
            <span class="small muted">Tem ${fmt(r.stock)} · mín ${fmt(r.min)} · máx ${fmt(r.max)}${brands.length ? `<br>Marcas: ${esc(brands.join(', '))}` : ''}</span></div>
          <span class="buy">${optional ? 'até ' : ''}${fmt(r.buy)} un</span>
        </label>`;
      })
      .join('');
  };

  view.innerHTML = list.required.length || list.optional.length
    ? `
    ${
      list.required.length
        ? `<div class="card"><div class="row"><b>Precisa comprar</b><span class="spacer"></span><span class="badge danger">${list.required.length}</span></div>${section(list.required, false)}</div>`
        : '<div class="card"><b>✅ Nada abaixo do mínimo.</b><p class="small muted">Tudo certo na dispensa.</p></div>'
    }
    ${
      list.optional.length
        ? `<details class="card"><summary>Pode completar até o máximo (${list.optional.length})</summary>${section(list.optional, true)}</details>`
        : ''
    }
    <div class="row wrap">
      <button class="btn primary" id="share">📤 Compartilhar lista</button>
      <a class="btn" href="#/bipar/entrada">🧺 Guardar compras</a>
      <button class="btn" id="clear">Limpar marcações</button>
    </div>`
    : `<div class="empty"><span>🛒</span>Nenhuma sugestão de compra.<br><span class="small" style="display:inline;font-size:.85rem">Defina estoque mínimo e máximo nos grupos para receber sugestões.</span><br><br><a class="btn" href="#/grupos">Configurar grupos</a></div>`;

  view.addEventListener('change', async (e) => {
    const id = e.target.dataset?.g;
    if (!id) return;
    if (e.target.checked) checked[id] = true;
    else delete checked[id];
    e.target.closest('.shop-item').classList.toggle('done', e.target.checked);
    await db.setMeta('shopChecked', checked);
  });
  $('#clear')?.addEventListener('click', async () => {
    await db.setMeta('shopChecked', {});
    navigate();
  });
  $('#share')?.addEventListener('click', async () => {
    const lines = ['🛒 *Lista de compras*', ''];
    let lastCat = null;
    for (const r of list.required) {
      const cat = r.group.category || 'Outros';
      if (cat !== lastCat) lines.push(`*${cat}*`);
      lastCat = cat;
      lines.push(`${checked[r.group.id] ? '✅' : '▫️'} ${r.group.name} — ${fmt(r.buy)} un${r.preferred?.brand ? ` (${r.preferred.brand})` : ''}`);
    }
    if (list.optional.length) {
      lines.push('', '_Se der:_');
      for (const r of list.optional) lines.push(`▫️ ${r.group.name} — até ${fmt(r.buy)} un`);
    }
    const text = lines.join('\n');
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Lista de compras', text });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Lista copiada!', { label: 'WhatsApp', run: () => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`) });
    } catch {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`);
    }
  });
}

// ----- Relatório mensal -----
async function relatorio({ params }) {
  const months = Number(params.get('m')) || 6;
  const type = params.get('t') === 'in' ? 'in' : 'out';
  const [{ groups, products }, movements] = await Promise.all([loadAll(), db.all('movements')]);
  const rep = consumptionReport(movements, products, groups, { months, type });
  const verb = type === 'out' ? 'usado' : 'comprado';
  const link = (m, t) => `#/relatorio?m=${m}&t=${t}`;
  const last = rep.months.length - 1;

  const varTag = (cur, prev) => {
    const v = variation(cur, prev);
    if (v === null) return '<span class="var flat">novo</span>';
    if (v === 0) return '<span class="var flat">=</span>';
    return `<span class="var ${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲' : '▼'} ${Math.abs(v)}%</span>`;
  };

  const maxTotal = Math.max(1, ...rep.totals);
  const closedTotal = rep.totals[last - 1] || 0;
  const prevClosed = rep.totals[last - 2] || 0;

  view.innerHTML = `
    <div class="segmented">
      <a href="${link(months, 'out')}" class="${type === 'out' ? 'active out' : ''}">Consumo</a>
      <a href="${link(months, 'in')}" class="${type === 'in' ? 'active in' : ''}">Compras</a>
    </div>
    <div class="chips">${[3, 6, 12].map((m) => `<a class="chip ${m === months ? 'active' : ''}" href="${link(m, type)}">${m} meses</a>`).join('')}</div>
    ${
      !rep.rows.length
        ? `<div class="empty"><span>📊</span>Ainda não há movimentações neste período.<br><span class="small">O relatório é montado com os produtos bipados na ${type === 'out' ? 'saída' : 'entrada'}.</span></div>`
        : `
    <div class="card">
      <b>Total de itens ${verb}s por mês</b>
      <div class="chart">${rep.totals
        .map(
          (t, i) => `<div class="col ${i === last ? 'partial' : ''}"><b>${fmt(t)}</b><i style="height:${(t / maxTotal) * 100}%"></i><span>${monthLabel(rep.months[i])}${i === last ? '*' : ''}</span></div>`,
        )
        .join('')}</div>
      <p class="small muted" style="margin-top:8px">${monthLabel(rep.months[last - 1])}: ${fmt(closedTotal)} itens ${
        prevClosed ? `(${varTag(closedTotal, prevClosed).replace(/<[^>]+>/g, '')} vs ${monthLabel(rep.months[last - 2])})` : ''
      } · * mês atual, ainda em andamento.</p>
    </div>
    <div class="card">
      <b>Quanto foi ${verb} de cada produto</b>
      <p class="small muted">Toque em um grupo para ver por marca. ▲ ${type === 'out' ? 'usou mais' : 'comprou mais'} que no mês anterior, ▼ menos.</p>
      <div class="table-wrap"><table class="report">
        <thead><tr><th>Produto</th>${rep.months.map((m, i) => `<th>${monthLabel(m)}${i === last ? '*' : ''}</th>`).join('')}<th>Média/mês</th><th>Estoque dura</th></tr></thead>
        <tbody>${rep.rows
          .map((r) => {
            const stock = groupStock(r.group.id, products);
            const lasts = type === 'out' && r.avg > 0 ? `${fmt((stock / r.avg) * 4.3)} sem.` : '—';
            const sub = r.products
              .map((p) => `<tr class="sub" data-parent="${esc(r.group.id)}" hidden><td>${esc(p.brand || p.name)}</td>${p.perMonth.map((q) => `<td>${q ? fmt(q) : '·'}</td>`).join('')}<td></td><td></td></tr>`)
              .join('');
            return `<tr class="clickable" data-toggle="${esc(r.group.id)}"><td><b>${esc(r.group.name)}</b>${r.products.length > 1 ? ` <span class="small muted">(${r.products.length})</span>` : ''}</td>
              ${r.perMonth.map((q, i) => `<td>${q ? fmt(q) : '·'}${i > 0 && (q || r.perMonth[i - 1]) ? varTag(q, r.perMonth[i - 1]) : ''}</td>`).join('')}
              <td><b>${fmt(r.avg)}</b></td><td>${lasts}</td></tr>${sub}`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="small muted" style="margin-top:8px">Média calculada só com os meses já fechados. "Estoque dura" usa o estoque atual e a média de consumo.</p>
    </div>
    ${type === 'out' ? suggestionsCard(rep, groups) : ''}
    <button class="btn" id="csv">⬇️ Exportar planilha (CSV)</button>`
    }`;

  view.addEventListener('click', (e) => {
    const tr = e.target.closest('[data-toggle]');
    if (!tr) return;
    $$(`tr[data-parent="${CSS.escape(tr.dataset.toggle)}"]`).forEach((s) => (s.hidden = !s.hidden));
  });
  $('#csv')?.addEventListener('click', () => {
    const rows = [['Grupo', 'Produto', ...rep.months, 'Media mensal']];
    for (const r of rep.rows) {
      rows.push([r.group.name, '(total)', ...r.perMonth, r.avg]);
      for (const p of r.products) rows.push([r.group.name, `${p.name} ${p.brand}`.trim(), ...p.perMonth, '']);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    download(`relatorio-${type === 'out' ? 'consumo' : 'compras'}.csv`, '﻿' + csv, 'text/csv');
  });
}

// Sugere ajustar mínimo/máximo com base no consumo médio (mínimo ≈ 1 semana, máximo ≈ 1 mês).
function suggestionsCard(rep, groups) {
  const tips = rep.rows
    .filter((r) => r.avg > 0 && groups.some((g) => g.id === r.group.id))
    .map((r) => {
      const g = groups.find((x) => x.id === r.group.id);
      const min = Math.max(1, Math.ceil(r.avg / 4.3));
      const max = Math.max(min + 1, Math.ceil(r.avg));
      return { g, min, max };
    })
    .filter(({ g, min, max }) => Number(g.min) !== min || Number(g.max) !== max)
    .slice(0, 8);
  if (!tips.length) return '';
  return `<details class="card"><summary>💡 Sugestões de estoque mínimo/máximo (${tips.length})</summary>
    <p class="small muted">Baseado no seu consumo médio: mínimo para ~1 semana, máximo para ~1 mês.</p>
    <ul class="list">${tips
      .map(
        ({ g, min, max }) => `<li class="item"><div class="info"><b>${esc(g.name)}</b><span class="small muted">Atual: ${fmt(g.min || 0)}/${fmt(g.max || 0)} → sugerido: ${min}/${max}</span></div>
        <a class="btn sm" href="#/grupo/${g.id}">Ajustar</a></li>`,
      )
      .join('')}</ul></details>`;
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ----- Mais / backup -----
async function mais() {
  const localData = await readLocalData();
  const lookup = pref('lookupOnline', true);
  view.innerHTML = `
    <div class="card"><ul class="list">
      <li><a class="item" href="#/casa"><div class="info"><b>🏡 ${esc(db.household()?.name || 'Casa')} e pessoas</b><span class="small muted">Link de convite e pessoas</span></div>›</a></li>
      <li><a class="item" href="#/grupos"><div class="info"><b>🗂️ Grupos de produtos</b><span class="small muted">Similaridade, estoque mínimo e máximo</span></div>›</a></li>
      <li><a class="item" href="#/historico"><div class="info"><b>🕒 Histórico</b><span class="small muted">Quem retirou, quem guardou e outras ações</span></div>›</a></li>
    </ul></div>
    <div class="card">
      <label class="row" style="margin:0;color:var(--text);font-size:1rem">
        <input type="checkbox" id="lookup" ${lookup ? 'checked' : ''} style="width:22px;min-height:0">
        <span>Buscar nome e foto pelo código de barras na internet (Open Food Facts)</span>
      </label>
    </div>
    <h2>Backup</h2>
    <div class="card">
      <p class="small muted">Os dados ficam no banco de dados (Neon) e sincronizam entre os celulares da casa. O backup gera uma cópia em arquivo, por segurança.</p>
      <p class="small" id="sync-status">${syncText()}</p>
      <div class="row wrap">
        <button class="btn" id="export">⬇️ Exportar backup</button>
        <label class="btn" for="import" style="margin:0;color:var(--text);font-size:1rem">⬆️ Restaurar backup</label>
        <input type="file" id="import" accept="application/json,.json" hidden>
      </div>
    </div>
    ${localData ? `<div class="card"><b>📲 Dados antigos neste aparelho</b><p class="small muted" style="margin:6px 0 10px">Encontramos ${localData.products.length} produto(s) e ${localData.movements.length} movimentação(ões) salvos só neste celular, de antes da nuvem.</p><button class="btn" id="migrate">Enviar para a casa</button></div>` : ''}
    <p class="small muted center">Dispensa · sincronizado na nuvem, funciona offline</p>`;

  $('#migrate')?.addEventListener('click', async (e) => {
    if (!confirm('Enviar os produtos, grupos e histórico deste aparelho para a casa? Nada que já está na nuvem será apagado.')) return;
    e.target.disabled = true;
    try {
      await db.importAll(localData, { replace: false });
      await clearLocalData();
      await db.log('migrate', `enviou para a nuvem os dados antigos do aparelho (${localData.products.length} produtos)`);
      toast('Dados enviados para a nuvem');
      go('#/estoque');
    } catch (err) {
      e.target.disabled = false;
      toast(err.message);
    }
  });

  $('#lookup').onchange = (e) => setPref('lookupOnline', e.target.checked);
  $('#export').onclick = async () => {
    const data = await db.exportAll();
    download(`dispensa-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Restaurar o backup vai substituir todos os dados atuais. Continuar?')) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      await db.log('backup-restore', 'restaurou um backup');
      toast('Backup restaurado');
      go('#/');
    } catch (err) {
      toast(err.message);
    }
  };
}

async function historico({ params }) {
  const [all, users] = await Promise.all([db.all('movements'), db.all('users')]);
  const fUser = params.get('u') || '';
  const fType = params.get('t') || '';
  const link = (u, t) => `#/historico?u=${encodeURIComponent(u)}&t=${t}`;
  const movs = all
    .filter((m) => !fUser || (fUser === '_' ? !m.userId : m.userId === fUser))
    .filter((m) => !fType || m.type === fType)
    .sort((a, b) => b.at - a.at);

  // Resumo do mês atual por pessoa.
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const summary = new Map();
  for (const m of all) {
    if (m.at < start.getTime() || m.type === 'log') continue;
    const key = m.userId || '_';
    if (!summary.has(key)) summary.set(key, { label: who(m), out: 0, in: 0 });
    summary.get(key)[m.type] += Number(m.qty) || 0;
  }
  const hasAnon = all.some((m) => !m.userId);
  const types = [['', 'Tudo'], ['out', '➖ Retiradas'], ['in', '➕ Entradas'], ['log', '📝 Outras ações']];

  view.innerHTML = `
    ${
      summary.size
        ? `<div class="card"><b>Este mês</b><ul class="list">${[...summary.values()]
            .sort((a, b) => b.out + b.in - (a.out + a.in))
            .map((s) => `<li class="item"><div class="info"><b>${esc(s.label)}</b></div><span class="badge danger">retirou ${fmt(s.out)}</span><span class="badge">guardou ${fmt(s.in)}</span></li>`)
            .join('')}</ul></div>`
        : ''
    }
    <div class="chips">
      <a class="chip ${fUser ? '' : 'active'}" href="${link('', fType)}">Todos</a>
      ${users.sort(byName).map((u) => `<a class="chip ${fUser === u.id ? 'active' : ''}" href="${link(u.id, fType)}">${esc(u.icon)} ${esc(u.name)}</a>`).join('')}
      ${hasAnon ? `<a class="chip ${fUser === '_' ? 'active' : ''}" href="${link('_', fType)}">Sem usuário</a>` : ''}
    </div>
    <div class="chips">${types.map(([t, l]) => `<a class="chip ${fType === t ? 'active' : ''}" href="${link(fUser, t)}">${l}</a>`).join('')}</div>
    ${
      movs.length
        ? `<div class="card log"><ul class="list">${movs.slice(0, 300).map(movementRow).join('')}</ul></div>
           ${movs.length > 300 ? `<p class="small muted center">Mostrando as 300 mais recentes de ${movs.length}.</p>` : ''}`
        : '<div class="empty"><span>🕒</span>Nada registrado com esses filtros.</div>'
    }`;
}

// ----- Dados antigos (antes da nuvem) -----

// Lê o banco local da versão anterior, se existir algo nele.
async function readLocalData() {
  try {
    if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === 'controle-dispensa')) return null;
    const local = await import('./local-db.js');
    const data = await local.exportAll();
    return data.products.length || data.movements.length ? data : null;
  } catch {
    return null;
  }
}

async function clearLocalData() {
  const local = await import('./local-db.js');
  const data = await local.exportAll();
  await local.importAll({ ...data, groups: [], products: [], movements: [], users: [] });
}

// ----- Casa: criar, convidar, pessoas -----
const USER_ICONS = ['👩', '👨', '👧', '👦', '👵', '👴', '🧑', '👱', '🧔', '👩‍🦱', '🐶', '⭐'];

function iconPicker(selected) {
  return `<div class="icon-pick">${USER_ICONS.map((i) => `<button type="button" class="${i === selected ? 'active' : ''}" data-icon="${i}">${i}</button>`).join('')}</div>`;
}

function bindIconPicker(onPick) {
  view.querySelectorAll('.icon-pick').forEach((box) =>
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-icon]');
      if (!b) return;
      box.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onPick(b.dataset.icon);
    }),
  );
}

function syncText() {
  const st = db.syncStatus();
  if (st.offline) return `📴 Sem conexão${st.pending ? ` · ${st.pending} alteração(ões) esperando para enviar` : ''}`;
  if (st.error) return `⚠️ ${esc(st.error)}`;
  if (st.pending) return `⏳ Enviando ${st.pending} alteração(ões)…`;
  return '✅ Tudo sincronizado';
}

async function casa() {
  if (!db.houseKey()) return casaSetup();
  const house = db.household();
  titleEl.textContent = house?.name || 'Casa';
  const [members, movs] = await Promise.all([db.all('users'), db.all('movements')]);
  const me = db.person();
  const link = db.inviteLink();
  const count = (id) => movs.filter((m) => m.userId === id && m.type !== 'log').length;
  const shareText = `Abra este link para usar a dispensa "${house?.name || 'da casa'}" no app Dispensa:\n${link}`;

  view.innerHTML = `
    <div class="card">
      <b>🔗 Link de convite</b>
      <p class="small muted" style="margin:6px 0 10px">Quem abrir este link no celular entra na casa, sem senha. Envie só para a família.</p>
      <input id="link" readonly value="${esc(link)}">
      <div class="row wrap" style="margin-top:10px">
        <button class="btn primary sm" id="share">📤 Enviar convite</button>
        <button class="btn sm" id="copy">📋 Copiar</button>
      </div>
    </div>
    <h2>Pessoas (${members.length})</h2>
    <div class="card"><ul class="list">${
      members
        .sort(byName)
        .map(
          (m) => `<li><a class="item" href="#/pessoa/${m.id}"><span class="thumb">${esc(m.icon || '🙂')}</span><div class="info"><b>${esc(m.name)}${me?.id === m.id ? ' <span class="badge">neste celular</span>' : ''}</b>
          <span class="small muted">${count(m.id)} movimentação(ões)</span></div>›</a></li>`,
        )
        .join('') || '<li class="muted">Ninguém ainda.</li>'
    }</ul></div>
    <div class="row wrap"><a class="btn" href="#/pessoa/novo">＋ Adicionar pessoa</a><a class="btn" href="#/entrar">🔄 Trocar quem está usando</a></div>
    <details class="card" style="margin-top:12px"><summary>Configurações da casa</summary>
      <label for="hname">Nome da casa</label>
      <div class="input-btn"><input id="hname" value="${esc(house?.name || '')}"><button class="btn" id="rename">Salvar</button></div>
      <p class="small muted" style="margin-top:14px">Se o link foi parar com quem não devia, gere um novo. Os outros celulares da casa vão precisar abrir o link novo.</p>
      <button class="btn block" id="rotate">🔐 Gerar novo link de convite</button>
      <button class="btn danger block" id="forget" style="margin-top:8px">Desconectar este celular</button>
    </details>`;

  $('#share').onclick = async () => {
    if (navigator.share) {
      try {
        return await navigator.share({ title: 'Convite Dispensa', text: shareText });
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`);
  };
  $('#copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado');
    } catch {
      $('#link').select();
    }
  };
  $('#rename').onclick = async () => {
    const name = $('#hname').value.trim();
    if (!name) return;
    try {
      await db.renameHouse(name);
      await db.log('house-rename', `renomeou a casa para ${name}`);
      toast('Nome da casa salvo');
      navigate();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#rotate').onclick = async () => {
    if (!confirm('Gerar um novo link? O link atual para de funcionar e os outros celulares precisarão abrir o novo.')) return;
    try {
      await db.rotateKey();
      await db.log('house-rotate', 'gerou um novo link de convite');
      toast('Novo link gerado. Envie para a família.');
      navigate();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#forget').onclick = async () => {
    if (!confirm('Desconectar este celular da casa? Os dados continuam salvos; para voltar, abra o link de convite.')) return;
    await db.forgetHouse();
    updateUserChip();
    go('#/casa');
  };
}

// Aparelho ainda sem casa: cria a casa (primeira vez) ou pede o link de convite.
async function casaSetup() {
  titleEl.textContent = 'Dispensa';
  backBtn.hidden = true;
  view.innerHTML = '<p class="muted center">Conectando…</p>';
  let status;
  try {
    status = await db.serverStatus();
  } catch (err) {
    view.innerHTML = `<div class="card"><b>Não foi possível falar com o servidor</b><p class="small muted">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Tentar de novo</button></div>`;
    return;
  }
  const pasteForm = `
    <form id="join" class="card">
      <label for="key" style="margin-top:0">Recebeu um link de convite? Abra o link ou cole aqui:</label>
      <div class="input-btn"><input id="key" required placeholder="https://…#/convite?k=…" autocomplete="off"><button class="btn primary">Entrar</button></div>
    </form>`;
  view.innerHTML = `
    <div class="center" style="margin:10px 0 18px"><img src="icons/icon.svg" alt="" width="72" height="72"><h2 style="margin:8px 0 0">Dispensa</h2>
      <p class="muted small">Estoque e compras da casa, sincronizados entre a família.</p></div>
    ${
      status.exists
        ? `<div class="card"><b>🏡 A casa já foi criada</b><p class="small muted" style="margin-top:6px">Peça o link de convite para quem já usa o app (⚙️ → Casa e pessoas → Enviar convite) e abra neste celular.</p></div>${pasteForm}`
        : `<form id="create" class="card">
            <b>Bem-vindo! Vamos criar a sua casa.</b>
            <label for="hname">Nome da casa</label>
            <input id="hname" required value="Nossa casa">
            <button class="btn primary block" style="margin-top:14px">Criar casa</button>
          </form>
          <p class="small muted center">Depois é só enviar o link de convite para a família.</p>`
    }`;
  $('#create')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    e.target.querySelector('button').disabled = true;
    try {
      await db.createHouse($('#hname').value.trim());
      toast('Casa criada!');
      go('#/pessoa/novo?primeira=1');
    } catch (err) {
      toast(err.message);
      e.target.querySelector('button').disabled = false;
    }
  });
  $('#join')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await db.joinWithKey($('#key').value);
      go('#/entrar');
    } catch (err) {
      toast(err.message);
    }
  });
}

// Link de convite aberto: #/convite?k=CHAVE
async function convite({ params }) {
  view.innerHTML = '<p class="muted center">Entrando na casa…</p>';
  try {
    const h = await db.joinWithKey(params.get('k'));
    toast(`Bem-vindo à ${h.name}!`);
    history.replaceState(null, '', '#/entrar');
    navigate();
  } catch (err) {
    view.innerHTML = `<div class="card"><b>Não foi possível usar este convite</b><p class="small muted">${esc(err.message)}</p><a class="btn" href="#/casa">Voltar</a></div>`;
  }
}

// Quem está usando este celular (sem senha).
async function entrar({ params }) {
  const users = (await db.all('users')).sort(byName);
  const next = params.get('next') || '/';
  if (!users.length) return go('#/pessoa/novo');
  const me = db.person();
  view.innerHTML = `
    <p class="muted">Quem está usando este celular? Tudo o que for retirado ou guardado fica registrado com esse nome.</p>
    <div class="user-grid">${users
      .map((u) => `<button class="user-card ${me?.id === u.id ? 'active' : ''}" data-id="${u.id}"><span>${esc(u.icon || '🙂')}</span><b>${esc(u.name)}</b></button>`)
      .join('')}
      <a class="user-card" href="#/pessoa/novo"><span>＋</span><b>Sou novo aqui</b></a></div>`;
  view.querySelector('.user-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    const u = users.find((x) => x.id === card.dataset.id);
    db.setPerson(u.id);
    updateUserChip();
    toast(`Olá, ${u.name}!`);
    go(`#${next}`);
  });
}

async function pessoaForm({ args, params }) {
  const isNew = args[0] === 'novo';
  const users = await db.all('users');
  const u = isNew ? { id: db.uid(), name: '', icon: USER_ICONS[users.length % USER_ICONS.length] } : users.find((x) => x.id === args[0]);
  if (!u) throw new Error('Pessoa não encontrada');
  titleEl.textContent = isNew ? (params.get('primeira') ? 'Quem é você?' : 'Nova pessoa') : u.name;
  backBtn.hidden = !db.person();
  let icon = u.icon;
  view.innerHTML = `
    <form id="f" class="card" autocomplete="off">
      <label for="name" style="margin-top:0">Nome</label>
      <input id="name" required maxlength="30" value="${esc(u.name)}" placeholder="Ex.: Ana">
      <label>Ícone</label>
      ${iconPicker(icon)}
      ${isNew && db.person() ? '<label class="row" style="color:var(--text)"><input type="checkbox" id="use" style="width:20px;min-height:0"> Usar este celular como essa pessoa</label>' : ''}
      <button class="btn primary block" style="margin-top:16px" type="submit">Salvar</button>
    </form>
    ${isNew ? '' : '<button class="btn danger block" id="del">Remover pessoa</button><p class="small muted center">O histórico dessa pessoa continua guardado.</p>'}`;
  bindIconPicker((i) => (icon = i));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    if (users.some((x) => x.id !== u.id && x.name.toLowerCase() === name.toLowerCase())) return toast('Já existe alguém com esse nome');
    const saved = await db.put('users', { ...u, name, icon, createdAt: u.createdAt || Date.now() });
    if (!db.person() || $('#use')?.checked) db.setPerson(saved.id);
    await db.log(isNew ? 'user-create' : 'user-edit', `${isNew ? 'cadastrou' : 'editou'} a pessoa ${saved.name}`);
    updateUserChip();
    toast(isNew ? `${saved.name} cadastrado(a)` : 'Salvo');
    go(params.get('primeira') ? '#/' : isNew && !$('#use') ? '#/' : '#/casa');
  });
  $('#del')?.addEventListener('click', async () => {
    if (!confirm(`Remover ${u.name}? O histórico continua mostrando o nome.`)) return;
    await db.remove('users', u.id);
    await db.log('user-delete', `removeu a pessoa ${u.name}`);
    if (db.person() === null) db.setPerson(null);
    updateUserChip();
    go('#/casa');
  });
}

function updateUserChip() {
  const btn = document.getElementById('user-btn');
  const me = db.houseKey() ? db.person() : null;
  btn.hidden = !me;
  if (me) {
    btn.textContent = `${me.icon || '🙂'} ${me.name}`;
    btn.title = 'Trocar quem está usando';
  }
}

// ---------- inicialização ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

let liveTimer = null;
db.onChange((evt) => {
  if (evt.type === 'auth') {
    updateUserChip();
    toast(evt.error?.message || 'Este celular foi desconectado da casa');
    go('#/casa');
  } else if (evt.type === 'status') {
    const el = document.getElementById('sync-status');
    if (el) el.innerHTML = syncText();
  } else if (evt.type === 'remote') {
    updateUserChip();
    // Outra pessoa mexeu: atualiza a tela atual se ela só mostra dados.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (LIVE_ROUTES.test(currentPath || '') && !document.querySelector('main input:focus, main details[open]')) navigate();
    }, 600);
  }
});

(async () => {
  view.innerHTML = '<p class="muted center" style="margin-top:40px">Carregando…</p>';
  try {
    await db.init();
  } catch (err) {
    console.error(err);
  }
  updateUserChip();
  navigate();
})();
