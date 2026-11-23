// Accounting app: quick entry, split payments, balances home screen, entry list, new people, planned spending, receipts, TymeBank SMS drafts.
'use strict';

const VERSION = '0.11.1';
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  getJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } },
  setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// ---------- Data link ----------

// GET for reads; POST with text/plain (no CORS preflight) for writes.
async function api(action, body) {
  const url = store.get('scriptUrl'), key = store.get('scriptKey');
  if (!url) throw new Error('No Apps Script link saved yet. Open Settings.');
  let res;
  if (body) {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, key, data: body }) });
  } else {
    res = await fetch(`${url}?action=${encodeURIComponent(action)}&key=${encodeURIComponent(key)}`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Unknown error');
  return json.data;
}

// In-memory state, with the last copy kept on the phone so the home screen opens instantly.
const state = {
  lists: store.getJSON('cacheLists', null),
  txs: store.getJSON('cacheTxs', []),
  drafts: store.getJSON('cacheDrafts', []),
  planned: store.getJSON('cachePlanned', []),
  plannedErr: '',
  loadedAt: store.get('cacheAt'),
  loading: false,
  error: '',
};

async function refresh() {
  if (state.loading) return;
  state.loading = true; state.error = '';
  render();
  try {
    const [lists, txs] = await Promise.all([api('lists'), api('transactions')]);
    state.lists = lists; state.txs = txs.map(normTx);
    state.loadedAt = new Date().toISOString();
    store.setJSON('cacheLists', lists); store.setJSON('cacheTxs', state.txs); store.set('cacheAt', state.loadedAt);
  } catch (e) {
    state.error = e.message;
  }
  // Drafts need the updated Apps Script; an older one just means no drafts.
  try { state.drafts = await api('drafts'); store.setJSON('cacheDrafts', state.drafts); } catch (e) {}
  // Planned spending also needs the updated Apps Script.
  try { state.planned = (await api('planned')).map(normPlan); state.plannedErr = ''; store.setJSON('cachePlanned', state.planned); }
  catch (e) { if (/Unknown action/.test(e.message)) state.plannedErr = 'Planned spending needs the updated Apps Script (Code.gs, 20 Nov 2026).'; }
  state.loading = false;
  render();
}

// ---------- Lists ----------

const isActive = r => !(r.active === false || String(r.active).toUpperCase() === 'FALSE');
const L = {
  accounts: () => (state.lists && state.lists.Accounts) || [],
  funds: () => (state.lists && state.lists.Funds) || [],
  categories: () => (state.lists && state.lists.Categories) || [],
  people: () => (state.lists && state.lists.People) || [],
};
const byId = (arr, id) => arr.find(r => r.id === id);
const nameOf = (arr, id) => { const r = byId(arr, id); return r ? r.name : (id || ''); };
const accName = id => {
  const a = byId(L.accounts(), id); if (!a) return id || '';
  const p = a.parent && byId(L.accounts(), a.parent);
  return p ? `${p.name} ${a.name}` : a.name;
};
const accCurrency = id => { const a = byId(L.accounts(), id); return (a && a.currency) || 'ZAR'; };
// Accounts you can post to: active, and not a parent that has pockets.
const postable = () => {
  const accs = L.accounts();
  return accs.filter(a => isActive(a) && !accs.some(c => c.parent === a.id));
};

// Usual fund for each account, until you pick something else (then the app remembers your choice).
const DEFAULT_FUND = { 'tyme-ratna': 'personal', 'tyme-guna': 'guna', 'tyme-transit': 'feeding',
  'cash-zar': 'personal', 'cash-eur': 'personal', 'agricoop-cash': 'agricoop', 'citydeep-card': 'personal' };

// ---------- Entry types and balance rules ----------
// Person balance: positive = the person owes you, negative = you owe them.
const TYPES = [
  { id: 'expense',   label: 'Expense',   main: true, dir: -1, hint: 'Money out of an account.' },
  { id: 'income',    label: 'Income',    main: true, dir: +1, hint: 'Money into an account.' },
  { id: 'transfer',  label: 'Transfer',  main: true, dir: 0,  hint: 'Move money between accounts or pockets.' },
  { id: 'payment',   label: 'Payment',   dir: -1, who: true, cat: 'stipends', hint: 'Paid to someone for work (e.g. trips). Nobody owes anything after.' },
  { id: 'gift',      label: 'Gift',      dir: -1, who: true, cat: 'donations', hint: 'A gift to someone. Shown with the person, not a debt.' },
  { id: 'loan',      label: 'Lent',      dir: -1, person: +1, hint: 'You lend money. They will owe it to the fund. Pick "No cash" for stock or charges with no money moving.' },
  { id: 'advance',   label: 'Advance',   dir: -1, person: +1, hint: 'Paid ahead of a payment. They owe it until it is deducted.' },
  { id: 'bring_back', label: 'Bring back', dir: -1, person: +1, hint: 'They hold your money (e.g. withdraw cash for you) until they bring it back.' },
  { id: 'repayment', label: 'Got back',  dir: +1, person: -1, hint: 'Someone pays you back. Their debt goes down.' },
  { id: 'borrow',    label: 'Borrowed',  dir: +1, person: -1, hint: 'You borrow money. You will owe them.' },
  { id: 'payback',   label: 'Paid back', dir: -1, person: +1, hint: 'You pay back what you borrowed.' },
  // Money someone gives you to buy things for them (on the City Deep card). It stays theirs:
  // not income, not a loan. "Bought for" spends it for them.
  { id: 'keep',      label: 'Kept for',  dir: +1, who: true, held: +1,
    hint: 'Someone gives you money to buy things for them. It stays theirs: not income, not a loan.' },
  { id: 'keep_used', label: 'Bought for', dir: -1, who: true, held: -1,
    hint: 'You bought things for someone with the money you keep for them. It is not your spending.' },
  { id: 'paid_for_me', label: 'Paid for me', dir: -1, person: -1, noCash: true, cat: 'groceries',
    hint: 'Someone bought something for you with their own money. You owe them, and the cost counts as spending. No cash moves.' },
  { id: 'opening',   label: 'Opening',   dir: +1, hint: 'Starting balance of an account, or what a person owes a fund (minus if the fund owes them).' },
  // Used by the sheet import; not offered as buttons.
  { id: 'exchange',      label: 'Exchange',      dir: 0, hidden: true },
  { id: 'fund_transfer', label: 'Fund transfer', dir: 0, hidden: true },
  // Part of a split payment: an advance taken earlier, now deducted from the payment. No cash moves.
  // Also a button: the receipt for an advance (what it really cost). No cash moves; their debt goes down.
  { id: 'advance_used',  label: 'Spent advance', dir: -1, person: -1, noCash: true, cat: 'expenses',
    hint: 'They bring the receipt for an advance. Enter what it really cost; their debt goes down. Enter change they give back with "Got back".' },
];
const typeOf = id => TYPES.find(t => t.id === id) || TYPES[0];
// A Paid back / Got back whose other side is one of your own pockets (to_account).
const pocketSettle = t => (t.type === 'payback' || t.type === 'repayment') && !!t.to_account && !!t.account;
const isMove = t => ['transfer', 'exchange', 'fund_transfer'].includes(typeOf(t.type).id);

// Amounts typed on the phone: "212,40" (the South African keyboard has a comma, not a point) is
// R212.40; "1,049" or "1 049.50" use the comma or space between thousands.
const num = v => {
  const calc = evalExpr(v);
  if (calc !== null) return calc;
  if (hasOp(v)) return 0;              // half-typed or impossible sum: not an amount
  let s = String(v == null ? '' : v).replace(/[\s\u00a0]/g, '');
  if (!s.includes('.') && /,\d{1,2}$/.test(s)) s = s.replace(/,(\d{1,2})$/, '.$1');
  const n = parseFloat(s.replace(/,/g, ''));
  return isFinite(n) ? n : 0;
};

// ---------- Calculator in amount fields ----------
// Any amount field also takes a sum: "217/2", "180+45,50", "3*12", "(100+20)/2".
// A comma before one or two digits is the decimal comma; other commas and spaces separate thousands.
const OPS = { '+': '+', '\u2212': '-', '\u00d7': '*', '\u00f7': '/', '(': '(', ')': ')' };
const hasOp = v => /[+\-*/x\u00d7\u00f7()]/i.test(String(v == null ? '' : v).slice(1));

// Works out a typed sum. Returns a number, or null when the text is not a sum we can read.
function evalExpr(v) {
  let s = String(v == null ? '' : v).replace(/[\s\u00a0]/g, '')
    .replace(/[x\u00d7]/gi, '*').replace(/\u00f7/g, '/').replace(/[\u2212\u2013\u2014]/g, '-');
  if (!s) return null;
  if (!/^[0-9.,+\-*/()]+$/.test(s)) return null;
  s = s.replace(/,(\d{1,2})(?!\d)/g, '.$1').replace(/,/g, '');
  let i = 0;
  const at = () => s[i];
  const fail = () => { throw new Error('bad'); };
  const expr = () => {
    let x = term();
    for (;;) {
      if (at() === '+') { i++; x += term(); }
      else if (at() === '-') { i++; x -= term(); }
      else return x;
    }
  };
  const term = () => {
    let x = unary();
    for (;;) {
      if (at() === '*') { i++; x *= unary(); }
      else if (at() === '/') { i++; const d = unary(); if (!d) fail(); x /= d; }
      else return x;
    }
  };
  const unary = () => {
    if (at() === '-') { i++; return -unary(); }
    if (at() === '+') { i++; return unary(); }
    return atom();
  };
  const atom = () => {
    if (at() === '(') {
      i++; const x = expr();
      if (at() !== ')') fail();
      i++; return x;
    }
    const m = /^(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  try {
    const x = expr();
    if (i !== s.length || !isFinite(x)) return null;
    return Math.round(x * 1e6) / 1e6;
  } catch (e) { return null; }
}

// The row of operator buttons under an amount field, with the worked-out answer on the right.
// The phone's number keypad has no + \u2212 \u00d7 \u00f7, so the buttons type them.
const calcRow = id => `<div class="calcrow" data-for="${id}">${Object.keys(OPS)
  .map(o => `<button type="button" class="calcbtn" data-op="${o}">${o}</button>`).join('')
  }<span class="calcres"></span></div>`;

function wireCalc(id, onChange) {
  const inp = $(id); if (!inp) return;
  const row = document.querySelector(`.calcrow[data-for="${id}"]`);
  const out = row && row.querySelector('.calcres');
  const show = () => {
    if (!out) return;
    if (!hasOp(inp.value)) { out.textContent = ''; return; }
    const n = evalExpr(inp.value);
    out.textContent = n === null ? '?' : '= ' + money(n);
  };
  inp.addEventListener('input', show);
  if (row) row.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.calcbtn'); if (!btn) return;
    e.preventDefault();                            // keep the keyboard open
    const ch = OPS[btn.dataset.op];
    const a = inp.selectionStart, b = inp.selectionEnd;
    if (a == null) { inp.value += ch; } else {
      inp.value = inp.value.slice(0, a) + ch + inp.value.slice(b);
      try { inp.setSelectionRange(a + ch.length, a + ch.length); } catch (err) {}
    }
    inp.focus();
    show();
    if (onChange) onChange();
  });
  show();
}

function normTx(t) {
  return Object.assign({}, t, { date: toDay(t.date) });
}
// Dates come back from the sheet as ISO times (UTC); show them as the local day.
function toDay(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return s;
  return localDay(d);
}
function localDay(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// What one entry does to account, fund and person balances.
function effects(t) {
  const type = typeOf(t.type);
  const amt = num(t.amount), fee = num(t.fee);
  const rate = num(t.rate) || 1;
  const zar = num(t.amount_zar) || (accCurrency(t.account) === 'ZAR' ? amt : amt * rate);
  // Fees are always in rand.
  const feeZar = fee;
  const feeAcc = accCurrency(t.account) === 'ZAR' ? fee : fee / rate;
  const acc = {}, fund = {}, person = {}, held = {};
  const add = (o, k, v) => { if (k) o[k] = (o[k] || 0) + v; };
  if (type.held && t.person && t.account) add(held, t.person + '|' + t.account + '|' + (t.fund || ''), type.held * zar);

  if (type.id === 'fund_transfer') {
    add(fund, t.fund, -zar); add(fund, t.to_fund, zar);
    add(acc, t.account, -feeAcc); add(fund, t.fund, -feeZar);
  } else if (type.id === 'transfer' || type.id === 'exchange') {
    add(acc, t.account, -(amt + feeAcc));
    const fromCur = accCurrency(t.account), toCur = accCurrency(t.to_account);
    const toAmt = fromCur === toCur ? amt : (toCur === 'ZAR' ? zar : amt / rate);
    add(acc, t.to_account, toAmt);
    if (t.to_fund && t.to_fund !== t.fund) { add(fund, t.fund, -zar); add(fund, t.to_fund, zar); }
    add(fund, t.fund, -feeZar);
  } else if (type.id === 'opening') {
    // A person's opening balance has no account: it belongs to a fund but doesn't add money to it.
    add(acc, t.account, amt);
    if (t.account) add(fund, t.fund, zar);
    if (t.person) add(person, t.person + '|' + (t.fund || ''), zar);
  } else {
    // No account = no cash moved (e.g. stock handed to a partner): only the person balance changes.
    add(acc, t.account, type.dir * amt - feeAcc);
    if (t.account) add(fund, t.fund, type.dir * zar - feeZar);
    // Paid back into / Got back from the person's own pocket (Dada Guna): the money moves the
    // other way in that pocket, so it is one entry instead of a transfer plus a no-cash row.
    if (pocketSettle(t)) { add(acc, t.to_account, -type.dir * amt); add(fund, t.to_fund || t.fund, -type.dir * zar); }
    if (type.person && t.person) add(person, t.person + '|' + (t.fund || ''), type.person * zar);
  }
  return { acc, fund, person, held, zar, feeZar };
}

function balances() {
  const acc = {}, fund = {}, person = {}, held = {};
  const merge = (to, from) => { for (const k in from) to[k] = (to[k] || 0) + from[k]; };
  for (const t of state.txs) { const e = effects(t); merge(acc, e.acc); merge(fund, e.fund); merge(person, e.person); merge(held, e.held); }
  // Round to cents so tiny floating-point leftovers don't show as red −R0.00.
  for (const o of [acc, fund, person, held]) for (const k in o) o[k] = Math.round(o[k] * 100) / 100 || 0;
  // held: money you keep for someone, by 'person|account|fund' (Kept for − Bought for).
  return { acc, fund, person, held, owed: owedByPerson(person) };
}

// Person debts, grouped by person, each split by the fund it belongs to.
function owedByPerson(person) {
  const out = {};
  for (const k in person) {
    if (!person[k]) continue;
    const [pid, fid] = k.split('|');
    const o = out[pid] = out[pid] || { total: 0, funds: {} };
    o.total = Math.round((o.total + person[k]) * 100) / 100;
    o.funds[fid] = person[k];
  }
  return out;
}

// ---------- Funds that owe each other ----------
// Each account belongs to one fund ("whose account"). When another fund's money is spent from it
// (Dada Guna's advance paid from your Cash ZAR), that fund owes the account's fund. When another
// fund's money is kept in it, the account's fund owes that fund. The Projects pocket holds several
// funds on purpose, so money kept there is not a debt; only overspending there is. The City Deep
// buyer's card is the same: it holds money of whoever it buys for.
const ACCOUNT_FUND = Object.assign({ 'ajbulk-cash': 'ventures' }, DEFAULT_FUND);
const SHARED_ACCOUNTS = new Set(['tyme-transit', 'citydeep-card']);
// Where each fund's money normally lives, for settling up.
const FUND_ACCOUNT = { personal: 'tyme-ratna', guna: 'tyme-guna', feeding: 'tyme-transit', agricoop: 'agricoop-cash' };

// Money of each fund in each account, in rand: { 'cash-zar|guna': -100, ... }.
function cellEffects(t) {
  const type = typeOf(t.type);
  const amt = num(t.amount), fee = num(t.fee), rate = num(t.rate) || 1;
  const zar = num(t.amount_zar) || (accCurrency(t.account) === 'ZAR' ? amt : amt * rate);
  const out = {};
  const add = (a, f, v) => { if (a && f) out[a + '|' + f] = (out[a + '|' + f] || 0) + v; };
  if (type.id === 'fund_transfer') { add(t.account, t.fund, -zar - fee); add(t.account, t.to_fund, zar); }
  else if (type.id === 'transfer' || type.id === 'exchange') {
    add(t.account, t.fund, -zar - fee); add(t.to_account || t.account, t.to_fund || t.fund, zar);
  } else if (type.id === 'opening') add(t.account, t.fund, zar);
  else {
    add(t.account, t.fund, type.dir * zar - fee);
    if (pocketSettle(t)) add(t.to_account, t.to_fund || t.fund, -type.dir * zar);
  }
  return out;
}

// What one fund owes another (netted), e.g. [{ from: 'guna', to: 'personal', amount: 100 }].
function fundDebts(txs) {
  const cells = {};
  for (const t of txs) { const c = cellEffects(t); for (const k in c) cells[k] = (cells[k] || 0) + c[k]; }
  const pos = {}; // + = other funds owe this fund
  const add = (f, v) => { pos[f] = (pos[f] || 0) + v; };
  for (const k in cells) {
    const [a, f] = k.split('|'), x = cells[k], home = ACCOUNT_FUND[a];
    if (!home || f === home || Math.abs(x) < 0.005) continue;
    if (SHARED_ACCOUNTS.has(a) && x > 0) continue;
    add(f, x); add(home, -x);
  }
  const debtors = [], creditors = [];
  for (const f in pos) {
    const x = Math.round(pos[f] * 100) / 100;
    if (x < 0) debtors.push({ f, x: -x }); else if (x > 0) creditors.push({ f, x });
  }
  debtors.sort((a, b) => b.x - a.x); creditors.sort((a, b) => b.x - a.x);
  const out = [];
  for (const d of debtors) for (const c of creditors) {
    const m = Math.round(Math.min(d.x, c.x) * 100) / 100;
    if (m <= 0) continue;
    out.push({ from: d.f, to: c.f, amount: m });
    d.x -= m; c.x -= m;
  }
  return out;
}

// Latest rate used for a currency, to show foreign cash in rand.
function lastRate(cur) {
  const accs = L.accounts().filter(a => a.currency === cur).map(a => a.id);
  const ts = state.txs.filter(t => (accs.includes(t.account) || accs.includes(t.to_account)) && num(t.rate))
    .sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at));
  return ts.length ? num(ts[ts.length - 1].rate) : 0;
}

// ---------- Formatting ----------

const SYMBOL = { ZAR: 'R', EUR: '€', INR: '₹', USD: '$' };
function money(v, cur = 'ZAR') {
  const s = SYMBOL[cur] || (cur + ' ');
  const n = Math.round(v * 100) / 100;
  const abs = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '−' : '') + s + abs;
}
function niceDate(day) {
  if (!day) return '';
  const today = localDay(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (day === today) return 'Today';
  if (day === localDay(y)) return 'Yesterday';
  const [Y, M, D] = day.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${D} ${months[M - 1]}${Y !== new Date().getFullYear() ? ' ' + Y : ''}`;
}
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg; el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), isErr ? 5000 : 2200);
}

// ---------- Views ----------

function route() { return (location.hash || '#home').slice(1).split('/'); }
// A screen that fails to draw shows the error instead of a blank page.
function render() {
  try { renderView(); } catch (e) {
    $('view').innerHTML = `<header><h1>Something went wrong</h1></header><p class="err small">${esc(e.message)}</p>
      <p class="muted small">Version ${VERSION}. Please send a screenshot of this.</p>`;
  }
}
function renderView() {
  const [tab, arg] = route();
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const needSetup = !store.get('scriptUrl');
  if (needSetup && tab !== 'settings') { location.replace('#settings'); return; }
  const v = $('view');
  if (tab === 'add') { if (!v.querySelector('#entry-form') || render.lastTab !== 'add') renderAdd(v); }
  else if (tab === 'list') renderList(v);
  else if (tab === 'split') { if (!v.querySelector('#split-form') || render.lastTab !== 'split' || !split.ready) renderSplit(v, route().slice(1)); }
  else if (tab === 'pay') renderPay(v, arg);
  else if (tab === 'plan') { if (arg !== 'edit') renderPlan(v); else if (!v.querySelector('#plan-form') || render.lastHash !== location.hash) renderPlanEdit(v); }
  else if (tab === 'tx') renderTx(v, arg);
  else if (tab === 'settings') renderSettings(v);
  else renderHome(v);
  render.lastTab = tab; render.lastHash = location.hash;
}

function statusLine() {
  if (state.loading) return '<span class="muted small">Updating…</span>';
  if (state.error) return `<span class="err small">${esc(state.error)}</span>`;
  if (state.loadedAt) {
    const d = new Date(state.loadedAt);
    return `<span class="muted small">Updated ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  }
  return '';
}

function renderHome(v) {
  if (!state.lists) {
    v.innerHTML = `<header><h1>Accounting</h1></header><p class="muted">${state.loading ? 'Loading your data…' : esc(state.error || 'No data yet.')}</p>`;
    return;
  }
  const b = balances();
  const accs = L.accounts();
  const eurRate = lastRate('EUR');
  const plan = planStatus();
  // "R650 after planned" under each fund (whose money is left after plans). Not shown on pockets
  // or the total: allocations are often not tied to a pocket, so it would give a mixed picture.
  // People's debts belong to a fund: "R505 owed back" (people owe it), "R470 owed to others".
  const fundOwed = fid => {
    let back = 0, others = 0;
    for (const k in b.person) { if (k.split('|')[1] !== fid) continue; const x = b.person[k]; if (x > 0) back += x; else others -= x; }
    return (back > 0.004 ? `<div class="muted small">${money(back)} owed back</div>` : '') + (others > 0.004 ? `<div class="muted small">${money(others)} owed to others</div>` : '');
  };
  const after = (x, left) => left > 0.004 ? `<div class="small ${x - left < 0 ? 'err' : 'muted'}">${money(x - left)} after planned</div>` : '';

  // Accounts, with pockets under their parent.
  let accRows = '', totalZar = 0, missingRate = false;
  const shown = a => isActive(a) || Math.abs(b.acc[a.id] || 0) > 0.004;
  for (const a of accs.filter(a => !a.parent)) {
    const kids = accs.filter(c => c.parent === a.id && shown(c));
    if (kids.length) {
      const sum = kids.reduce((s, c) => s + (b.acc[c.id] || 0), 0);
      totalZar += sum;
      accRows += `<div class="row parent"><span class="name">${esc(a.name)}</span><span class="amt ${sum < 0 ? 'neg' : ''}">${money(sum)}</span></div>`;
      for (const c of kids) {
        const x = b.acc[c.id] || 0;
        accRows += `<div class="row sub"><span class="name">${esc(c.name)}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(x)}</span></div>`;
      }
    } else if (shown(a)) {
      const x = b.acc[a.id] || 0, cur = a.currency || 'ZAR';
      let extra = '';
      if (cur !== 'ZAR') {
        const r = cur === 'EUR' ? eurRate : lastRate(cur);
        if (r) { totalZar += x * r; extra = `<div class="muted small">≈ ${money(x * r)}</div>`; }
        else if (x) missingRate = true;
      } else totalZar += x;
      const kept = Object.keys(b.held).filter(k => k.split('|')[1] === a.id).reduce((s, k) => s + b.held[k], 0);
      if (kept > 0.004) extra += `<div class="muted small">${money(kept)} kept for others</div>`;
      accRows += `<div class="row"><span class="name">${esc(a.name)}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(x, cur)}${extra}</span></div>`;
    }
  }

  const fundRows = L.funds().filter(f => isActive(f) || Math.abs(b.fund[f.id] || 0) > 0.004).map(f => {
    const x = b.fund[f.id] || 0;
    // Personal also holds money kept for people without a fund of their own (Ana's R100).
    const kept = f.id !== 'personal' ? 0 : Object.keys(b.held).filter(k => k.split('|')[2] === f.id).reduce((s, k) => s + b.held[k], 0);
    const extra = (kept > 0.004 ? `<div class="muted small">${money(kept)} kept for others</div>` : '') + fundOwed(f.id) + after(x, plan.byFund[f.id] || 0);
    return `<div class="row"><span class="name">${esc(f.name)}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(x)}${extra}</span></div>`;
  }).join('');

  // Each debt belongs to a fund: "School owes Dada K's feeding program R1,049".
  // Tap a debt to settle it: "Paid back" when you owe them, "Got back" when they owe you.
  const debtLine = (x, fid) => x > 0 ? `owes ${fundLabel(fid)}` : fid === 'personal' ? 'you owe them' : `${fundLabel(fid)} owes them`;
  const settleLink = x => `<div><button type="button" class="link">${x < 0 ? 'Pay back' : 'Got back'} ›</button></div>`;
  const debtRow = (cls, pid, fid, x, name) => `<div class="row tap ${cls}" data-pdebt="${esc(pid)}|${esc(fid)}|${Math.abs(x)}"><span class="name">${name}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(Math.abs(x))}${settleLink(x)}</span></div>`;
  const owed = L.people().map(p => ({ p, o: b.owed[p.id] })).filter(r => r.o && Object.keys(r.o.funds).length)
    .sort((a, b) => b.o.total - a.o.total);
  const peopleRows = owed.length ? owed.map(({ p, o }) => {
    const parts = Object.entries(o.funds).sort((a, b) => b[1] - a[1]);
    if (parts.length === 1) {
      const [fid, x] = parts[0];
      return debtRow('', p.id, fid, x, `${esc(p.name)} <span class="muted small">${esc(debtLine(x, fid))}</span>`);
    }
    return `<div class="row parent"><span class="name">${esc(p.name)} <span class="muted small">${o.total >= 0 ? 'owes in all' : 'is owed in all'}</span></span><span class="amt ${o.total < 0 ? 'neg' : ''}">${money(Math.abs(o.total))}</span></div>` +
      parts.map(([fid, x]) => debtRow('sub', p.id, fid, x, esc(debtLine(x, fid)))).join('');
  }).join('') : '<div class="empty small">Nobody owes anything.</div>';
  // Funds that owe each other, with a button to pay it back.
  const fundDebtRows = fundDebts(state.txs).map(d => {
    const fromAcc = FUND_ACCOUNT[d.from], toAcc = FUND_ACCOUNT[d.to];
    const can = fromAcc && toAcc && postable().some(a => a.id === fromAcc) && postable().some(a => a.id === toAcc);
    return `<div class="row"><span class="name">${esc(nameOf(L.funds(), d.from))} <span class="muted small">owes ${esc(fundLabel(d.to))}</span></span>
      <span class="amt">${money(d.amount)}${can ? `<div><button class="link" data-settle="${esc(d.from)}|${esc(d.to)}|${d.amount}">Pay back ›</button></div>` : ''}</span></div>`;
  }).join('');
  // Money you keep for others (Kept for − Bought for), e.g. on the City Deep card.
  const keptRows = Object.keys(b.held).filter(k => Math.abs(b.held[k]) > 0.004).map(k => {
    const [pid, aid, fid] = k.split('|'), x = b.held[k];
    return `<div class="row tap" data-held="${esc(k)}"><span class="name">${esc(nameOf(L.people(), pid))} <span class="muted small">${x > 0 ? 'on' : 'spent more than kept on'} ${esc(nameOf(L.accounts(), aid))}</span></span>
      <span class="amt ${x < 0 ? 'neg' : ''}">${money(Math.abs(x))}<div><button type="button" class="link">Bought for ›</button></div></span></div>`;
  }).join('');

  const recent = listItems(sortedTxs(), false).slice(0, 5);
  const drafts = state.drafts.map(d => Object.assign({ id: d.id }, draftInfo(d)))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.at).localeCompare(String(a.at)));

  v.innerHTML = `
    <header><h1>Accounting</h1><button class="refresh" id="refresh">↻ Refresh</button></header>
    <div>${statusLine()}</div>
    <button type="button" class="ghost" id="scan-receipt">Scan receipt</button>
    <div class="total-box">
      <div class="small">All money${missingRate ? ' (foreign cash without a rate left out)' : ''}</div>
      <div class="big">${money(totalZar)}</div>
    </div>
    ${drafts.length ? `<h2>Drafts to finish</h2><div class="card">${drafts.map(d => `<div class="tx" data-draft="${esc(d.id)}"><div class="l"><div class="t1">${esc(d.who)}</div><div class="t2">${esc(niceDate(d.date))} · ${esc(d.status)}</div></div><div class="amt">${money(d.total)}</div></div>`).join('')}</div>` : ''}
    ${plan.soon.length ? `<h2>Due soon</h2><div class="card">${plan.soon.map(billRow).join('')}</div>` : ''}
    <h2>Accounts</h2><div class="card">${accRows}</div>
    <h2>Funds (whose money)</h2><div class="card">${fundRows}</div>
    ${fundDebtRows ? `<h2>Funds that owe each other</h2><div class="card">${fundDebtRows}</div>
      <div class="hint">When one fund's money pays for another fund, the other fund owes it back.</div>` : ''}
    <h2>People</h2><div class="card">${peopleRows}</div>
    ${keptRows ? `<h2>Kept for others</h2><div class="card">${keptRows}</div>
      <div class="hint">Money people gave you to buy things for them. It is theirs until you buy it.</div>` : ''}
    <h2>Recent</h2><div class="card">${recent.length ? recent.map(itemRow).join('') : '<div class="empty small">No entries yet. Tap + to add one.</div>'}</div>
    ${recent.length ? '<p><a class="link" href="#list">All entries ›</a></p>' : ''}
  `;
  $('refresh').onclick = refresh;
  $('scan-receipt').onclick = startReceipt;
  bindTxRows(v);
  bindPlanRows(v);
  v.querySelectorAll('[data-settle]').forEach(el => el.onclick = () => {
    const [from, to, amount] = el.dataset.settle.split('|');
    formSeed = { type: 'transfer', amount, account: FUND_ACCOUNT[from], to_account: FUND_ACCOUNT[to], fund: from,
      to_fund: '', moveFund: false, category: '', person: '', fundFrom: '', fee: '',
      note: `${nameOf(L.funds(), from)} pays back ${nameOf(L.funds(), to)}`, settle: { from, to } };
    location.hash = '#add';
  });
  v.querySelectorAll('[data-pdebt]').forEach(el => el.onclick = () => {
    const [pid, fid, amount] = el.dataset.pdebt.split('|');
    startPersonSettle(pid, fid, b.person[pid + '|' + fid] || 0, amount);
  });
  v.querySelectorAll('[data-draft]').forEach(el => el.onclick = () => { location.hash = '#split/draft/' + encodeURIComponent(el.dataset.draft); });
  v.querySelectorAll('[data-held]').forEach(el => el.onclick = () => {
    const [pid, aid, fid] = el.dataset.held.split('|');
    const x = b.held[el.dataset.held] || 0;
    formSeed = { type: 'keep_used', amount: x > 0 ? String(x) : '', account: aid, person: pid,
      fund: fid || fundFor(aid), fundFrom: pid, category: '', fee: '', to_account: '', to_fund: '', moveFund: false,
      note: `Bought for ${nameOf(L.people(), pid)}` };
    location.hash = '#add';
  });
}

// ---------- Settle a person's debt ----------
// A person who also has a fund with their own pocket (Dada Guna): you can pay them back into
// that pocket instead of paying them out, or take what they owe from it.
function personPocket(pid) {
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const p = byId(L.people(), pid); if (!p) return null;
  const f = L.funds().find(f => key(f.name) === key(p.name) || f.id === pid);
  const acc = f && FUND_ACCOUNT[f.id];
  if (!acc || SHARED_ACCOUNTS.has(acc) || !postable().some(a => a.id === acc)) return null;
  return { account: acc, fund: f.id };
}
function startPersonSettle(pid, fid, bal, amount) {
  const name = nameOf(L.people(), pid);
  const type = bal < 0 ? 'payback' : 'repayment';
  const acc = FUND_ACCOUNT[fid];
  const pocket = personPocket(pid);
  formSeed = { type, amount, person: pid, fund: fid, fundFrom: pid, category: '', fee: '', moveFund: false, to_fund: '', to_account: '',
    note: type === 'payback' ? `Paid back ${name}` : `${name} paid back`,
    pdebt: { person: pid, fund: fid, type, pocket } };
  if (acc && postable().some(a => a.id === acc)) formSeed.account = acc;
  // Dada Guna: his money is kept in his own pocket, so that is the usual way to settle.
  if (pocket) { formSeed.viaPocket = true; if (formSeed.account === pocket.account) formSeed.account = ''; }
  location.hash = '#add';
}
// Settling through the person's pocket: is it on for the form as it is now?
const pocketMode = () => !!(form.pdebt && form.pdebt.pocket && form.viaPocket && form.type === form.pdebt.type && form.person === form.pdebt.person);

function sortedTxs() {
  return state.txs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function txTitle(t) {
  const type = typeOf(t.type);
  if (t.note) return t.note;
  if (type.id === 'fund_transfer') return `${nameOf(L.funds(), t.fund)} → ${nameOf(L.funds(), t.to_fund)}`;
  if (isMove(t)) return `${accName(t.account)} → ${accName(t.to_account)}`;
  if (pocketSettle(t)) return `${type.label} · ${nameOf(L.people(), t.person)}`;
  if ((type.person || type.held) && t.person) return `${type.label} · ${nameOf(L.people(), t.person)}`;
  return nameOf(L.categories(), t.category) || type.label;
}
// "Tyme Dada Ratna → Tyme Dada Guna": where the money went for a pocket settle.
const pocketPath = t => typeOf(t.type).dir < 0 ? `${accName(t.account)} → ${accName(t.to_account)}` : `${accName(t.to_account)} → ${accName(t.account)}`;
function txRow(t) {
  const type = typeOf(t.type);
  const cur = accCurrency(t.account);
  const amt = num(t.amount);
  // No cash moved (e.g. a debt cleared by a pocket transfer): no plus or minus, the money didn't move here.
  const noCash = !t.account && !isMove(t) && type.id !== 'opening';
  const pocket = pocketSettle(t);
  const sign = isMove(t) || noCash || pocket ? '' : (type.dir > 0 ? '+' : '−');
  let partOf = '';
  if (t.group_id) {
    const cash = cashRows(groupRows(t.group_id));
    if (cash.length > 1 || t.type === 'advance_used') {
      const g = cash.reduce((s, x) => s + num(x.amount), 0);
      partOf = `part of ${money(g)}${t.paid_to ? ' to ' + nameOf(L.people(), t.paid_to) : ''}`;
    }
  }
  const bits = [niceDate(t.date), isMove(t) ? type.label : noCash ? type.label + ', no cash' : pocket ? pocketPath(t) : accName(t.account),
    nameOf(L.funds(), t.fund), t.person ? nameOf(L.people(), t.person) : '', partOf].filter(Boolean);
  return `<div class="tx" data-id="${esc(t.id)}"><div class="l"><div class="t1">${esc(txTitle(t))}</div><div class="t2">${esc(bits.join(' · '))}</div></div>
    <div class="amt ${type.dir > 0 && type.id !== 'opening' && !noCash && !pocket ? 'in' : ''}">${sign}${money(amt, cur)}</div></div>`;
}
// Lists show one line per payment; with a fund, account or person filter, the matching parts instead.
function listItems(rows, showParts) {
  if (showParts) return rows.map(t => ({ t }));
  const seen = new Set(), out = [];
  for (const t of rows) {
    if (!t.group_id) { out.push({ t }); continue; }
    if (seen.has(t.group_id)) continue;
    seen.add(t.group_id); out.push({ g: t.group_id });
  }
  return out;
}
function itemRow(it) {
  if (it.t) return txRow(it.t);
  const rows = groupRows(it.g), cash = cashRows(rows);
  if (cash.length === 1 && rows.length === 1) return txRow(cash[0]);
  const first = cash[0] || rows[0];
  const out = groupOut(cash);
  const total = cash.reduce((s, x) => s + num(x.amount), 0);
  const notes = [...new Set(cash.map(x => x.note || ''))];
  const title = first.paid_to ? `${out ? 'To' : 'From'} ${nameOf(L.people(), first.paid_to)}` : (notes.length === 1 && notes[0]) || 'Split payment';
  const bits = [niceDate(first.date), nameOf(L.accounts(), topOf(rowAcc(first))), `${cash.length} part${cash.length === 1 ? '' : 's'}`];
  return `<div class="tx" data-gid="${esc(it.g)}"><div class="l"><div class="t1">${esc(title)}</div><div class="t2">${esc(bits.join(' · '))}</div></div>
    <div class="amt ${out ? '' : 'in'}">${out ? '−' : '+'}${money(total)}</div></div>`;
}
function bindTxRows(v) {
  v.querySelectorAll('.tx[data-gid]').forEach(el => el.onclick = () => { location.hash = '#pay/' + encodeURIComponent(el.dataset.gid); });
  v.querySelectorAll('.tx[data-id]').forEach(el => el.onclick = () => { location.hash = '#tx/' + encodeURIComponent(el.dataset.id); });
}

// ---------- Quick entry ----------

const form = {}; // current form values
let formSeed = null; // values to start the next new entry with (e.g. "Pay back" on the home screen)
function seedForm() { if (formSeed) { Object.assign(form, formSeed); formSeed = null; } }

function resetForm(keepType) {
  const last = store.getJSON('lastEntry', {});
  const type = keepType || last.type || 'expense';
  const accounts = postable();
  const account = (last.account && accounts.some(a => a.id === last.account)) ? last.account : (accounts[0] && accounts[0].id) || '';
  Object.assign(form, {
    type, amount: '', account, to_account: '', fund: fundFor(account), to_fund: '',
    category: (last.cats || {})[type] || typeOf(type).cat || '', person: '', note: '', date: localDay(new Date()),
    fee: '', rate: '', moveFund: false, fundFrom: '', settle: null, pdebt: null, viaPocket: false, planned: '',
  });
}
function fundFor(account) {
  const remembered = store.getJSON('fundByAccount', {});
  return remembered[account] || DEFAULT_FUND[account] || (L.funds()[0] && L.funds()[0].id) || '';
}

function chips(name, items, value, opts = {}) {
  return `<div class="chips" data-name="${name}">${opts.none ? `<button type="button" class="chip ${!value ? 'on' : ''}" data-v="">${esc(opts.none)}</button>` : ''}${
    items.map(i => `<button type="button" class="chip ${i.main ? 'main' : ''} ${i.id === value ? 'on' : ''}" data-v="${esc(i.id)}">${esc(i.label || i.name)}</button>`).join('')}${
    opts.add ? '<button type="button" class="chip add" data-add="1">+ New</button>' : ''}</div>`;
}

function renderAdd(v) {
  if (!state.lists) { v.innerHTML = `<header><h1>New entry</h1></header><p class="muted">${state.loading ? 'Loading lists…' : 'Lists not loaded yet. Check Settings.'}</p>`; return; }
  if (!form.type) resetForm();
  const type = typeOf(form.type);
  const isTransfer = type.id === 'transfer', isOpening = type.id === 'opening';
  const accs = postable().map(a => ({ id: a.id, name: a.parent ? accName(a.id).replace(/^TymeBank /, 'Tyme ') : a.name }));
  const funds = L.funds().filter(isActive);
  const cats = L.categories().filter(isActive).filter(c => {
    const k = String(c.kind || 'both');
    return k === 'both' || (type.dir < 0 ? k === 'expense' : k === 'income');
  });
  const people = L.people().filter(isActive);
  const cur = accCurrency(form.account);
  const needRate = cur !== 'ZAR' || (isTransfer && form.to_account && accCurrency(form.to_account) !== cur);
  const isTyme = /^tyme/.test(form.account);
  const pd = form.pdebt && form.pdebt.type === type.id && form.person === form.pdebt.person ? form.pdebt : null;
  const viaPocket = pocketMode();
  const pname = pd ? esc(nameOf(L.people(), pd.person)) : '';
  const pocketChoice = pd && pd.pocket ? `<div class="lbl">${type.id === 'payback' ? 'Where does the money go?' : 'Where does the money come from?'}</div>
      ${chips('via', type.id === 'payback'
        ? [{ id: 'pocket', name: `Into ${pname}'s pocket` }, { id: 'out', name: `Paid out to ${pname}` }]
        : [{ id: 'pocket', name: `From ${pname}'s pocket` }, { id: 'out', name: `${pname} gave it` }], viaPocket ? 'pocket' : 'out')}
      ${viaPocket ? `<div class="hint">${type.id === 'payback'
        ? `Moves the money into ${esc(accName(pd.pocket.account))} (fund ${esc(nameOf(L.funds(), pd.pocket.fund))}) and clears what you owe.`
        : `Moves the money out of ${esc(accName(pd.pocket.account))} (fund ${esc(nameOf(L.funds(), pd.pocket.fund))}) and clears what ${pname} owes.`}</div>` : ''}` : '';
  const accChoices = viaPocket ? accs.filter(a => a.id !== pd.pocket.account && accCurrency(a.id) === 'ZAR') : accs;

  v.innerHTML = `
    <header><h1>New entry</h1></header>
    <form id="entry-form" autocomplete="off">
      ${chips('type', TYPES.filter(t => !t.hidden), form.type)}
      <div class="hint">${esc(type.hint)}</div>
      ${form.planned && (byId(state.planned, form.planned) || {}).kind === 'bill' ? `<div class="hint ok">Pays the planned bill “${esc(byId(state.planned, form.planned).name)}”.</div>` : ''}

      <label for="f-amount">Amount${cur !== 'ZAR' ? ' (' + cur + ')' : ''}</label>
      <div class="amount-wrap"><span>${SYMBOL[cur] || cur}</span>
        <input id="f-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(form.amount)}"></div>
      ${calcRow('f-amount')}

      ${type.person || type.who || isOpening ? `<div class="lbl">Person${isOpening ? ' (only for a person\'s opening balance)' : ''}</div>${chips('person', people, form.person, isOpening ? { none: 'No one', add: true } : { add: true })}` : ''}

      ${pocketChoice}
      ${type.noCash ? '' : `<div class="lbl">${isTransfer || (pd && type.dir < 0) ? 'From' : pd ? 'Into' : 'Account'}</div>
      ${chips('account', accChoices, form.account, isOpening || viaPocket ? (isOpening ? { none: 'None' } : {}) : type.person ? { none: 'No cash' } : {})}`}

      ${isTransfer ? `<div class="lbl">To</div>${chips('to_account', accs.filter(a => a.id !== form.account), form.to_account)}` : ''}

      ${needRate ? `<label for="f-rate">Rate (rand per 1 ${cur !== 'ZAR' ? cur : accCurrency(form.to_account)})</label>
        <input id="f-rate" inputmode="decimal" placeholder="e.g. 19.85" value="${esc(form.rate)}">` : ''}

      <div class="lbl">${isTransfer && form.moveFund ? 'From fund' : 'Fund (whose money)'}</div>
      ${chips('fund', funds, form.fund, isOpening ? { none: 'None' } : {})}
      ${form.fundFrom && form.fundFrom === form.person ? `<div class="hint">Last used with ${esc(nameOf(L.people(), form.person))}.</div>` : ''}
      ${fundNote()}
      ${type.held ? `<div class="hint">${HELD_FUND_HINT}</div>` : ''}
      ${isTransfer ? `<div class="hint"><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit"><input type="checkbox" id="f-movefund" style="width:auto" ${form.moveFund ? 'checked' : ''}> Money also changes fund</label></div>
        ${form.moveFund ? `<div class="lbl">To fund</div>${chips('to_fund', funds.filter(f => f.id !== form.fund), form.to_fund)}` : ''}` : ''}

      ${!isTransfer && !isOpening && !viaPocket && !type.held ? `<div class="lbl">Category</div>${chips('category', cats, form.category, type.person ? { none: 'None' } : {})}` : ''}

      ${!type.person && !type.who && !isOpening && !isTransfer ? `<div class="lbl">Person (optional)</div>${chips('person', people, form.person, { none: 'No one', add: true })}` : ''}

      ${allocChoice()}

      <label for="f-note">Note</label>
      <input id="f-note" placeholder="What was it?" value="${esc(form.note)}" enterkeyhint="done">

      <div class="two">
        <div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(form.date)}"></div>
        ${!isOpening && !type.noCash ? `<div><label for="f-fee">Bank fee (R)</label><input id="f-fee" inputmode="decimal" placeholder="0.00" value="${esc(form.fee)}"></div>` : ''}
      </div>
      ${!isOpening && isTyme ? `<button type="button" class="link" id="sms-fee">+ R0.50 SMS fee</button>` : ''}

      <button class="primary" id="save" type="submit">Save</button>
      ${SPLIT_TYPES.has(type.id) && !isOpening && !viaPocket && (!form.account || accCurrency(form.account) === 'ZAR') ? '<button type="button" class="ghost" id="to-split">Split into parts…</button>' : ''}
      ${type.dir < 0 && !isOpening ? '<button type="button" class="ghost" id="scan-receipt">Scan receipt…</button>' : ''}
      <p id="form-msg" class="hint"></p>
    </form>`;

  const f = $('entry-form');
  wireCalc('f-amount');
  // Keep typed values when the form re-draws.
  const sync = () => {
    form.amount = $('f-amount').value; form.note = $('f-note').value; form.date = $('f-date').value;
    if ($('f-fee')) form.fee = $('f-fee').value;
    if ($('f-rate')) form.rate = $('f-rate').value;
  };
  f.querySelectorAll('.chips').forEach(group => {
    group.onclick = e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      sync();
      const name = group.dataset.name, val = btn.dataset.v;
      if (btn.dataset.add) {
        openNewPerson(form.fund, pid => { form.person = pid; usePersonFund(); renderAdd(v); });
        return;
      }
      if (name === 'via') {
        form.viaPocket = val === 'pocket';
        if (form.viaPocket && form.account === form.pdebt.pocket.account) form.account = '';
      } else if (name === 'type') {
        form.type = val;
        const cats = (store.getJSON('lastEntry', {}).cats) || {};
        form.category = cats[val] || typeOf(val).cat || '';
        if (val === 'opening') { form.fee = ''; }
      } else if (name === 'account') {
        form.account = val;
        if (val && !(form.fundFrom && form.fundFrom === form.person) && !form.pdebt) form.fund = fundFor(val);
        if (form.to_account === val) form.to_account = '';
      } else {
        form[name] = (form[name] === val && name !== 'fund') ? '' : val;
        if (name === 'fund') form.fundFrom = '';
        if (name === 'person') usePersonFund();
      }
      renderAdd(v);
    };
  });
  // Picking a person fills in the fund last used with them (you can still change it).
  function usePersonFund() {
    const pf = form.person && personFund(form.person);
    if (pf) { form.fund = pf; form.fundFrom = form.person; } else form.fundFrom = '';
  }
  if ($('f-movefund')) $('f-movefund').onchange = e => { sync(); form.moveFund = e.target.checked; form.to_fund = ''; renderAdd(v); };
  if ($('sms-fee')) $('sms-fee').onclick = () => { $('f-fee').value = (num($('f-fee').value) + 0.5).toFixed(2); };
  f.onsubmit = async e => { e.preventDefault(); sync(); await saveEntry(); };
  if ($('scan-receipt')) $('scan-receipt').onclick = startReceipt;
  if ($('to-split')) $('to-split').onclick = () => {
    sync();
    const pocket = form.account && postable().some(a => a.id === form.account) ? form.account : '';
    splitSeed = { mode: typeOf(form.type).dir > 0 ? 'in' : 'out', total: form.amount, date: form.date, note: form.note,
      account: pocket ? topOf(pocket) : '', fee: form.fee,
      parts: [{ type: form.type, amount: '', pocket, fund: form.fund, category: form.category, person: form.person }] };
    location.hash = '#split';
  };
}

// Open allocations this entry can count for (money out, and pocket/fund fit where set).
function openAllocs() {
  const type = typeOf(form.type);
  if (type.dir >= 0 || isMove(form) || type.id === 'opening') return [];
  return state.planned.filter(p => p.active && p.kind === 'alloc' && (!p.account || !form.account || p.account === form.account) && (!p.fund || p.fund === form.fund));
}
function allocChoice() {
  const cur = form.planned && byId(state.planned, form.planned);
  if (cur && cur.kind === 'bill') return '';
  const list = openAllocs();
  if (!list.length) return '';
  const left = {}; planStatus().allocs.forEach(a => { left[a.p.id] = a.left; });
  return `<div class="lbl">Allocation (optional)</div>${chips('planned', list.map(p => ({ id: p.id, name: `${p.name} · ${money(left[p.id] || 0)} left` })), form.planned, { none: 'None' })}`;
}

// A line under the fund when the money belongs to another fund than the account's own.
function fundNote() {
  const type = typeOf(form.type), home = ACCOUNT_FUND[form.account];
  if (form.settle) return `<div class="hint">Keep the fund as ${esc(nameOf(L.funds(), form.settle.from))}: this pays back what it owes ${esc(fundLabel(form.settle.to))}.</div>`;
  if (!form.account || !form.fund || !home || form.fund === home || type.id === 'opening') return '';
  const f = esc(nameOf(L.funds(), form.fund)), h = esc(fundLabel(home));
  if (type.id === 'transfer') return '';
  if (type.dir < 0) return SHARED_ACCOUNTS.has(form.account) ? '' : `<div class="hint">Paid with ${esc(nameOf(L.funds(), home))} money, so ${f} will owe ${h}. You can pay it back from the home screen.</div>`;
  return SHARED_ACCOUNTS.has(form.account) ? '' : `<div class="hint">${f} money kept here, so ${h} will owe ${f} until it is moved.</div>`;
}
const fundLabel = fid => !fid ? 'no fund set' : fid === 'personal' ? 'you (Personal)' : nameOf(L.funds(), fid);

function validate() {
  const type = typeOf(form.type);
  if (hasOp(form.amount) && evalExpr(form.amount) === null) return 'That sum does not work out. Check the amount.';
  const amt = num(form.amount);
  if (!amt || (amt < 0 && type.id !== 'opening')) return 'Enter an amount.';
  if (!form.date) return 'Pick a date.';
  if (type.id === 'opening') {
    if (!form.account && !form.person) return 'Pick an account or a person.';
    if (form.account && !form.fund) return 'Pick the fund this money belongs to.';
    return '';
  }
  if (type.noCash) form.account = '';
  if (pocketMode() && (!form.account || accCurrency(form.account) !== 'ZAR' || form.account === form.pdebt.pocket.account))
    return type.dir < 0 ? 'Pick where the money comes from.' : 'Pick where the money goes.';
  if (!form.account && !type.person) return 'Pick an account.';
  if (type.noCash && !form.category) return 'Pick a category.';
  if (!form.fund) return 'Pick a fund.';
  if (type.id === 'transfer') {
    if (!form.to_account && !(form.moveFund && form.to_fund)) return 'Pick where the money goes.';
    if (form.moveFund && !form.to_fund) return 'Pick the fund it moves to.';
  }
  if ((type.person || type.who) && !form.person) return 'Pick the person.';
  if (!type.person && !type.held && type.id !== 'transfer' && !form.category) return 'Pick a category.';
  const cur = accCurrency(form.account);
  const needRate = cur !== 'ZAR' || (type.id === 'transfer' && form.to_account && accCurrency(form.to_account) !== cur);
  if (needRate && !num(form.rate)) return 'Enter the exchange rate.';
  return '';
}

async function saveEntry() {
  const msg = $('form-msg');
  const problem = validate();
  if (problem) { msg.className = 'hint err'; msg.textContent = problem; return; }
  const type = typeOf(form.type);
  const cur = accCurrency(form.account);
  const amt = num(form.amount), rate = num(form.rate);
  const tx = {
    date: form.date, type: type.id, amount: amt, currency: form.account ? cur : 'ZAR',
    rate: rate || '', amount_zar: cur === 'ZAR' ? amt : Math.round(amt * rate * 100) / 100,
    account: form.account, to_account: type.id === 'transfer' ? (form.to_account || form.account) : '',
    fund: form.fund, to_fund: type.id === 'transfer' && form.moveFund ? form.to_fund : '',
    category: type.id === 'transfer' || type.id === 'opening' || type.held ? '' : form.category,
    person: form.person || '', fee: num(form.fee) || '', note: form.note.trim(),
  };
  if (form.planned) tx.planned = form.planned;
  if (pocketMode()) pocketRow(tx);
  const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await api('addTransaction', tx);
    tx.id = res.id; tx.created_at = new Date().toISOString();
    state.txs.push(tx); store.setJSON('cacheTxs', state.txs);
    // Remember choices for next time.
    const last = store.getJSON('lastEntry', {});
    last.type = type.id; last.account = form.account; last.cats = last.cats || {};
    if (tx.category) last.cats[type.id] = tx.category;
    store.setJSON('lastEntry', last);
    if (form.account && form.fund && !form.fundFrom) { const fb = store.getJSON('fundByAccount', {}); fb[form.account] = form.fund; store.setJSON('fundByAccount', fb); }
    toast(`Saved ${money(amt, cur)}`);
    const fromPlan = !!tx.planned && (byId(state.planned, tx.planned) || {}).kind === 'bill';
    resetForm(type.id);
    location.hash = fromPlan ? '#plan' : '#home';
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save';
    msg.className = 'hint err'; msg.textContent = 'Not saved: ' + e.message;
  }
}

// Settle through the person's own pocket (Dada Guna): one Paid back / Got back row whose
// to_account is the pocket. It moves the money between the pockets and clears the debt.
function pocketRow(tx) {
  const pk = form.pdebt.pocket;
  return Object.assign(tx, { to_account: pk.account, to_fund: pk.fund !== tx.fund ? pk.fund : '', category: '' });
}

// ---------- Split payments ----------
// One bank or cash payment made of parts. Each part is saved as its own row (so balances and
// reports work as before), and all rows of one payment share a group_id.

const PART_TYPES = { out: ['expense', 'payment', 'gift', 'advance', 'loan', 'bring_back', 'payback', 'keep_used'],
  in: ['income', 'keep', 'transfer', 'repayment', 'borrow'] };
const SPLIT_TYPES = new Set([...PART_TYPES.out, ...PART_TYPES.in].filter(id => id !== 'transfer'));
const PART_LABEL = { expense: 'Spent', income: 'Income', transfer: 'My own money' };
const HELD_FUND_HINT = 'Fund: whose money it is. Pick their fund if they have one (Dada Guna, Agricoop); otherwise keep Personal.';
// A "My own money" part is a transfer row: from another account (e.g. Cash ZAR) into this one.
// Its account is where the money came from, so the payment's own account is its to_account.
const rowAcc = t => t.type === 'transfer' ? t.to_account : t.account;
const groupOut = cash => { const t = cash.find(x => x.type !== 'transfer'); return !!t && typeOf(t.type).dir < 0; };
// Where "My own money" can come from: rand accounts and pockets other than this payment's account.
const ownFrom = () => postable().filter(a => accCurrency(a.id) === 'ZAR' && topOf(a.id) !== split.account);
const round2 = x => Math.round(x * 100) / 100;
const topOf = id => { const a = byId(L.accounts(), id); return a && a.parent ? a.parent : (id || ''); };
// "From" choices: rand accounts that hold money (TymeBank, Cash ZAR, …).
const fromAccounts = () => L.accounts().filter(a => !a.parent && isActive(a) && (a.currency || 'ZAR') === 'ZAR');
// Where a part can come from: the pockets of the account, or the account itself.
const pocketsOf = top => {
  const kids = L.accounts().filter(c => c.parent === top && isActive(c));
  return kids.length ? kids : L.accounts().filter(a => a.id === top);
};
const groupRows = gid => state.txs.filter(t => t.group_id === gid);
const cashRows = rows => rows.filter(t => t.type !== 'advance_used');

const split = { ready: false };
let splitSeed = null;

function newPart() {
  const pockets = pocketsOf(split.account);
  const used = split.parts ? split.parts.map(p => p.pocket) : [];
  const pocket = (pockets.find(p => !used.includes(p.id)) || pockets[0] || {}).id || '';
  const type = split.mode === 'in' ? 'income' : 'expense';
  const pf = split.paid_to ? personFund(split.paid_to) : '';
  return { type, amount: '', pocket, fund: pf || fundFor(pocket), fundFrom: pf ? split.paid_to : '', category: '', person: split.paid_to || '', advance: '', note: '', from: '' };
}

function startSplit(args) {
  const [kind, id] = args;
  for (const k of Object.keys(split)) delete split[k];
  if (kind === 'draft') {
    const d = state.drafts.find(x => x.id === id);
    if (!d) return false;
    try { Object.assign(split, JSON.parse(d.data)); } catch (e) { return false; }
    split.draftId = id;
  } else if (kind === 'edit') {
    const rows = state.txs.filter(t => t.group_id === id);
    if (!rows.length) { const t = state.txs.find(x => x.id === id); if (t) rows.push(t); }
    if (!rows.length) return false;
    Object.assign(split, fromRows(rows));
  } else {
    const seed = splitSeed || {};
    splitSeed = null;
    const last = store.getJSON('lastEntry', {});
    const accs = fromAccounts();
    const account = seed.account || (last.account && topOf(last.account)) || (accs[0] && accs[0].id) || '';
    Object.assign(split, { mode: seed.mode || 'out', total: seed.total || '', date: seed.date || localDay(new Date()),
      account: accs.some(a => a.id === account) ? account : ((accs[0] && accs[0].id) || ''),
      paid_to: '', note: seed.note || '', fee: seed.fee || '', fee_part: 0, parts: [], receipt: seed.receipt || null });
    split.parts = seed.parts && seed.parts.length
      ? seed.parts.map(p => Object.assign(newPart(), p, { pocket: p.pocket || newPart().pocket }))
      : [newPart()];
  }
  if (split.open === undefined) split.open = 0;
  split.ready = true;
  return true;
}

// Rebuild the form from saved rows (for Edit).
function fromRows(rows) {
  const cash = cashRows(rows), adv = rows.filter(t => t.type === 'advance_used');
  const notes = [...new Set(cash.map(t => t.note || ''))];
  const common = notes.length === 1 ? notes[0] : '';
  const parts = cash.map(t => ({ type: t.type, amount: String(num(t.amount)), pocket: rowAcc(t), fund: t.fund,
    category: t.category || '', person: t.person || '', advance: '', note: common ? '' : (t.note || ''),
    from: t.type === 'transfer' ? t.account : '' }));
  for (const a of adv) {
    const p = parts.find(p => p.type === 'payment' && p.person === a.person && p.fund === a.fund && !p.advance);
    if (p) p.advance = String(num(a.amount));
  }
  const feeIdx = cash.findIndex(t => num(t.fee));
  return {
    mode: groupOut(cash) ? 'out' : 'in',
    total: String(round2(cash.reduce((s, t) => s + num(t.amount), 0))),
    date: rows[0].date, account: topOf(rowAcc(cash[0])), paid_to: rows[0].paid_to || '', note: common,
    fee: feeIdx >= 0 ? String(num(cash[feeIdx].fee)) : '', fee_part: Math.max(feeIdx, 0),
    parts, editGroup: rows[0].group_id || '', editIds: rows.map(t => t.id), open: null,
    receipt: (rows.find(t => t.receipt_url) || {}).receipt_url ? { url: rows.find(t => t.receipt_url).receipt_url, items: [] } : null,
  };
}

const splitLeft = () => round2(num(split.total) - split.parts.reduce((s, p) => s + num(p.amount), 0));
function leftHtml() {
  const left = splitLeft();
  if (!num(split.total)) return split.receipt && split.receipt.pending ? '<span>The total comes from the receipt</span>' : '<span>Type the total first</span>';
  if (left === 0) return `<span>Left</span><b>${money(0)} ✓</b>`;
  if (left < 0) return `<span>Over by</span><b>${money(-left)}</b>`;
  return `<span>Left</span><b>${money(left)}</b>`;
}
function updateLeft() {
  const el = $('left-box'); if (!el) return;
  const left = splitLeft();
  el.innerHTML = leftHtml();
  el.className = 'left-box' + (num(split.total) && left === 0 ? ' done' : left < 0 ? ' over' : '');
}

// What a part looks like folded: "R500 · Dada Guna · Gift · Tumelo".
function partSummary(p) {
  const type = typeOf(p.type);
  const what = type.person || type.who ? (PART_LABEL[p.type] || type.label) : (nameOf(L.categories(), p.category) || PART_LABEL[p.type] || type.label);
  const where = p.type === 'transfer' ? `From ${accName(p.from) || '?'}` : nameOf(L.accounts(), p.pocket);
  const bits = [where, nameOf(L.funds(), p.fund), what, p.person ? nameOf(L.people(), p.person) : ''];
  return { amt: num(p.amount), line: bits.filter(Boolean).join(' · '),
    extra: num(p.advance) ? `earned ${money(num(p.amount) + num(p.advance))} − advance ${money(num(p.advance))}` : (p.note || '') };
}

function renderSplit(v, args) {
  if (!state.lists) { v.innerHTML = `<header><h1>Split payment</h1></header><p class="muted">${state.loading ? 'Loading lists…' : 'Lists not loaded yet. Check Settings.'}</p>`; return; }
  if (!split.ready && !startSplit(args)) {
    v.innerHTML = `<header><h1>Split payment</h1></header><p class="muted">${state.loading ? 'Loading…' : 'Not found. It may have been saved or deleted.'}</p><p><a class="link" href="#home">‹ Home</a></p>`;
    return;
  }
  const out = split.mode !== 'in';
  const b = balances();
  const funds = L.funds().filter(isActive);
  const people = L.people().filter(isActive);
  const pockets = pocketsOf(split.account);
  const accs = fromAccounts();
  const typeItems = PART_TYPES[split.mode].map(id => ({ id, label: PART_LABEL[id] || typeOf(id).label }));

  const partHtml = (p, i) => {
    if (i !== split.open) {
      const s = partSummary(p);
      return `<div class="part" data-open="${i}"><div class="l"><div class="t1">${i + 1}. ${num(p.amount) ? money(s.amt) : '<span class="muted">no amount</span>'}</div>
        <div class="t2">${esc(s.line)}${s.extra ? '<br>' + esc(s.extra) : ''}</div></div>
        ${split.parts.length > 1 ? `<button type="button" class="x" data-remove="${i}" aria-label="Remove part">×</button>` : ''}</div>`;
    }
    const type = typeOf(p.type), isOwn = p.type === 'transfer';
    const cats = L.categories().filter(isActive).filter(c => { const k = String(c.kind || 'both'); return k === 'both' || (out ? k === 'expense' : k === 'income'); });
    const owed = p.person ? (b.person[p.person + '|' + (p.fund || '')] || 0) : 0;
    const showAdv = p.type === 'payment' && p.person && (owed > 0 || num(p.advance));
    return `<div class="part open">
      <div class="part-head"><b>Part ${i + 1}</b>${split.parts.length > 1 ? `<button type="button" class="link danger" data-remove="${i}">Remove</button>` : ''}</div>
      <div class="amount-wrap small-amt"><span>R</span><input id="p-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(p.amount)}"></div>
      ${calcRow('p-amount')}
      <button type="button" class="link" id="fill-rest">Fill the rest</button>
      ${pockets.length > 1 ? `<div class="lbl">Pocket</div>${chips('pocket', pockets, p.pocket)}` : ''}
      <div class="lbl">What</div>${chips('ptype', typeItems, p.type)}
      <div class="hint">${esc(isOwn ? 'Your own money put in from another account. The fee can be paid from it too.' : (type.hint || ''))}</div>
      ${isOwn ? `<div class="lbl">From</div>${chips('from', ownFrom().map(a => ({ id: a.id, name: accName(a.id).replace(/^TymeBank /, 'Tyme ') })), p.from)}` : `
      <div class="lbl">Person${type.person || type.who ? '' : ' (optional)'}</div>${chips('person', people, p.person, type.person || type.who ? { add: true } : { none: 'No one', add: true })}
      ${type.person || type.held ? '' : `<div class="lbl">Category</div>${chips('category', cats, p.category)}`}`}
      <div class="lbl">Fund (whose money)</div>${chips('fund', funds, p.fund)}
      ${type.held ? `<div class="hint">${HELD_FUND_HINT}</div>` : ''}
      ${p.fundFrom && p.fundFrom === p.person ? `<div class="hint">Last used with ${esc(nameOf(L.people(), p.person))}.</div>` : ''}
      ${showAdv ? `<label for="p-advance">Advance deducted (R)</label>
        <input id="p-advance" inputmode="decimal" placeholder="0.00" value="${esc(p.advance)}">
        <div class="hint">${owed > 0 ? `${esc(nameOf(L.people(), p.person))} owes this fund ${money(owed)}. ` : ''}Earned = paid now + advance.${owed > 0 && !num(p.advance) ? ` <button type="button" class="link" id="use-adv">Deduct ${money(owed)}</button>` : ''}</div>` : ''}
      <label for="p-note">Part note (optional)</label>
      <input id="p-note" placeholder="e.g. trips 1–15 Nov" value="${esc(p.note)}" enterkeyhint="done">
      <button type="button" class="ghost" id="done-part">Done with this part</button>
    </div>`;
  };

  const feePockets = split.parts.map((p, i) => ({ id: String(i), label: `${i + 1}. ${p.type === 'transfer' ? accName(p.from) || 'My own money' : nameOf(L.accounts(), p.pocket)}` }));
  v.innerHTML = `
    <header><h1>${split.editGroup || split.editIds ? 'Edit payment' : 'Split payment'}</h1></header>
    <form id="split-form" autocomplete="off">
      ${smsBox()}
      ${receiptBox()}
      ${chips('mode', [{ id: 'out', label: 'Money out' }, { id: 'in', label: 'Money in' }], split.mode)}
      <label for="s-total">Total ${out ? 'paid' : 'received'}</label>
      <div class="amount-wrap"><span>R</span><input id="s-total" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(split.total)}"></div>
      ${calcRow('s-total')}
      <div class="lbl">${out ? 'From' : 'Into'}</div>${chips('account', accs, split.account)}
      <div class="lbl">${out ? 'Paid to' : 'Received from'} (optional)</div>${chips('paid_to', people, split.paid_to, { none: 'No one', add: true })}
      <div id="left-box"></div>
      <div class="parts">${split.parts.map(partHtml).join('')}</div>
      <button type="button" class="ghost" id="add-part">+ Add part</button>
      <div class="two">
        <div><label for="s-date">Date</label><input id="s-date" type="date" value="${esc(split.date)}"></div>
        <div><label for="s-fee">Bank fee (R)</label><input id="s-fee" inputmode="decimal" placeholder="0.00" value="${esc(split.fee)}"></div>
      </div>
      ${/^tyme/.test(split.account) ? '<button type="button" class="link" id="sms-fee">+ R0.50 SMS fee</button>' : ''}
      ${num(split.fee) && split.parts.length > 1 ? `<div class="lbl">Fee taken from</div>${chips('fee_part', feePockets, String(split.fee_part || 0))}` : ''}
      <label for="s-note">Note</label>
      <input id="s-note" placeholder="e.g. Tumelo, November" value="${esc(split.note)}" enterkeyhint="done">
      <button class="primary" id="save" type="submit">Save</button>
      <button type="button" class="ghost" id="save-draft">Save as draft</button>
      ${split.draftId ? '<button type="button" class="ghost danger" id="del-draft">Delete draft</button>' : ''}
      <p id="form-msg" class="hint"></p>
    </form>`;
  updateLeft();

  const sync = () => {
    split.total = $('s-total').value; split.date = $('s-date').value; split.fee = $('s-fee').value; split.note = $('s-note').value;
    const p = split.parts[split.open];
    if (p && $('p-amount')) {
      p.amount = $('p-amount').value; p.note = $('p-note').value;
      if ($('p-advance')) p.advance = $('p-advance').value;
    }
  };
  const redraw = () => { renderSplit(v, args); };
  $('s-total').oninput = () => { split.total = $('s-total').value; updateLeft(); };
  wireCalc('s-total', () => { split.total = $('s-total').value; updateLeft(); });
  if ($('p-amount')) {
    $('p-amount').oninput = () => { split.parts[split.open].amount = $('p-amount').value; updateLeft(); };
    wireCalc('p-amount', () => { split.parts[split.open].amount = $('p-amount').value; updateLeft(); });
  }
  if ($('fill-rest')) $('fill-rest').onclick = () => {
    sync(); const p = split.parts[split.open];
    const rest = round2(num(p.amount) + splitLeft());
    p.amount = rest > 0 ? String(rest) : ''; redraw();
  };
  if ($('use-adv')) $('use-adv').onclick = () => {
    sync(); const p = split.parts[split.open];
    p.advance = String(b.person[p.person + '|' + p.fund] || ''); redraw();
  };
  if ($('done-part')) $('done-part').onclick = () => { sync(); split.open = null; redraw(); };
  $('add-part').onclick = () => {
    sync(); const p = newPart(); const left = splitLeft();
    if (left > 0) p.amount = String(left);
    split.parts.push(p); split.open = split.parts.length - 1; redraw();
    const el = $('p-amount'); if (el) el.scrollIntoView({ block: 'center' });
  };
  v.querySelectorAll('[data-open]').forEach(el => el.onclick = e => {
    if (e.target.closest('[data-remove]')) return;
    sync(); split.open = Number(el.dataset.open); redraw();
  });
  split.syncFn = sync;
  v.querySelectorAll('[data-item]').forEach(el => el.onclick = () => { sync(); moveReceiptItem(Number(el.dataset.item)); split.open = null; redraw(); });
  if ($('rc-retry')) $('rc-retry').onclick = () => { sync(); readInto(split.receipt); redraw(); };
  v.querySelectorAll('[data-attach]').forEach(el => el.onclick = async () => {
    const r = split.receipt, m = r.matches[Number(el.dataset.attach)];
    const rows = m.g ? groupRows(m.g) : state.txs.filter(t => t.id === m.id);
    if (!rows.length) return;
    el.disabled = true; el.textContent = 'Attaching…';
    try {
      await attachReceipt(r, rows, r.items.map(it => Object.assign({}, it, { part: '' })));
      toast('Receipt attached'); split.ready = false; split.receipt = null;
      location.hash = m.g ? '#pay/' + encodeURIComponent(m.g) : '#tx/' + encodeURIComponent(m.id);
    } catch (e) { el.disabled = false; el.textContent = 'Attach to that entry instead'; toast('Not attached: ' + needsNewScript(e), true); }
  });
  v.querySelectorAll('[data-remove]').forEach(el => el.onclick = e => {
    e.stopPropagation(); sync();
    const i = Number(el.dataset.remove);
    split.parts.splice(i, 1);
    // Items of a removed part go back to part 1.
    if (split.receipt && split.receipt.items) { split.receipt.items.forEach(it => { if (it.part === i) it.part = 0; else if (it.part > i) it.part--; }); applyReceiptItems(); }
    if (split.fee_part >= split.parts.length) split.fee_part = 0;
    split.open = null; redraw();
  });
  if ($('sms-fee')) $('sms-fee').onclick = () => { sync(); split.fee = (num(split.fee) + 0.5).toFixed(2); redraw(); };
  $('s-fee').onchange = () => { sync(); redraw(); };

  $('split-form').querySelectorAll('.chips').forEach(group => {
    group.onclick = e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      sync();
      const name = group.dataset.name;
      if (btn.dataset.add) {
        const p0 = split.parts[split.open];
        openNewPerson(p0 && p0.fund, pid => { pick(name, pid); redraw(); });
        return;
      }
      pick(name, btn.dataset.v);
      redraw();
    };
  });
  // A part's person brings the fund last used with them.
  const usePersonFund = q => {
    const pf = q.person && personFund(q.person);
    if (pf) { q.fund = pf; q.fundFrom = q.person; } else q.fundFrom = '';
  };
  function pick(name, val) {
    const p = split.parts[split.open];
    if (name === 'mode') {
      if (val !== split.mode) { split.mode = val; split.parts.forEach(q => { q.type = val === 'in' ? 'income' : 'expense'; q.advance = ''; }); }
    } else if (name === 'account') {
      if (val !== split.account) { split.account = val; split.parts.forEach(q => { q.pocket = pocketsOf(val)[0] ? pocketsOf(val)[0].id : ''; if (!(q.fundFrom && q.fundFrom === q.person)) q.fund = fundFor(q.pocket); }); }
    } else if (name === 'paid_to') {
      split.paid_to = split.paid_to === val ? '' : val;
      // A new part for this person starts with them as the person.
      split.parts.forEach(q => { if (!q.person && val) { q.person = val; usePersonFund(q); } });
    } else if (name === 'fee_part') {
      split.fee_part = Number(val);
    } else if (p) {
      if (name === 'pocket') { p.pocket = val; if (p.type !== 'transfer' && !(p.fundFrom && p.fundFrom === p.person)) p.fund = fundFor(val); }
      else if (name === 'from') { p.from = val; p.fund = fundFor(val); }
      else if (name === 'ptype') {
        p.type = val; const t = typeOf(val);
        if (t.cat) p.category = t.cat; else if (t.person || t.held) p.category = '';
        if (val !== 'payment') p.advance = '';
        if (val === 'transfer') {
          // My own money: from Cash ZAR (or the first other account), Personal, no person; it pays the fee.
          const own = ownFrom();
          p.from = p.from || ((own.find(a => a.id === 'cash-zar') || own[0] || {}).id || '');
          p.person = ''; p.category = ''; p.fund = fundFor(p.from); p.fundFrom = '';
          split.fee_part = split.open;
        }
      } else if (name === 'person') { p.person = p.person === val && !(typeOf(p.type).person || typeOf(p.type).who) ? '' : val; usePersonFund(p); }
      else { p[name] = val; if (name === 'fund') p.fundFrom = ''; }
    }
  }

  $('split-form').onsubmit = async e => { e.preventDefault(); sync(); await savePayment(); };
  $('save-draft').onclick = async () => { sync(); await saveDraft(); };
  if ($('del-draft')) $('del-draft').onclick = async () => {
    if (!confirm('Delete this draft?')) return;
    try {
      await api('deleteDraft', { id: split.draftId });
      state.drafts = state.drafts.filter(d => d.id !== split.draftId); store.setJSON('cacheDrafts', state.drafts);
      toast('Draft deleted'); location.hash = '#home';
    } catch (err) { toast('Not deleted: ' + err.message, true); }
  };
}

function validateSplit() {
  if (split.receipt && split.receipt.pending) return 'Still reading the receipt. A few more seconds…';
  if (hasOp(split.total) && evalExpr(split.total) === null) return 'That sum does not work out. Check the total.';
  if (!(num(split.total) > 0)) return 'Type the total.';
  if (!split.date) return 'Pick a date.';
  if (!split.account) return 'Pick the account.';
  for (let i = 0; i < split.parts.length; i++) {
    const p = split.parts[i], t = typeOf(p.type), n = `Part ${i + 1}: `;
    if (hasOp(p.amount) && evalExpr(p.amount) === null) return n + 'that sum does not work out.';
    if (!(num(p.amount) > 0)) return n + 'enter an amount.';
    if (!p.pocket) return n + 'pick the pocket.';
    if (!p.fund) return n + 'pick the fund.';
    if (p.type === 'transfer') {
      if (!p.from || topOf(p.from) === split.account) return n + 'pick where your money came from.';
      continue;
    }
    if ((t.person || t.who) && !p.person) return n + 'pick the person.';
    if (!t.person && !t.held && !p.category) return n + 'pick a category.';
    if (num(p.advance) < 0) return n + 'the advance can\'t be negative.';
  }
  const left = splitLeft();
  if (left > 0) return `${money(left)} is not assigned yet. Add a part, or save as draft.`;
  if (left < 0) return `The parts are ${money(-left)} more than the total.`;
  return '';
}

function splitRows() {
  const rows = [];
  split.parts.forEach((p, i) => {
    const amt = round2(num(p.amount));
    const base = { date: split.date, currency: 'ZAR', rate: '', fund: p.fund, to_account: '', to_fund: '',
      category: typeOf(p.type).person && !p.category ? '' : p.category, person: p.person || '',
      paid_to: split.paid_to || '', receipt_url: split.receipt ? split.receipt.url : '', source: split.sms ? 'sms' : 'app' };
    const own = p.type === 'transfer';
    rows.push(Object.assign({}, base, { type: p.type, amount: amt, amount_zar: amt,
      account: own ? p.from : p.pocket, to_account: own ? p.pocket : '',
      category: own || typeOf(p.type).held ? '' : base.category, person: own ? '' : base.person,
      fee: i === (split.fee_part || 0) && num(split.fee) ? round2(num(split.fee)) : '',
      note: (p.note || split.note || '').trim() }));
    const adv = round2(num(p.advance));
    if (p.type === 'payment' && adv > 0) {
      rows.push(Object.assign({}, base, { type: 'advance_used', amount: adv, amount_zar: adv, account: '', fee: '',
        note: `Advance deducted from payment${p.note ? ' (' + p.note.trim() + ')' : ''}` }));
    }
  });
  return rows;
}

const needsNewScript = e => /Unknown action/.test(e.message) ? 'This needs the updated Apps Script (see the update notes).' : e.message;

async function savePayment() {
  const msg = $('form-msg');
  const problem = validateSplit();
  if (problem) { msg.className = 'hint err'; msg.textContent = problem; return; }
  const rows = splitRows();
  const btn = $('save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await api('savePayment', { group_id: split.editGroup || '', replace_ids: split.editIds || [], draft_id: split.draftId || '', rows });
    rows.forEach((r, i) => Object.assign(r, { id: res.ids[i], group_id: res.group_id, created_at: res.created_at }));
    const old = new Set(split.editIds || []);
    state.txs = state.txs.filter(t => !old.has(t.id) && !(split.editGroup && t.group_id === split.editGroup)).concat(rows);
    store.setJSON('cacheTxs', state.txs);
    if (split.draftId) { state.drafts = state.drafts.filter(d => d.id !== split.draftId); store.setJSON('cacheDrafts', state.drafts); }
    const fb = store.getJSON('fundByAccount', {});
    split.parts.forEach(p => { if (p.pocket && p.fund && !p.fundFrom && p.type !== 'transfer' && !typeOf(p.type).held) fb[p.pocket] = p.fund; });
    store.setJSON('fundByAccount', fb);
    const r = split.receipt;
    if (r && (r.url || r._file)) {
      const p0 = split.parts[0] || {};
      store.setJSON('lastScan', { account: split.account, pocket: p0.pocket, fund: p0.fund, category: p0.category });
      if (r.file_id || r._file) {
        try { await attachReceipt(r, rows, (r.items || []).map(it => Object.assign({}, it, { part: it.part + 1 }))); }
        catch (e) { toast('Saved, but the receipt name and items were not saved: ' + e.message, true); }
      }
    }
    toast(`Saved ${money(num(split.total))}`);
    split.ready = false;
    location.hash = '#pay/' + encodeURIComponent(res.group_id);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save';
    msg.className = 'hint err'; msg.textContent = 'Not saved: ' + needsNewScript(e);
  }
}

async function saveDraft() {
  const msg = $('form-msg');
  if (split.receipt && split.receipt.pending) { msg.className = 'hint err'; msg.textContent = 'Still reading the receipt. A few more seconds…'; return; }
  const data = {};
  for (const k of ['mode', 'total', 'date', 'account', 'paid_to', 'note', 'fee', 'fee_part', 'parts', 'editGroup', 'editIds', 'receipt', 'sms']) data[k] = split[k];
  const btn = $('save-draft'); btn.disabled = true; btn.textContent = 'Saving draft…';
  try {
    // A draft keeps its receipt in Drive (it can't hold the file itself).
    const r = split.receipt;
    if (r && r._file) {
      const res = await api('attachReceipt', { b64: r._file.b64, mime: r._file.mime, ids: [], items: [],
        name: receiptFileName(r, split.date, num(split.total), '') });
      r.url = res.url; r.file_id = res.file_id; delete r._file;
      data.receipt = r;
    }
    const d = await api('saveDraft', { id: split.draftId || '', data: JSON.stringify(data) });
    state.drafts = state.drafts.filter(x => x.id !== d.id).concat([d]); store.setJSON('cacheDrafts', state.drafts);
    toast('Draft saved');
    split.ready = false;
    location.hash = '#home';
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save as draft';
    msg.className = 'hint err'; msg.textContent = 'Draft not saved: ' + needsNewScript(e);
  }
}

function draftInfo(d) {
  let x = {};
  try { x = JSON.parse(d.data); } catch (e) {}
  const total = num(x.total), parts = x.parts || [];
  const left = round2(total - parts.reduce((s, p) => s + num(p.amount), 0));
  const who = x.paid_to ? nameOf(L.people(), x.paid_to) : (x.note || (x.sms ? 'TymeBank SMS' : 'Split payment'));
  const status = x.sms && parts.some(p => !p.pocket) ? 'from SMS · pick the pocket'
    : left ? money(left) + ' left to assign' : 'ready to save';
  return { total, left, who, date: x.date, status, at: (x.sms && x.sms.at) || d.updated_at || '' };
}

// One payment, all parts.
function renderPay(v, gid) {
  gid = decodeURIComponent(gid || '');
  const rows = groupRows(gid);
  if (!rows.length) { v.innerHTML = '<header><h1>Payment</h1></header><p class="muted">Payment not found.</p><p><a class="link" href="#home">‹ Home</a></p>'; return; }
  const cash = cashRows(rows), adv = rows.filter(t => t.type === 'advance_used');
  const out = groupOut(cash);
  const total = cash.reduce((s, t) => s + num(t.amount), 0);
  const fee = cash.reduce((s, t) => s + num(t.fee), 0);
  const b = balances();
  const notes = [...new Set(cash.map(t => t.note || ''))];
  const partLine = (t, i) => {
    const type = typeOf(t.type);
    const a = adv.find(x => x.person === t.person && x.fund === t.fund && t.type === 'payment');
    const what = type.person || type.who ? (PART_LABEL[t.type] || type.label) : (nameOf(L.categories(), t.category) || PART_LABEL[t.type] || type.label);
    const bits = [t.type === 'transfer' ? `From ${accName(t.account)}` : nameOf(L.accounts(), t.account), nameOf(L.funds(), t.fund), what, t.person ? nameOf(L.people(), t.person) : ''].filter(Boolean);
    const owed = t.person ? (b.person[t.person + '|' + t.fund] || 0) : 0;
    const back = t.type === 'bring_back' && owed > 0 ? Math.min(owed, num(t.amount)) : 0;
    return `<div class="part"><div class="l"><div class="t1">${i + 1}. ${money(num(t.amount))}</div>
      <div class="t2">${esc(bits.join(' · '))}${notes.length > 1 && t.note ? '<br>' + esc(t.note) : ''}
      ${a ? `<br>earned ${money(num(t.amount) + num(a.amount))} − advance ${money(num(a.amount))}` : ''}
      ${num(t.fee) ? `<br>bank fee ${money(num(t.fee))}` : ''}</div>
      ${back ? `<button type="button" class="ghost" data-back="${esc(t.id)}" data-amt="${back}">${esc(nameOf(L.people(), t.person))} brought ${money(back)} → Cash ZAR</button>` : ''}
      ${t.type === 'bring_back' && owed <= 0 ? '<div class="t2 ok">Brought back</div>' : ''}</div></div>`;
  };
  v.innerHTML = `
    <header><h1>${out ? 'Payment' : 'Money in'}</h1></header>
    <div class="card pad"><dl>
      <dt>Total</dt><dd><b>${money(total)}</b>${fee ? ` + fee ${money(fee)}` : ''}</dd>
      <dt>Date</dt><dd>${esc(niceDate(rows[0].date))}</dd>
      <dt>${out ? 'From' : 'Into'}</dt><dd>${esc(nameOf(L.accounts(), topOf(rowAcc(cash[0]))))}</dd>
      ${rows[0].paid_to ? `<dt>${out ? 'Paid to' : 'Received from'}</dt><dd>${esc(nameOf(L.people(), rows[0].paid_to))}</dd>` : ''}
      ${notes.length === 1 && notes[0] ? `<dt>Note</dt><dd>${esc(notes[0])}</dd>` : ''}
    </dl></div>
    <h2>${cash.length} part${cash.length === 1 ? '' : 's'}</h2>
    <div class="card">${cash.map(partLine).join('')}</div>
    ${receiptButtons(rows)}
    <button class="ghost" id="edit">Edit payment</button>
    <button class="ghost danger" id="del">Delete payment</button>
    <button class="ghost" onclick="history.back()">Back</button>`;
  $('edit').onclick = () => { split.ready = false; location.hash = '#split/edit/' + encodeURIComponent(gid); };
  bindReceiptButtons(rows, () => renderPay(v, gid));
  $('del').onclick = async () => {
    if (!confirm(`Delete this payment and all ${rows.length} of its rows?`)) return;
    try {
      await api('deletePayment', { group_id: gid });
      state.txs = state.txs.filter(t => t.group_id !== gid); store.setJSON('cacheTxs', state.txs);
      toast('Deleted'); location.hash = '#home';
    } catch (e) { toast('Not deleted: ' + needsNewScript(e), true); }
  };
  v.querySelectorAll('[data-back]').forEach(el => el.onclick = async () => {
    const part = rows.find(t => t.id === el.dataset.back);
    const amt = num(el.dataset.amt);
    const cashAcc = L.accounts().find(a => a.id === 'cash-zar') ? 'cash-zar' : '';
    if (!cashAcc || !confirm(`${nameOf(L.people(), part.person)} brought ${money(amt)} in cash? It goes into Cash ZAR.`)) return;
    const tx = { date: localDay(new Date()), type: 'repayment', amount: amt, currency: 'ZAR', rate: '', amount_zar: amt,
      account: cashAcc, to_account: '', fund: part.fund, to_fund: '', category: '', person: part.person, fee: '',
      note: `Cash brought back (payment of ${part.date})`, source: 'app' };
    el.disabled = true;
    try {
      const res = await api('addTransaction', tx);
      tx.id = res.id; tx.created_at = new Date().toISOString();
      state.txs.push(tx); store.setJSON('cacheTxs', state.txs);
      toast(`${money(amt)} added to Cash ZAR`); renderPay(v, gid);
    } catch (e) { el.disabled = false; toast('Not saved: ' + e.message, true); }
  });
}

// ---------- Entry list and detail ----------

const listFilter = { q: '', account: '', fund: '', person: '', month: '' };
function renderList(v) {
  const months = [...new Set(state.txs.map(t => (t.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const opt = (arr, val, all) => `<option value="">${all}</option>` + arr.map(r => `<option value="${esc(r.id)}" ${r.id === val ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const showParts = !!(listFilter.account || listFilter.fund || listFilter.person);
  const all = sortedTxs();
  const rows = all.filter(t => {
    if (listFilter.account && t.account !== listFilter.account && t.to_account !== listFilter.account) return false;
    if (listFilter.fund && t.fund !== listFilter.fund && t.to_fund !== listFilter.fund) return false;
    if (listFilter.person && t.person !== listFilter.person) return false;
    if (listFilter.month && !(t.date || '').startsWith(listFilter.month)) return false;
    if (listFilter.q) {
      const hay = [t.note, accName(t.account), nameOf(L.categories(), t.category), nameOf(L.people(), t.person), nameOf(L.people(), t.paid_to), nameOf(L.funds(), t.fund), t.amount].join(' ').toLowerCase();
      if (!hay.includes(listFilter.q.toLowerCase())) return false;
    }
    return true;
  });
  const items = listItems(rows, showParts);
  const accOpts = postable().map(a => ({ id: a.id, name: accName(a.id) }));
  v.innerHTML = `
    <header><h1>Entries</h1><button class="refresh" id="refresh">↻ Refresh</button></header>
    <input id="q" type="search" placeholder="Search" value="${esc(listFilter.q)}">
    <div class="filters">
      <select id="fl-month"><option value="">All months</option>${months.map(m => `<option ${m === listFilter.month ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <select id="fl-account">${opt(accOpts, listFilter.account, 'All accounts')}</select>
    </div>
    <div class="filters">
      <select id="fl-fund">${opt(L.funds(), listFilter.fund, 'All funds')}</select>
      <select id="fl-person">${opt(L.people(), listFilter.person, 'All people')}</select>
    </div>
    <p class="muted small">${items.length} entr${items.length === 1 ? 'y' : 'ies'}</p>
    <div class="card">${items.length ? items.slice(0, 300).map(itemRow).join('') : '<div class="empty small">Nothing found.</div>'}</div>`;
  $('refresh').onclick = refresh;
  $('q').oninput = e => { listFilter.q = e.target.value; const pos = e.target.selectionStart; renderList(v); const q = $('q'); q.focus(); q.setSelectionRange(pos, pos); };
  ['month', 'account', 'fund', 'person'].forEach(k => $('fl-' + k).onchange = e => { listFilter[k] = e.target.value; renderList(v); });
  bindTxRows(v);
}

function renderTx(v, id) {
  id = decodeURIComponent(id || '');
  const t = state.txs.find(x => x.id === id);
  if (!t) { v.innerHTML = '<header><h1>Entry</h1></header><p class="muted">Entry not found.</p><p><a class="link" href="#home">‹ Home</a></p>'; return; }
  if (t.group_id) { renderPay(v, encodeURIComponent(t.group_id)); return; }
  const type = typeOf(t.type), cur = accCurrency(t.account);
  const canEdit = SPLIT_TYPES.has(type.id) && !pocketSettle(t) && t.account && accCurrency(t.account) === 'ZAR' && fromAccounts().some(a => a.id === topOf(t.account));
  const item = (k, val) => val === '' || val == null ? '' : `<dt>${k}</dt><dd>${esc(val)}</dd>`;
  v.innerHTML = `
    <header><h1>${esc(type.label)}</h1></header>
    <div class="card pad"><dl>
      ${item('Amount', money(num(t.amount), cur) + (cur !== 'ZAR' && num(t.amount_zar) ? ' (' + money(num(t.amount_zar)) + ')' : ''))}
      ${item('Date', niceDate(t.date))}
      ${pocketSettle(t) ? item('Money', pocketPath(t)) : item(isMove(t) ? 'From' : 'Account', accName(t.account))}
      ${isMove(t) ? item('To', accName(t.to_account)) : ''}
      ${item('Fund', nameOf(L.funds(), t.fund))}
      ${item('To fund', nameOf(L.funds(), t.to_fund))}
      ${item('Category', nameOf(L.categories(), t.category))}
      ${item('Person', nameOf(L.people(), t.person))}
      ${item('Rate', t.rate)}
      ${num(t.fee) ? item('Bank fee', money(num(t.fee))) : ''}
      ${item('Note', t.note)}
    </dl></div>
    ${receiptButtons([t])}
    ${canEdit ? '<button class="ghost" id="edit">Edit or split</button>' : ''}
    <button class="ghost danger" id="del">Delete entry</button>
    <button class="ghost" onclick="history.back()">Back</button>`;
  if ($('edit')) $('edit').onclick = () => { split.ready = false; location.hash = '#split/edit/' + encodeURIComponent(t.id); };
  bindReceiptButtons([t], () => renderTx(v, encodeURIComponent(t.id)));
  $('del').onclick = async () => {
    if (!confirm('Delete this entry?')) return;
    try {
      await api('deleteTransaction', { id: t.id });
      state.txs = state.txs.filter(x => x.id !== t.id); store.setJSON('cacheTxs', state.txs);
      toast('Deleted'); location.hash = '#home';
    } catch (e) {
      toast(/Unknown action/.test(e.message) ? 'Delete needs the updated Apps Script (see Settings). For now, delete the row in the sheet.' : 'Not deleted: ' + e.message, true);
    }
  };
}

// ---------- Receipts ----------
// "Scan receipt": pick a scanned PDF or take a photo. The Apps Script saves it in Drive (Receipts
// folder) and reads shop, date, total and items with OpenAI. The app then opens the payment screen
// filled in, or attaches the receipt to an entry that is already there (same amount, within 3 days).

const pickFile = () => new Promise(resolve => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,image/*';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = () => { const f = inp.files && inp.files[0]; inp.remove(); resolve(f || null); };
  inp.click();
});

const fileB64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});

// Photos are made smaller (longest side 1600px) so they upload fast and cost less to read.
function photoB64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open the photo')); };
    img.src = url;
  });
}

function openSheet(html) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(bg);
  return { el: bg, close: () => bg.remove() };
}

const isPdfFile = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const tooBig = file => isPdfFile(file) && file.size > 15e6;

// Uploads the file and returns the receipt: { file_id, url, ext, shop, date, total, items, read_error }.
async function uploadReceipt(file) {
  const isPdf = isPdfFile(file);
  const b64 = isPdf ? await fileB64(file) : await photoB64(file);
  const mime = isPdf ? 'application/pdf' : 'image/jpeg';
  // Only read now; the file is saved to Drive when the entry (or draft) is saved.
  const r = await api('scanReceipt', { b64, mime, save: false });
  return { _file: { b64, mime }, file_id: r.file_id || '', url: r.url || '', ext: r.ext || (isPdf ? 'pdf' : 'jpg'), shop: r.shop || '', date: r.date || '',
    total: num(r.total) || 0, read_error: r.read_error || '',
    items: (r.items || []).map(it => ({ name: it.name, qty: it.qty, amount: num(it.amount), part: 0 })) };
}

// For "Attach receipt" on an entry: picks a file and waits for it to be read.
async function scanReceipt() {
  const file = await pickFile();
  if (!file) return null;
  if (tooBig(file)) { toast('This PDF is too big (over 15 MB).', true); return null; }
  const wait = openSheet('<h3>Reading the receipt…</h3><p class="muted">The receipt is being read. This takes about 10 seconds.</p>');
  try { return await uploadReceipt(file); }
  catch (e) { toast('Receipt not read: ' + needsNewScript(e), true); return null; }
  finally { wait.close(); }
}

const receiptNote = r => {
  const names = r.items.filter(it => num(it.amount) > 0).map(it => it.name).filter(Boolean);
  let s = (r.shop ? r.shop + (names.length ? ': ' : '') : '') + names.join(', ');
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
};
const receiptFileName = (r, date, total, person) =>
  [date, 'R' + round2(total).toFixed(2), r.shop || 'receipt', person || ''].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, '-') + '.' + (r.ext || 'pdf');

// Money-out entries that this receipt may belong to: same amount (without the bank fee), within 3 days.
// Entries that already have a receipt come back with has: true (probably this same receipt).
function receiptMatches(r) {
  if (!(r.total > 0)) return [];
  const day = r.date || localDay(new Date());
  const near = d => Math.abs((new Date(d) - new Date(day)) / 864e5) <= 3;
  return listItems(sortedTxs(), false).map(it => {
    const rows = it.t ? [it.t] : groupRows(it.g), cash = it.t ? rows : cashRows(rows);
    if (!cash.length) return null;
    const out = it.t ? typeOf(it.t.type).dir < 0 : groupOut(cash);
    const total = round2(cash.reduce((s, t) => s + num(t.amount), 0));
    if (!out || Math.abs(total - r.total) > 0.01 || !near(cash[0].date)) return null;
    return { it, rows, total, date: cash[0].date, has: rows.some(t => t.receipt_url) };
  }).filter(Boolean).slice(0, 3);
}

async function attachReceipt(r, rows, items) {
  const first = rows[0];
  const total = cashRows(rows).reduce((s, t) => s + num(t.amount), 0);
  const person = (rows.find(t => t.person) || {}).person;
  const file = !r.file_id && r._file;
  const name = r.file_id || file ? receiptFileName(r, first.date, total, person ? nameOf(L.people(), person) : '') : '';
  const res = await api('attachReceipt', Object.assign({ url: r.url, file_id: r.file_id || '', ids: rows.map(t => t.id),
    group_id: first.group_id || '', name, shop: r.shop, date: r.date || first.date, items: items || [] },
    file ? { b64: file.b64, mime: file.mime } : {}));
  if (res && res.url) { r.url = res.url; r.file_id = res.file_id || r.file_id; delete r._file; }
  rows.forEach(t => { t.receipt_url = r.url; });
  store.setJSON('cacheTxs', state.txs);
}

// Home and Add: the payment screen opens at once. While the receipt is saved and read, you pick
// pocket, fund, category and person; when it is done, total, date, note and items fill in
// (only where you haven't typed anything). A matching entry shows as "Attach instead".
const receiptFiles = new WeakMap();
async function startReceipt() {
  const file = await pickFile();
  if (!file) return;
  if (tooBig(file)) { toast('This PDF is too big (over 15 MB).', true); return; }
  const r = { pending: true, items: [], shop: '', date: '', total: 0, url: '' };
  receiptFiles.set(r, file);
  openReceiptPayment(r);
  readInto(r);
}

async function readInto(r) {
  const file = receiptFiles.get(r);
  Object.assign(r, { pending: true, failed: false, read_error: '' });
  let res;
  try { res = await uploadReceipt(file); }
  catch (e) { res = { failed: true, read_error: needsNewScript(e), items: [] }; }
  if (split.receipt !== r) return; // you left this payment; nothing was saved to Drive
  if (split.syncFn && route()[0] === 'split' && $('s-total')) split.syncFn();
  Object.assign(r, res, { pending: false });
  if (!r.failed && !r.read_error) {
    if (!num(split.total) && r.total) split.total = String(r.total);
    if (r.date && split.date === r.seedDate) split.date = r.date;
    if (!split.note.trim()) split.note = receiptNote(r);
    if (split.parts.length === 1 && !num(split.parts[0].amount) && num(split.total)) split.parts[0].amount = split.total;
    r.matches = receiptMatches(r).map(m => ({ g: m.it.g || '', id: m.it.t ? m.it.t.id : '', date: m.date,
      has: m.has, label: [niceDate(m.date), nameOf(L.accounts(), topOf(rowAcc(m.rows[0]))), money(m.total), m.rows[0].note || ''].filter(Boolean).join(' · ') }));
  }
  if (route()[0] === 'split') renderSplit($('view'), route().slice(1));
}

function openReceiptPayment(r) {
  const accs = fromAccounts();
  const tyme = accs.find(a => a.id === 'tyme');
  const last = store.getJSON('lastScan', {});
  const part = { amount: r.total ? String(r.total) : '' };
  r.seedDate = r.date || localDay(new Date());
  if (last.pocket) Object.assign(part, { pocket: last.pocket, fund: last.fund || '', category: last.category || '' });
  splitSeed = { mode: 'out', total: r.total ? String(r.total) : '', date: r.date || localDay(new Date()),
    account: last.account || (tyme && tyme.id) || '', note: r.pending ? '' : receiptNote(r), parts: [part], receipt: r };
  split.ready = false;
  if (location.hash === '#split') render(); else location.hash = '#split';
}

// Items decide the amounts of the parts they are in. If the item lines don't add up to the total
// (prices without VAT, a discount missed), each part gets its share of the total.
function applyReceiptItems() {
  const r = split.receipt;
  if (!r || !r.items || !r.items.length) return;
  // Parts made by moving items, now empty, are removed.
  for (let i = split.parts.length - 1; i > 0; i--) {
    if (split.parts[i].auto && !r.items.some(it => it.part === i)) {
      split.parts.splice(i, 1);
      r.items.forEach(it => { if (it.part > i) it.part--; });
      if (split.fee_part >= split.parts.length) split.fee_part = 0;
    }
  }
  const itemsSum = r.items.reduce((s, it) => s + num(it.amount), 0), total = num(split.total);
  if (!itemsSum || !total) return;
  const used = [...new Set(r.items.map(it => it.part))].filter(i => split.parts[i]);
  const f = total / itemsSum;
  let assigned = 0, biggest = -1;
  used.forEach(i => {
    const its = r.items.filter(it => it.part === i), p = split.parts[i];
    const a = round2(its.reduce((s, it) => s + num(it.amount), 0) * f);
    p.amount = String(a); assigned += a;
    if (split.parts.length > 1 && (!p.note || p.note === p.autoNote)) { p.autoNote = its.map(it => it.name).join(', ').slice(0, 100); p.note = p.autoNote; }
    if (biggest < 0 || a > num(split.parts[biggest].amount)) biggest = i;
  });
  if (split.parts.length === 1 && split.parts[0].note === split.parts[0].autoNote) split.parts[0].note = split.parts[0].autoNote = '';
  // Rounding cents go to the biggest part, so the parts add up to the total.
  const manual = split.parts.reduce((s, p, i) => used.includes(i) ? s : s + num(p.amount), 0);
  const diff = round2(total - manual - assigned);
  if (biggest >= 0 && Math.abs(diff) < 0.05) split.parts[biggest].amount = String(round2(num(split.parts[biggest].amount) + diff));
}

// Tapping an item's part number moves it to the next part; past the last part, a new part is made.
function moveReceiptItem(i) {
  const r = split.receipt, it = r.items[i];
  const alone = !r.items.some((x, j) => j !== i && x.part === it.part);
  let next = it.part + 1;
  if (next >= split.parts.length) {
    if (alone && split.parts.length > 1 && split.parts[it.part].auto) next = 0;
    else {
      const p = newPart();
      const src = split.parts[it.part];
      Object.assign(p, { fund: src.fund, pocket: src.pocket, category: src.category, person: src.person, auto: true });
      split.parts.push(p); next = split.parts.length - 1;
    }
  }
  it.part = next;
  applyReceiptItems();
}

// ---------- TymeBank SMS drafts ----------
// The iPhone Shortcut sends each TymeBank SMS to Apps Script, which saves it as a draft (see Code.gs smsDraft).

// TymeBank money in the app, all pockets together (the bank only knows the total).
function tymeTotal(b) {
  return round2(L.accounts().filter(a => topOf(a.id) === 'tyme').reduce((s, a) => s + (b.acc[a.id] || 0), 0));
}

// Entries already in the app for this SMS: TymeBank, same amount and direction, within 3 days.
function smsMatches() {
  const total = round2(num(split.total));
  if (!(total > 0) || !split.date) return [];
  const near = d => Math.abs((new Date(d) - new Date(split.date)) / 864e5) <= 3;
  const out = split.mode !== 'in';
  return listItems(sortedTxs(), false).map(it => {
    const rows = it.t ? [it.t] : groupRows(it.g), cash = it.t ? rows : cashRows(rows);
    if (!cash.length || topOf(rowAcc(cash[0])) !== 'tyme') return null;
    const dir = it.t ? typeOf(it.t.type).dir : (groupOut(cash) ? -1 : 1);
    if (!dir || (dir < 0) !== out) return null;
    const sum = round2(cash.reduce((s, t) => s + num(t.amount), 0));
    if (Math.abs(sum - total) > 0.01 || !near(cash[0].date)) return null;
    return { href: it.g ? '#pay/' + encodeURIComponent(it.g) : '#tx/' + encodeURIComponent(it.t.id),
      label: [niceDate(cash[0].date), money(sum), cash[0].note || ''].filter(Boolean).join(' · ') };
  }).filter(Boolean).slice(0, 3);
}

function smsBox() {
  const s = split.sms;
  if (!s) return '';
  const b = balances();
  // The bank balance only matches when this is the newest SMS still waiting.
  const newer = state.drafts.some(d => {
    if (d.id === split.draftId) return false;
    try { const x = JSON.parse(d.data); return x.sms && String(x.sms.at) > String(s.at); } catch (e) { return false; }
  });
  let balLine = '';
  if (s.bal !== null && s.bal !== undefined && s.bal !== '') {
    const delta = (split.mode === 'in' ? 1 : -1) * num(split.total) - num(split.fee);
    const after = round2(tymeTotal(b) + delta), diff = round2(after - num(s.bal));
    balLine = `<div class="t2">Bank balance after this: <b>${money(num(s.bal))}</b></div>` + (newer
      ? '<div class="hint">There is a newer SMS draft, so compare the balance there.</div>'
      : `<div class="t2">TymeBank in the app after saving: <b>${money(after)}</b> ${Math.abs(diff) < 0.01 ? '✓'
        : `<br><span class="hint err">${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the bank. An entry may be missing, or there was a fee.</span>`}</div>`);
  }
  const matches = smsMatches().map(m => `<div class="rmatch warn"><b>Already entered?</b> ${esc(m.label)}
    <a class="ghost btn-link" href="${m.href}">Open that entry</a><div class="hint">If it is the same, delete this draft.</div></div>`).join('');
  return `<div class="card pad receipt"><div class="t1">From TymeBank SMS${s.time ? ' · ' + esc(s.time) : ''}</div>
    <div class="t2 muted">${esc(s.text)}</div>
    ${!s.ok ? '<div class="hint err">Couldn\'t read this SMS. Fill in the amount and details.</div>'
      : s.from_bal ? `<div class="hint err">This SMS has no amount. ${money(num(split.total))} is worked out from the balance (${money(num(s.from_bal))} before, ${money(num(s.bal))} after). Check it.</div>`
      : !num(split.total) ? '<div class="hint err">This SMS has no amount. Type it in.</div>' : ''}
    ${balLine}${matches}
    ${split.parts.some(p => !p.pocket) ? '<div class="hint">Pick the pocket below. The bank doesn\'t know your pockets.</div>' : ''}</div>`;
}

function receiptBox() {
  const r = split.receipt;
  if (!r) return '';
  if (r.pending) return `<div class="card pad receipt reading"><div class="t1"><span class="spin"></span>Reading the receipt…</div>
    <div class="t2">The AI is reading it (it goes to Drive only when you save). Meanwhile, pick the pocket, fund and category below.</div></div>`;
  if (r.failed) return `<div class="card pad receipt"><div class="t1">Receipt not saved</div>
    <div class="hint err">${esc(r.read_error)}</div>${receiptFiles.has(r) ? '<button type="button" class="ghost" id="rc-retry">Try again</button>' : ''}</div>`;
  const head = `<div class="t1">Receipt${r.shop ? ': ' + esc(r.shop) : ''}</div>
    <div class="t2">${r.date ? esc(niceDate(r.date)) + ' · ' : ''}${r.total ? money(r.total) : ''}${r.url ? ` · <a class="link" href="${esc(r.url)}" target="_blank" rel="noopener">Open</a>` : ''}</div>`;
  if (r.read_error) return `<div class="card pad receipt">${head}<div class="hint err">Couldn't read it: ${esc(r.read_error)} Type the amounts; the receipt is saved with the entry.</div></div>`;
  if (!r.items || !r.items.length) return `<div class="card pad receipt">${head}</div>`;
  const itemsSum = round2(r.items.reduce((s, it) => s + num(it.amount), 0));
  const rows = r.items.map((it, i) => `<div class="ritem"><span class="rname">${esc(it.name)}${it.qty > 1 ? ` <span class="muted">×${esc(it.qty)}</span>` : ''}</span>
    <span class="ramt">${money(num(it.amount))}</span><button type="button" class="rpart" data-item="${i}" aria-label="Move to next part">${it.part + 1}</button></div>`).join('');
  const matches = (r.matches || []).map((m, i) => m.has
    ? `<div class="rmatch warn"><b>Already entered?</b> An entry with this amount already has a receipt: ${esc(m.label)}
      <a class="ghost btn-link" href="${m.g ? '#pay/' + encodeURIComponent(m.g) : '#tx/' + encodeURIComponent(m.id)}">Open that entry</a></div>`
    : `<div class="rmatch">Looks like an entry you already have: ${esc(m.label)}
      <button type="button" class="ghost" data-attach="${i}">Attach to that entry instead</button></div>`).join('');
  return `<div class="card pad receipt">${head}${matches}
    <div class="ritems">${rows}</div>
    <div class="hint">Tap a part number to move an item to another part.${r.total && Math.abs(itemsSum - r.total) > 0.01 ? ` The items add up to ${money(itemsSum)}, so each part gets its share of ${money(r.total)}.` : ''}</div></div>`;
}

// Entry and payment pages: open the receipt, or scan one and attach it.
function receiptButtons(rows) {
  const url = (rows.find(t => t.receipt_url) || {}).receipt_url;
  return `${url ? `<a class="ghost btn-link" href="${esc(url)}" target="_blank" rel="noopener">Open receipt</a>` : ''}
    <button type="button" class="ghost" id="attach-receipt">${url ? 'Replace receipt' : 'Attach receipt'}</button>`;
}
function bindReceiptButtons(rows, redraw) {
  const btn = $('attach-receipt'); if (!btn) return;
  btn.onclick = async () => {
    const r = await scanReceipt();
    if (!r) return;
    try {
      await attachReceipt(r, rows, r.items.map(it => Object.assign({}, it, { part: '' })));
      const total = round2(cashRows(rows).reduce((s, t) => s + num(t.amount), 0));
      toast(r.total && Math.abs(r.total - total) > 0.01 ? `Attached. Note: the receipt says ${money(r.total)}, the entry ${money(total)}.` : 'Receipt attached', r.total && Math.abs(r.total - total) > 0.01);
      redraw();
    } catch (e) { toast('Not attached: ' + needsNewScript(e), true); }
  };
}

// ---------- New person ----------

// The fund last used with this person (newest entry first), so picking them fills it in.
function personFund(pid) {
  let best = null;
  const when = t => (t.date || '') + String(t.created_at || '');
  for (const t of state.txs) if (t.person === pid && t.fund && (!best || when(t) > when(best))) best = t;
  const f = best && byId(L.funds(), best.fund);
  return f && isActive(f) ? f.id : '';
}

const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// People whose name looks like this one ("Dada K" / "DadaK", "Tumelo" / "Thumelo").
function similarPeople(name) {
  const q = squash(name); if (q.length < 2) return [];
  return L.people().filter(p => {
    const n = squash(p.name); if (!n) return false;
    if (n === q) return true;
    if (q.length >= 3 && n.length >= 3 && (n.startsWith(q) || q.startsWith(n))) return true;
    return editDistance(n, q) <= (Math.max(n.length, q.length) > 6 ? 2 : 1);
  });
}

// A sheet over the screen to add someone, with an optional starting balance.
// onDone(id) is called with the new (or the existing, if picked) person's id.
function openNewPerson(fund, onDone) {
  const np = { name: '', note: '', dir: '', amount: '', fund: fund || '', saving: false };
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  document.body.appendChild(bg);
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.onclick = e => { if (e.target === bg) close(); };
  const sync = () => {
    np.name = $('np-name').value; np.note = $('np-note').value;
    if ($('np-amount')) np.amount = $('np-amount').value;
  };

  const draw = () => {
    const funds = L.funds().filter(isActive);
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="np-title">
      <h3 id="np-title">New person</h3>
      <label for="np-name" style="margin-top:0">Name</label>
      <input id="np-name" autocapitalize="words" autocomplete="off" enterkeyhint="next" placeholder="e.g. Sipho" value="${esc(np.name)}">
      <div id="np-similar" class="hint"></div>
      <label for="np-note">Note (optional)</label>
      <input id="np-note" autocomplete="off" enterkeyhint="done" placeholder="e.g. Agricoop worker" value="${esc(np.note)}">
      <div class="lbl">Money already owed? (optional)</div>
      ${chips('np-dir', [{ id: 'owes', name: 'Owes me' }, { id: 'owed', name: 'I owe them' }], np.dir, { none: 'No' })}
      ${np.dir ? `<div class="amount-wrap small-amt"><span>R</span><input id="np-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(np.amount)}"></div>
      ${calcRow('np-amount')}
        <div class="lbl">Fund</div>${chips('np-fund', funds, np.fund)}
        <div class="hint">Saved as a starting balance dated today.</div>` : ''}
      <button type="button" class="primary" id="np-save" ${np.saving ? 'disabled' : ''}>${np.saving ? 'Saving…' : 'Add person'}</button>
      <button type="button" class="ghost" id="np-cancel">Cancel</button>
      <p id="np-msg" class="hint"></p>
    </div>`;
    const showSimilar = () => {
      const el = $('np-similar'); if (!el) return;
      const sim = similarPeople($('np-name').value);
      const exact = sim.find(p => squash(p.name) === squash($('np-name').value));
      el.className = 'hint' + (exact ? ' err' : '');
      el.innerHTML = !sim.length ? '' : (exact ? 'Already in the list: ' : 'Did you mean ') +
        sim.slice(0, 3).map(p => `<button type="button" class="link" data-use="${esc(p.id)}">${esc(p.name)}${isActive(p) ? '' : ' (hidden)'}</button>`).join(', ') +
        (exact ? '' : '?');
      el.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { close(); onDone(b.dataset.use); });
    };
    $('np-name').oninput = showSimilar; showSimilar();
    bg.querySelectorAll('.chips').forEach(g => g.onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      sync();
      if (g.dataset.name === 'np-dir') np.dir = b.dataset.v; else np.fund = b.dataset.v;
      draw();
      if (g.dataset.name === 'np-dir' && np.dir && $('np-amount')) $('np-amount').focus();
    });
    wireCalc('np-amount');
    $('np-cancel').onclick = close;
    $('np-save').onclick = save;
  };

  async function save() {
    sync();
    const msg = $('np-msg'), bad = t => { msg.className = 'hint err'; msg.textContent = t; };
    const name = np.name.trim().replace(/\s+/g, ' ');
    if (!name) return bad('Type a name.');
    const same = L.people().find(p => squash(p.name) === squash(name));
    if (same) return bad(`${same.name} is already in the list. Tap the name above to use it.`);
    const amt = num(np.amount);
    if (np.dir && amt <= 0) return bad('Enter the amount owed, or pick "No".');
    if (np.dir && !np.fund) return bad('Pick the fund the money belongs to.');
    np.saving = true; draw();
    let person;
    try {
      person = await api('addPerson', { name, note: np.note.trim() });
    } catch (e) {
      np.saving = false; draw();
      return bad('Not added: ' + needsNewScript(e));
    }
    state.lists.People = (state.lists.People || []).concat(person);
    store.setJSON('cacheLists', state.lists);
    if (np.dir) {
      const signed = np.dir === 'owes' ? amt : -amt;
      const tx = { date: localDay(new Date()), type: 'opening', amount: signed, currency: 'ZAR', rate: '', amount_zar: signed,
        account: '', to_account: '', fund: np.fund, to_fund: '', category: '', person: person.id, fee: '', note: 'Starting balance' };
      try {
        const res = await api('addTransaction', tx);
        tx.id = res.id; tx.created_at = new Date().toISOString();
        state.txs.push(tx); store.setJSON('cacheTxs', state.txs);
        toast(`Added ${person.name} (${np.dir === 'owes' ? 'owes you' : 'you owe'} ${money(amt)})`);
      } catch (e) {
        toast(`Added ${person.name}, but the starting balance was not saved: ${e.message}`, true);
      }
    } else toast(`Added ${person.name}`);
    close();
    onDone(person.id);
  }

  draw();
  setTimeout(() => { const el = $('np-name'); if (el) el.focus(); }, 50);
}

// ---------- Planned spending ----------
// Bills: one payment on a set day (every month, or once on a date). Allocations: money set aside for
// one purpose and spent in several entries (3 trips to Randburg: R1,500), once until you close it,
// or every month (diesel, snacks). Pocket and fund are optional for allocations.
// "After planned" = balance minus bills still due this month and what is left of allocations.

const PLAN_TYPES = ['expense', 'payment', 'gift'];
function normPlan(p) {
  return Object.assign({}, p, {
    // Older "limit" rows are monthly allocations.
    kind: p.kind === 'limit' || p.kind === 'alloc' ? 'alloc' : 'bill', type: PLAN_TYPES.includes(p.type) ? p.type : 'expense',
    repeat: p.repeat === 'once' ? 'once' : 'monthly', amount: num(p.amount), day: parseInt(p.day, 10) || 1,
    date: toDay(p.date), start: toDay(p.start) || toDay(p.updated_at), active: isActive(p),
    // Months skipped on purpose ("2026-11,2026-12"): not paid and not due.
    skip: Array.isArray(p.skip) ? p.skip : String(p.skip || '').split(',').map(x => x.trim()).filter(Boolean),
  });
}
const pad2 = n => String(n).padStart(2, '0');
const monthOf = day => (day || '').slice(0, 7);
const lastDayOf = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return localDay(new Date(y, m - 1, d + n)); };
const monthName = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-ZA', { month: 'long' }); };
// The day this month a bill is due (the 31st is the last day in shorter months).
const dueOn = (p, ym) => p.repeat === 'once' ? p.date : `${ym}-${pad2(Math.min(p.day, lastDayOf(ym)))}`;
const txZar = t => num(t.amount_zar) || num(t.amount);
const spendTx = t => typeOf(t.type).dir < 0 && !isMove(t) && !pocketSettle(t);
// A normal entry that pays this bill: same pocket, fund and category (and person, if set), and its
// note contains the bill's name.
const billMatch = (p, t) => spendTx(t) && t.account === p.account && t.fund === p.fund && t.category === p.category &&
  (!p.person || t.person === p.person) && !!squash(p.name) && squash(t.note).includes(squash(p.name));
// An entry that counts for an allocation without being picked for it: pocket, fund and person must
// fit where they are set. A one-off allocation needs its name in the note (and the category, if set);
// a monthly one counts every entry of its category, or with its name when no category is set.
const allocMatch = (p, t) => spendTx(t) && (!p.account || t.account === p.account) && (!p.fund || t.fund === p.fund) &&
  (!p.person || t.person === p.person) && (!p.category || t.category === p.category) &&
  ((p.repeat === 'monthly' && !!p.category) || nameIn(p.name, t.note));
// Every word of the name is in the note, in any order: "Randburg trips" fits "Trip to Randburg".
function nameIn(name, note) {
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1).map(w => w.replace(/s$/, ''));
  const hay = String(note || '').toLowerCase();
  return words.length > 0 && words.every(w => hay.includes(w));
}

function planStatus() {
  const today = localDay(new Date()), ym = monthOf(today), soonTo = addDays(today, 7);
  const items = state.planned.filter(p => p.active && p.amount > 0);
  const claimed = new Set();
  const bills = [], later = [], allocs = [];
  // Entries linked to a bill (paid from the Planned screen) first, then entries found by name.
  const linked = id => state.txs.filter(t => t.planned === id);
  const billList = items.filter(p => p.kind === 'bill').map(p => ({ p, due: dueOn(p, ym) }))
    .sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  for (const b of billList) {
    const own = linked(b.p.id).filter(t => b.p.repeat === 'once' || monthOf(t.date) === ym);
    if (own.length) { b.paid = own[0]; own.forEach(t => claimed.add(t.id)); }
  }
  for (const b of billList) {
    if (b.paid) continue;
    const from = b.p.repeat === 'once' ? addDays(b.due || today, -14) : ym + '-01';
    const t = state.txs.filter(t => !claimed.has(t.id) && t.date >= from && (b.p.repeat === 'once' || monthOf(t.date) === ym) && billMatch(b.p, t))
      .sort((x, y) => x.date.localeCompare(y.date))[0];
    if (t) { b.paid = t; claimed.add(t.id); }
  }
  for (const b of billList) {
    const p = b.p;
    if (p.repeat === 'once' && b.due && monthOf(b.due) > ym) { later.push(b); continue; }
    // A one-off bill paid in an earlier month is done: not shown any more.
    if (p.repeat === 'once' && b.paid && monthOf(b.paid.date) < ym) continue;
    b.skipped = !b.paid && p.repeat === 'monthly' && p.skip.includes(ym);
    b.left = b.paid || b.skipped ? 0 : p.amount;
    b.overdue = !b.paid && !b.skipped && b.due < today;
    b.soon = !b.paid && !b.skipped && b.due <= soonTo;
    // Stopped or failed subscriptions: not paid 5 days after the day.
    if (!b.paid && !b.skipped && b.due <= addDays(today, -5)) {
      const prev = state.txs.filter(t => t.planned === p.id || billMatch(p, t)).sort((x, y) => y.date.localeCompare(x.date))[0];
      b.flag = prev ? `Not paid yet · last paid ${niceDate(prev.date)}` : 'Not paid yet';
    }
    bills.push(b);
  }
  const allocList = items.filter(p => p.kind === 'alloc');
  const inPeriod = (p, t) => p.repeat === 'monthly' ? monthOf(t.date) === ym : !p.start || t.date >= p.start;
  const usedBy = {};
  // Entries picked for an allocation first, then entries that fit one.
  for (const p of allocList) { usedBy[p.id] = state.txs.filter(t => t.planned === p.id && !claimed.has(t.id) && inPeriod(p, t)); usedBy[p.id].forEach(t => claimed.add(t.id)); }
  for (const p of allocList) {
    const more = state.txs.filter(t => !claimed.has(t.id) && !t.planned && inPeriod(p, t) && allocMatch(p, t));
    more.forEach(t => claimed.add(t.id));
    const used = usedBy[p.id].concat(more).sort((x, y) => y.date.localeCompare(x.date));
    const spent = round2(used.reduce((s, t) => s + txZar(t), 0));
    allocs.push({ p, used, spent, left: Math.max(0, round2(p.amount - spent)), late: p.repeat === 'once' && p.date && p.date < today });
  }
  const byAcc = {}, byFund = {};
  let left = 0;
  for (const x of [...bills, ...allocs]) {
    if (!x.left) continue;
    left += x.left;
    if (x.p.account) byAcc[x.p.account] = (byAcc[x.p.account] || 0) + x.left;
    if (x.p.fund) byFund[x.p.fund] = (byFund[x.p.fund] || 0) + x.left;
  }
  const loose = allocs.filter(a => a.left && !a.p.account);
  return { noPocket: round2(loose.reduce((s, a) => s + a.left, 0)), noPocketNames: loose.map(a => a.p.name).join(', '), ym, today, bills, later, allocs, byAcc, byFund, left: round2(left), soon: bills.filter(b => b.soon) };
}

const planWhere = p => [p.account ? accName(p.account).replace(/^TymeBank /, 'Tyme ') : 'Any pocket', p.fund ? nameOf(L.funds(), p.fund) : 'any fund',
  p.person ? nameOf(L.people(), p.person) : ''].filter(Boolean).join(' · ');
function billRow(b) {
  const p = b.p;
  const when = b.paid ? `Paid ${niceDate(b.paid.date)} ✓` : b.skipped ? `Skipped this month` : b.overdue ? `Due ${niceDate(b.due)}, overdue` : `Due ${niceDate(b.due)}`;
  return `<div class="row tap" data-plan="${esc(p.id)}"><span class="name">${esc(p.name)}
      <div class="muted small ${b.overdue ? 'err' : ''}">${esc(when)}</div>
      <div class="muted small">${esc(planWhere(p))}</div>${b.flag ? `<div class="small err">${esc(b.flag)}</div>` : ''}</span>
    <span class="amt ${b.skipped ? 'muted' : ''}">${money(b.paid ? txZar(b.paid) : p.amount)}${b.paid ? ''
      : b.skipped ? `<div><button type="button" class="link" data-planskip="${esc(p.id)}">Undo skip</button></div>`
      : `<div><button type="button" class="link" data-planpay="${esc(p.id)}">Pay ›</button></div>${p.repeat === 'monthly' ? `<div><button type="button" class="link" style="color:var(--muted)" data-planskip="${esc(p.id)}">Skip</button></div>` : ''}`}</span></div>`;
}
function bindPlanRows(v) {
  v.querySelectorAll('[data-planpay]').forEach(el => el.onclick = e => { e.stopPropagation(); payPlanned(el.dataset.planpay); });
  v.querySelectorAll('[data-planskip]').forEach(el => el.onclick = e => { e.stopPropagation(); skipPlanned(el.dataset.planskip, el); });
  v.querySelectorAll('[data-plan]').forEach(el => el.onclick = () => editPlanned(el.dataset.plan));
}
// Skip this month's bill (you didn't use the service), or undo the skip.
async function skipPlanned(id, btn) {
  const p = byId(state.planned, id); if (!p) return;
  const ym = monthOf(localDay(new Date()));
  const skip = p.skip.includes(ym) ? p.skip.filter(m => m !== ym) : p.skip.concat([ym]);
  // Show that it is working: the button says "Skipping…" and the row fades until it is saved.
  const label = btn.textContent, row = btn.closest('.row');
  btn.disabled = true; btn.textContent = skip.includes(ym) ? 'Skipping…' : 'Undoing…';
  if (row) row.style.opacity = '0.5';
  try {
    const res = await api('savePlanned', Object.assign({}, p, { skip: skip.join(',') }));
    if (res.columns && !res.columns.includes('skip') || !res.columns) throw new Error('Skip needs the updated Apps Script (Code.gs, 21 Nov 2026).');
    const saved = normPlan(res);
    state.planned = state.planned.map(x => x.id === id ? saved : x); store.setJSON('cachePlanned', state.planned);
    toast(skip.includes(ym) ? `Skipped ${p.name} this month` : `${p.name} is due again`);
    render();
  } catch (e) { btn.disabled = false; btn.textContent = label; if (row) row.style.opacity = ''; toast(needsNewScript(e), true); }
}
// Opens the Add form filled in from the bill; saving it ticks the bill.
function payPlanned(id) {
  const p = byId(state.planned, id); if (!p) return;
  formSeed = { type: p.type, amount: String(p.amount), account: p.account, fund: p.fund, category: p.category,
    person: p.person || '', note: p.name, planned: p.id, fundFrom: '', fee: '', to_account: '', to_fund: '', moveFund: false };
  location.hash = '#add';
}

// Repeats found in the last months' entries that are not planned yet.
function planSuggestions() {
  const ym = monthOf(localDay(new Date()));
  const [y, m] = ym.split('-').map(Number);
  const from = localDay(new Date(y, m - 4, 1));
  const hidden = store.getJSON('planHidden', []);
  const groups = {};
  for (const t of state.txs) {
    if (!t.date || t.date < from || !spendTx(t) || !t.account || !t.note || !squash(t.note) || t.planned) continue;
    const key = [t.account, t.fund, t.category, t.person || '', squash(t.note)].join('|');
    (groups[key] = groups[key] || []).push(t);
  }
  const planned = state.planned.filter(p => p.active);
  const out = [];
  for (const key in groups) {
    const ts = groups[key].sort((a, b) => b.date.localeCompare(a.date));
    const months = new Set(ts.map(t => monthOf(t.date)));
    if (months.size < 2 || hidden.includes(key)) continue;
    const t = ts[0], k = squash(t.note);
    if (planned.some(p => p.fund === t.fund && p.category === t.category && (k.includes(squash(p.name)) || squash(p.name).includes(k)))) continue;
    out.push({ key, t, months: months.size, n: ts.length });
  }
  return out.sort((a, b) => b.months - a.months || txZar(b.t) - txZar(a.t)).slice(0, 8);
}

function renderPlan(v) {
  if (!state.lists) { v.innerHTML = `<header><h1>Planned</h1></header><p class="muted">${state.loading ? 'Loading…' : 'Lists not loaded yet.'}</p>`; return; }
  const plan = planStatus();
  const sugg = planSuggestions();
  const allocRows = plan.allocs.map(l => `<div class="row tap" data-plan="${esc(l.p.id)}"><span class="name">${esc(l.p.name)}
      <div class="muted small">${money(l.spent)} used of ${money(l.p.amount)} · ${l.used.length} entr${l.used.length === 1 ? 'y' : 'ies'}</div>
      <div class="muted small">${l.p.repeat === 'monthly' ? 'Every month' : l.p.date ? 'Use by ' + esc(niceDate(l.p.date)) : 'Until you close it'} · ${esc(planWhere(l.p))}</div>
      ${l.late && l.left ? '<div class="small err">Past its date: close it to free what is left</div>' : ''}</span>
      <span class="amt ${l.spent > l.p.amount ? 'neg' : ''}">${l.spent > l.p.amount ? money(l.spent - l.p.amount) + '<div class="small">over</div>' : money(l.left) + '<div class="muted small">left</div>'}</span></div>`).join('');
  const laterRows = plan.later.map(b => `<div class="row tap" data-plan="${esc(b.p.id)}"><span class="name">${esc(b.p.name)}
      <div class="muted small">${esc(niceDate(b.due))} · ${esc(planWhere(b.p))}</div></span><span class="amt">${money(b.p.amount)}</span></div>`).join('');
  const suggRows = sugg.map((s, i) => `<div class="row"><span class="name">${esc(s.t.note)}
      <div class="muted small">${s.n} times in ${s.months} months · last ${money(txZar(s.t))} on ${esc(niceDate(s.t.date))}</div>
      <div class="muted small">${esc(planWhere(s.t))}</div></span>
      <span class="amt"><button type="button" class="link" data-sugg="${i}">Add ›</button><div><button type="button" class="link" style="color:var(--muted)" data-hide="${i}">Hide</button></div></span></div>`).join('');
  const off = state.planned.filter(p => !p.active);
  v.innerHTML = `
    <header><h1>Planned</h1><button class="refresh" id="plan-new">+ New</button></header>
    ${state.plannedErr ? `<p class="err small">${esc(state.plannedErr)}</p>` : ''}
    <div class="total-box"><div class="small">Still planned: bills to the end of ${esc(monthName(plan.ym))}, and what is left of allocations</div><div class="big">${money(plan.left)}</div></div>
    <h2>Bills</h2><div class="card">${plan.bills.length ? plan.bills.map(billRow).join('') : '<div class="empty small">No bills yet. Tap + New, or add one from the suggestions.</div>'}</div>
    <h2>Allocations</h2><div class="card">${allocRows || '<div class="empty small">No allocations yet. Tap + New to set money aside, like R1,500 for trips.</div>'}</div>
    ${laterRows ? `<h2>Later</h2><div class="card">${laterRows}</div>` : ''}
    ${suggRows ? `<h2>Repeats in your entries</h2><div class="card">${suggRows}</div><div class="hint">Found in the last months. Add one as a monthly bill.</div>` : ''}
    ${off.length ? `<h2>Stopped or closed</h2><div class="card">${off.map(p => `<div class="row tap" data-plan="${esc(p.id)}"><span class="name muted">${esc(p.name)}</span><span class="amt muted">${money(p.amount)}</span></div>`).join('')}</div>` : ''}`;
  $('plan-new').onclick = () => { planForm = newPlanForm(); location.hash = '#plan/edit'; };
  bindPlanRows(v);
  v.querySelectorAll('[data-sugg]').forEach(el => el.onclick = () => {
    const t = sugg[+el.dataset.sugg].t;
    planForm = Object.assign(newPlanForm(), { name: t.note, amount: String(txZar(t)), account: t.account, fund: t.fund,
      category: t.category, person: t.person || '', type: PLAN_TYPES.includes(t.type) ? t.type : 'expense', day: String(+t.date.slice(8)) });
    location.hash = '#plan/edit';
  });
  v.querySelectorAll('[data-hide]').forEach(el => el.onclick = () => {
    const h = store.getJSON('planHidden', []); h.push(sugg[+el.dataset.hide].key); store.setJSON('planHidden', h); renderPlan(v);
  });
}

// ---------- New or edit a planned item ----------

async function savePlan(row, btn, msg) {
  if (Array.isArray(row.skip)) row = Object.assign({}, row, { skip: row.skip.join(',') });
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const saved = normPlan(await api('savePlanned', row));
    state.planned = state.planned.filter(p => p.id !== saved.id).concat([saved]); store.setJSON('cachePlanned', state.planned);
    toast(saved.kind === 'alloc' && !saved.active ? `Closed ${saved.name}` : `Saved ${saved.name}`); planForm = null; location.hash = '#plan';
  } catch (err) {
    btn.disabled = false; btn.textContent = label;
    msg.className = 'hint err'; msg.textContent = 'Not saved: ' + needsNewScript(err);
  }
}

let planForm = null;
function newPlanForm() {
  const acc = postable().find(a => a.id === 'tyme-ratna') ? 'tyme-ratna' : ((postable()[0] || {}).id || '');
  return { id: '', kind: 'bill', name: '', amount: '', account: acc, fund: fundFor(acc), category: '', person: '',
    type: 'expense', repeat: 'monthly', day: '', date: '', start: '', active: true, note: '' };
}
function editPlanned(id) {
  const p = byId(state.planned, id); if (!p) return;
  planForm = Object.assign({}, p, { amount: String(p.amount), day: String(p.day) });
  location.hash = '#plan/edit';
}
function renderPlanEdit(v) {
  if (!planForm) planForm = newPlanForm();
  const P = planForm, bill = P.kind === 'bill';
  const st = P.id && !bill ? planStatus().allocs.find(a => a.p.id === P.id) : null;
  const accs = postable().filter(a => accCurrency(a.id) === 'ZAR').map(a => ({ id: a.id, name: a.parent ? accName(a.id).replace(/^TymeBank /, 'Tyme ') : a.name }));
  const cats = L.categories().filter(isActive).filter(c => String(c.kind || 'both') !== 'income');
  v.innerHTML = `
    <header><h1>${P.id ? 'Edit planned' : 'New planned'}</h1></header>
    <form id="plan-form" autocomplete="off">
      ${chips('kind', [{ id: 'bill', name: 'Bill' }, { id: 'alloc', name: 'Allocation' }], P.kind)}
      <div class="hint">${bill ? 'One payment on a set day, like Obsidian or data.' : 'Money set aside for one purpose and spent in several entries, like R1,500 for trips to Randburg.'}</div>
      <label for="p-name">Name</label>
      <input id="p-name" placeholder="${bill ? 'e.g. Obsidian' : 'e.g. Randburg trips'}" value="${esc(P.name)}">
      <div class="hint">${bill ? 'An entry whose note has this name ticks the bill by itself.' : 'An entry counts when you pick this allocation on the entry form, or when its note has the words of this name.'}</div>
      <label for="p-amount">${bill ? 'Amount' : P.repeat === 'monthly' ? 'Amount per month' : 'Amount'}</label>
      <div class="amount-wrap small-amt"><span>R</span><input id="p-amount" inputmode="decimal" placeholder="0.00" value="${esc(P.amount)}"></div>
      ${calcRow('p-amount')}
      ${bill ? `<div class="lbl">When</div>${chips('repeat', [{ id: 'monthly', name: 'Every month' }, { id: 'once', name: 'Once' }], P.repeat)}
        ${P.repeat === 'once' ? `<label for="p-date">Date</label><input id="p-date" type="date" value="${esc(P.date)}">`
          : `<label for="p-day">Day of the month</label><input id="p-day" inputmode="numeric" placeholder="e.g. 25" value="${esc(P.day)}">`}`
        : `<div class="lbl">How long</div>${chips('repeat', [{ id: 'once', name: 'Until used or closed' }, { id: 'monthly', name: 'Every month' }], P.repeat)}
        ${P.repeat === 'once' ? `<label for="p-date">Use by (optional)</label><input id="p-date" type="date" value="${esc(P.date)}">` : '<div class="hint">Starts again each month. With a category, every entry of that category counts.</div>'}`}
      <div class="lbl">Paid from${bill ? '' : ' (optional)'}</div>${chips('account', accs, P.account, bill ? {} : { none: 'Any pocket' })}
      <div class="lbl">Fund (whose money)${bill ? '' : ' (optional)'}</div>${chips('fund', L.funds().filter(isActive), P.fund, bill ? {} : { none: 'Any fund' })}
      ${bill ? '' : '<div class="hint">With a pocket or fund, its "after planned" on the home screen goes down. Without, only the total does.</div>'}
      <div class="lbl">Category${bill ? '' : ' (optional)'}</div>${chips('category', cats, P.category, bill ? {} : { none: 'Any' })}
      ${bill ? `<div class="lbl">Pay as</div>${chips('type', PLAN_TYPES.map(typeOf), P.type)}` : ''}
      <div class="lbl">Person (optional)</div>${chips('person', L.people().filter(isActive), P.person, { none: 'No one' })}
      ${P.id && bill ? `<div class="hint"><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit"><input type="checkbox" id="p-active" style="width:auto" ${P.active ? 'checked' : ''}> Still planned (untick when it stops)</label></div>` : ''}
      <button class="primary" id="p-save" type="submit">Save</button>
      ${P.id && !bill ? `<button type="button" class="ghost" id="p-close">${P.active ? `Close${st && st.left ? ' and free ' + money(st.left) : ''}` : 'Open again'}</button>` : ''}
      ${P.id ? '<button type="button" class="ghost danger" id="p-del">Delete</button>' : ''}
      <button type="button" class="ghost" id="p-cancel">Cancel</button>
      <p id="p-msg" class="hint"></p>
    </form>
    ${st && st.used.length ? `<h2>Counted entries</h2><div class="card">${st.used.map(txRow).join('')}</div>` : ''}`;
  bindTxRows(v);
  wireCalc('p-amount');
  const sync = () => {
    P.name = $('p-name').value; P.amount = $('p-amount').value;
    if ($('p-day')) P.day = $('p-day').value;
    if ($('p-date')) P.date = $('p-date').value;
    if ($('p-active')) P.active = $('p-active').checked;
  };
  $('plan-form').querySelectorAll('.chips').forEach(group => group.onclick = e => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    sync();
    const name = group.dataset.name, val = btn.dataset.v;
    if (name === 'person') P.person = P.person === val ? '' : val;
    else P[name] = val;
    if (name === 'account' && val && (bill || P.fund)) P.fund = fundFor(val);
    if (name === 'kind' && val === 'bill') { if (!P.account) P.account = newPlanForm().account; if (!P.fund) P.fund = fundFor(P.account); P.repeat = 'monthly'; }
    if (name === 'kind' && val === 'alloc') { P.repeat = 'once'; P.account = ''; P.fund = ''; }
    renderPlanEdit(v);
  });
  $('p-cancel').onclick = () => { location.hash = '#plan'; };
  $('plan-form').onsubmit = async e => {
    e.preventDefault(); sync();
    const msg = $('p-msg'), day = parseInt(P.day, 10);
    const problem = !P.name.trim() ? 'Enter a name.' : !(num(P.amount) > 0) ? 'Enter an amount.'
      : bill && P.repeat === 'monthly' && !(day >= 1 && day <= 31) ? 'Enter a day from 1 to 31.'
      : bill && P.repeat === 'once' && !P.date ? 'Pick a date.'
      : bill && !P.account ? 'Pick where it is paid from.' : bill && !P.fund ? 'Pick a fund.' : bill && !P.category ? 'Pick a category.' : '';
    if (problem) { msg.className = 'hint err'; msg.textContent = problem; return; }
    const row = { id: P.id || '', name: P.name.trim(), kind: P.kind, type: bill ? P.type : '', amount: num(P.amount),
      account: P.account || '', fund: P.fund || '', category: P.category || '', person: P.person || '',
      repeat: P.repeat, day: bill && P.repeat === 'monthly' ? day : '', date: P.repeat === 'once' ? (P.date || '') : '',
      start: P.start || localDay(new Date()), active: P.active !== false, note: P.note || '', skip: P.skip || [] };
    await savePlan(row, $('p-save'), msg);
  };
  if ($('p-close')) $('p-close').onclick = () => {
    sync(); P.active = !P.active;
    savePlan(Object.assign({}, P, { amount: num(P.amount), day: P.day ? parseInt(P.day, 10) : '' }), $('p-close'), $('p-msg'));
  };
  if ($('p-del')) $('p-del').onclick = async () => {
    if (!confirm(`Delete “${P.name}”? To keep its history, untick "Still planned" instead.`)) return;
    try {
      await api('deletePlanned', { id: P.id });
      state.planned = state.planned.filter(p => p.id !== P.id); store.setJSON('cachePlanned', state.planned);
      toast('Deleted'); planForm = null; location.hash = '#plan';
    } catch (err) { toast('Not deleted: ' + needsNewScript(err), true); }
  };
}

// ---------- Settings ----------

function renderSettings(v) {
  v.innerHTML = `
    <header><h1>Settings</h1></header>
    <h2>Data sheet link</h2>
    <div class="card pad">
      <label for="url" style="margin-top:0">Apps Script link</label>
      <input id="url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(store.get('scriptUrl'))}">
      <label for="key">Secret key</label>
      <input id="key" type="password" placeholder="The key from setup()" value="${esc(store.get('scriptKey'))}">
      <button class="primary" id="save-link">Save and connect</button>
      <p id="status" class="hint"></p>
    </div>
    <h2>About</h2>
    <div class="card pad"><div class="muted small">Version ${VERSION}. ${state.txs.length} entries loaded. Your data stays in your Google Sheet; this phone keeps a copy so the app opens fast.</div></div>`;
  $('save-link').onclick = async () => {
    store.set('scriptUrl', $('url').value.trim());
    store.set('scriptKey', $('key').value.trim());
    const s = $('status'); s.className = 'hint'; s.textContent = 'Connecting…';
    try {
      await api('ping');
      s.className = 'hint ok'; s.textContent = 'Connected.';
      await refresh();
      location.hash = '#home';
    } catch (e) { s.className = 'hint err'; s.textContent = 'Could not connect: ' + e.message; }
  };
}

// ---------- Start ----------

window.addEventListener('hashchange', () => {
  if (route()[0] === 'add') { resetForm(); seedForm(); }
  if (route()[0] === 'split') split.ready = false;
  render(); window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.get('scriptUrl')) refresh(); });
// The phone's saved copy of planned items may come from an older version (no "skip" yet).
try { state.planned = (state.planned || []).map(normPlan); } catch (e) { state.planned = []; }
if (route()[0] === 'add') resetForm();
if (route()[0] === 'split' && route()[1] !== 'draft' && route()[1] !== 'edit') location.replace('#add');
render();
if (store.get('scriptUrl')) refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
