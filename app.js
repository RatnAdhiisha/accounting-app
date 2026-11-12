// Accounting app: quick entry, split payments, balances home screen, entry list, new people.
'use strict';

const VERSION = '0.6.2';
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
  'cash-zar': 'personal', 'cash-eur': 'personal', 'agricoop-cash': 'agricoop' };

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
const isMove = t => ['transfer', 'exchange', 'fund_transfer'].includes(typeOf(t.type).id);

const num = v => { const n = parseFloat(String(v).replace(/[ ,]/g, '')); return isFinite(n) ? n : 0; };

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
  const acc = {}, fund = {}, person = {};
  const add = (o, k, v) => { if (k) o[k] = (o[k] || 0) + v; };

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
    if (type.person && t.person) add(person, t.person + '|' + (t.fund || ''), type.person * zar);
  }
  return { acc, fund, person, zar, feeZar };
}

function balances() {
  const acc = {}, fund = {}, person = {};
  const merge = (to, from) => { for (const k in from) to[k] = (to[k] || 0) + from[k]; };
  for (const t of state.txs) { const e = effects(t); merge(acc, e.acc); merge(fund, e.fund); merge(person, e.person); }
  // Round to cents so tiny floating-point leftovers don't show as red −R0.00.
  for (const o of [acc, fund, person]) for (const k in o) o[k] = Math.round(o[k] * 100) / 100 || 0;
  return { acc, fund, person, owed: owedByPerson(person) };
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
// funds on purpose, so money kept there is not a debt; only overspending there is.
const ACCOUNT_FUND = Object.assign({ 'ajbulk-cash': 'ventures' }, DEFAULT_FUND);
const SHARED_ACCOUNTS = new Set(['tyme-transit']);
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
  else add(t.account, t.fund, type.dir * zar - fee);
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
function render() {
  const [tab, arg] = route();
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const needSetup = !store.get('scriptUrl');
  if (needSetup && tab !== 'settings') { location.replace('#settings'); return; }
  const v = $('view');
  if (tab === 'add') { if (!v.querySelector('#entry-form') || render.lastTab !== 'add') renderAdd(v); }
  else if (tab === 'list') renderList(v);
  else if (tab === 'split') { if (!v.querySelector('#split-form') || render.lastTab !== 'split' || !split.ready) renderSplit(v, route().slice(1)); }
  else if (tab === 'pay') renderPay(v, arg);
  else if (tab === 'tx') renderTx(v, arg);
  else if (tab === 'settings') renderSettings(v);
  else renderHome(v);
  render.lastTab = tab;
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
      accRows += `<div class="row"><span class="name">${esc(a.name)}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(x, cur)}${extra}</span></div>`;
    }
  }

  const fundRows = L.funds().filter(f => isActive(f) || Math.abs(b.fund[f.id] || 0) > 0.004).map(f => {
    const x = b.fund[f.id] || 0;
    return `<div class="row"><span class="name">${esc(f.name)}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(x)}</span></div>`;
  }).join('');

  // Each debt belongs to a fund: "School owes Dada K's feeding program R1,049".
  const debtLine = (x, fid) => x > 0 ? `owes ${fundLabel(fid)}` : `${fundLabel(fid)} owes them`;
  const owed = L.people().map(p => ({ p, o: b.owed[p.id] })).filter(r => r.o && Object.keys(r.o.funds).length)
    .sort((a, b) => b.o.total - a.o.total);
  const peopleRows = owed.length ? owed.map(({ p, o }) => {
    const parts = Object.entries(o.funds).sort((a, b) => b[1] - a[1]);
    if (parts.length === 1) {
      const [fid, x] = parts[0];
      return `<div class="row"><span class="name">${esc(p.name)} <span class="muted small">${esc(debtLine(x, fid))}</span></span><span class="amt ${x < 0 ? 'neg' : ''}">${money(Math.abs(x))}</span></div>`;
    }
    return `<div class="row parent"><span class="name">${esc(p.name)} <span class="muted small">${o.total >= 0 ? 'owes in all' : 'is owed in all'}</span></span><span class="amt ${o.total < 0 ? 'neg' : ''}">${money(Math.abs(o.total))}</span></div>` +
      parts.map(([fid, x]) => `<div class="row sub"><span class="name">${esc(debtLine(x, fid))}</span><span class="amt ${x < 0 ? 'neg' : ''}">${money(Math.abs(x))}</span></div>`).join('');
  }).join('') : '<div class="empty small">Nobody owes anything.</div>';
  // Funds that owe each other, with a button to pay it back.
  const fundDebtRows = fundDebts(state.txs).map(d => {
    const fromAcc = FUND_ACCOUNT[d.from], toAcc = FUND_ACCOUNT[d.to];
    const can = fromAcc && toAcc && postable().some(a => a.id === fromAcc) && postable().some(a => a.id === toAcc);
    return `<div class="row"><span class="name">${esc(nameOf(L.funds(), d.from))} <span class="muted small">owes ${esc(fundLabel(d.to))}</span></span>
      <span class="amt">${money(d.amount)}${can ? `<div><button class="link" data-settle="${esc(d.from)}|${esc(d.to)}|${d.amount}">Pay back ›</button></div>` : ''}</span></div>`;
  }).join('');
  const all = Object.values(b.person);
  const owesMe = all.filter(x => x > 0).reduce((s, x) => s + x, 0);
  const iOwe = all.filter(x => x < 0).reduce((s, x) => s - x, 0);

  const recent = listItems(sortedTxs(), false).slice(0, 5);
  const drafts = state.drafts.map(d => Object.assign({ id: d.id }, draftInfo(d)));

  v.innerHTML = `
    <header><h1>Accounting</h1><button class="refresh" id="refresh">↻ Refresh</button></header>
    <div>${statusLine()}</div>
    <div class="total-box">
      <div class="small">All money${missingRate ? ' (foreign cash without a rate left out)' : ''}</div>
      <div class="big">${money(totalZar)}</div>
      ${owesMe || iOwe ? `<div class="small">${owesMe ? 'Owed back ' + money(owesMe) : ''}${owesMe && iOwe ? ' · ' : ''}${iOwe ? 'Owed to others ' + money(iOwe) : ''}</div>` : ''}
    </div>
    ${drafts.length ? `<h2>Drafts to finish</h2><div class="card">${drafts.map(d => `<div class="tx" data-draft="${esc(d.id)}"><div class="l"><div class="t1">${esc(d.who)}</div><div class="t2">${esc(niceDate(d.date))} · ${d.left ? money(d.left) + ' left to assign' : 'ready to save'}</div></div><div class="amt">${money(d.total)}</div></div>`).join('')}</div>` : ''}
    <h2>Accounts</h2><div class="card">${accRows}</div>
    <h2>Funds (whose money)</h2><div class="card">${fundRows}</div>
    ${fundDebtRows ? `<h2>Funds that owe each other</h2><div class="card">${fundDebtRows}</div>
      <div class="hint">When one fund's money pays for another fund, the other fund owes it back.</div>` : ''}
    <h2>People</h2><div class="card">${peopleRows}</div>
    <h2>Recent</h2><div class="card">${recent.length ? recent.map(itemRow).join('') : '<div class="empty small">No entries yet. Tap + to add one.</div>'}</div>
    ${recent.length ? '<p><a class="link" href="#list">All entries ›</a></p>' : ''}
  `;
  $('refresh').onclick = refresh;
  bindTxRows(v);
  v.querySelectorAll('[data-settle]').forEach(el => el.onclick = () => {
    const [from, to, amount] = el.dataset.settle.split('|');
    formSeed = { type: 'transfer', amount, account: FUND_ACCOUNT[from], to_account: FUND_ACCOUNT[to], fund: from,
      to_fund: '', moveFund: false, category: '', person: '', fundFrom: '', fee: '',
      note: `${nameOf(L.funds(), from)} pays back ${nameOf(L.funds(), to)}`, settle: { from, to } };
    location.hash = '#add';
  });
  v.querySelectorAll('[data-draft]').forEach(el => el.onclick = () => { location.hash = '#split/draft/' + encodeURIComponent(el.dataset.draft); });
}

function sortedTxs() {
  return state.txs.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function txTitle(t) {
  const type = typeOf(t.type);
  if (t.note) return t.note;
  if (type.id === 'fund_transfer') return `${nameOf(L.funds(), t.fund)} → ${nameOf(L.funds(), t.to_fund)}`;
  if (isMove(t)) return `${accName(t.account)} → ${accName(t.to_account)}`;
  if (type.person && t.person) return `${type.label} · ${nameOf(L.people(), t.person)}`;
  return nameOf(L.categories(), t.category) || type.label;
}
function txRow(t) {
  const type = typeOf(t.type);
  const cur = accCurrency(t.account);
  const amt = num(t.amount);
  const sign = isMove(t) ? '' : (type.dir > 0 ? '+' : '−');
  let partOf = '';
  if (t.group_id) {
    const cash = cashRows(groupRows(t.group_id));
    if (cash.length > 1 || t.type === 'advance_used') {
      const g = cash.reduce((s, x) => s + num(x.amount), 0);
      partOf = `part of ${money(g)}${t.paid_to ? ' to ' + nameOf(L.people(), t.paid_to) : ''}`;
    }
  }
  const bits = [niceDate(t.date), isMove(t) ? type.label : accName(t.account),
    nameOf(L.funds(), t.fund), t.person ? nameOf(L.people(), t.person) : '', partOf].filter(Boolean);
  return `<div class="tx" data-id="${esc(t.id)}"><div class="l"><div class="t1">${esc(txTitle(t))}</div><div class="t2">${esc(bits.join(' · '))}</div></div>
    <div class="amt ${type.dir > 0 && type.id !== 'opening' ? 'in' : ''}">${sign}${money(amt, cur)}</div></div>`;
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
  const out = typeOf(first.type).dir < 0;
  const total = cash.reduce((s, x) => s + num(x.amount), 0);
  const notes = [...new Set(cash.map(x => x.note || ''))];
  const title = first.paid_to ? `${out ? 'To' : 'From'} ${nameOf(L.people(), first.paid_to)}` : (notes.length === 1 && notes[0]) || 'Split payment';
  const bits = [niceDate(first.date), nameOf(L.accounts(), topOf(first.account)), `${cash.length} part${cash.length === 1 ? '' : 's'}`];
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
    fee: '', rate: '', moveFund: false, fundFrom: '', settle: null,
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

  v.innerHTML = `
    <header><h1>New entry</h1></header>
    <form id="entry-form" autocomplete="off">
      ${chips('type', TYPES.filter(t => !t.hidden), form.type)}
      <div class="hint">${esc(type.hint)}</div>

      <label for="f-amount">Amount${cur !== 'ZAR' ? ' (' + cur + ')' : ''}</label>
      <div class="amount-wrap"><span>${SYMBOL[cur] || cur}</span>
        <input id="f-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(form.amount)}"></div>

      ${type.person || type.who || isOpening ? `<div class="lbl">Person${isOpening ? ' (only for a person\'s opening balance)' : ''}</div>${chips('person', people, form.person, isOpening ? { none: 'No one', add: true } : { add: true })}` : ''}

      ${type.noCash ? '' : `<div class="lbl">${isTransfer ? 'From' : 'Account'}</div>
      ${chips('account', accs, form.account, isOpening ? { none: 'None' } : type.person ? { none: 'No cash' } : {})}`}

      ${isTransfer ? `<div class="lbl">To</div>${chips('to_account', accs.filter(a => a.id !== form.account), form.to_account)}` : ''}

      ${needRate ? `<label for="f-rate">Rate (rand per 1 ${cur !== 'ZAR' ? cur : accCurrency(form.to_account)})</label>
        <input id="f-rate" inputmode="decimal" placeholder="e.g. 19.85" value="${esc(form.rate)}">` : ''}

      <div class="lbl">${isTransfer && form.moveFund ? 'From fund' : 'Fund (whose money)'}</div>
      ${chips('fund', funds, form.fund, isOpening ? { none: 'None' } : {})}
      ${form.fundFrom && form.fundFrom === form.person ? `<div class="hint">Last used with ${esc(nameOf(L.people(), form.person))}.</div>` : ''}
      ${fundNote()}
      ${isTransfer ? `<div class="hint"><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit"><input type="checkbox" id="f-movefund" style="width:auto" ${form.moveFund ? 'checked' : ''}> Money also changes fund</label></div>
        ${form.moveFund ? `<div class="lbl">To fund</div>${chips('to_fund', funds.filter(f => f.id !== form.fund), form.to_fund)}` : ''}` : ''}

      ${!isTransfer && !isOpening ? `<div class="lbl">Category</div>${chips('category', cats, form.category, type.person ? { none: 'None' } : {})}` : ''}

      ${!type.person && !type.who && !isOpening && !isTransfer ? `<div class="lbl">Person (optional)</div>${chips('person', people, form.person, { none: 'No one', add: true })}` : ''}

      <label for="f-note">Note</label>
      <input id="f-note" placeholder="What was it?" value="${esc(form.note)}" enterkeyhint="done">

      <div class="two">
        <div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(form.date)}"></div>
        ${!isOpening && !type.noCash ? `<div><label for="f-fee">Bank fee (R)</label><input id="f-fee" inputmode="decimal" placeholder="0.00" value="${esc(form.fee)}"></div>` : ''}
      </div>
      ${!isOpening && isTyme ? `<button type="button" class="link" id="sms-fee">+ R0.50 SMS fee</button>` : ''}

      <button class="primary" id="save" type="submit">Save</button>
      ${SPLIT_TYPES.has(type.id) && !isOpening && (!form.account || accCurrency(form.account) === 'ZAR') ? '<button type="button" class="ghost" id="to-split">Split into parts…</button>' : ''}
      <p id="form-msg" class="hint"></p>
    </form>`;

  const f = $('entry-form');
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
      if (name === 'type') {
        form.type = val;
        const cats = (store.getJSON('lastEntry', {}).cats) || {};
        form.category = cats[val] || typeOf(val).cat || '';
        if (val === 'opening') { form.fee = ''; }
      } else if (name === 'account') {
        form.account = val;
        if (val && !(form.fundFrom && form.fundFrom === form.person)) form.fund = fundFor(val);
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
  if ($('to-split')) $('to-split').onclick = () => {
    sync();
    const pocket = form.account && postable().some(a => a.id === form.account) ? form.account : '';
    splitSeed = { mode: typeOf(form.type).dir > 0 ? 'in' : 'out', total: form.amount, date: form.date, note: form.note,
      account: pocket ? topOf(pocket) : '', fee: form.fee,
      parts: [{ type: form.type, amount: '', pocket, fund: form.fund, category: form.category, person: form.person }] };
    location.hash = '#split';
  };
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
  const amt = num(form.amount);
  if (!amt || (amt < 0 && type.id !== 'opening')) return 'Enter an amount.';
  if (!form.date) return 'Pick a date.';
  if (type.id === 'opening') {
    if (!form.account && !form.person) return 'Pick an account or a person.';
    if (form.account && !form.fund) return 'Pick the fund this money belongs to.';
    return '';
  }
  if (type.noCash) form.account = '';
  if (!form.account && !type.person) return 'Pick an account.';
  if (type.noCash && !form.category) return 'Pick a category.';
  if (!form.fund) return 'Pick a fund.';
  if (type.id === 'transfer') {
    if (!form.to_account && !(form.moveFund && form.to_fund)) return 'Pick where the money goes.';
    if (form.moveFund && !form.to_fund) return 'Pick the fund it moves to.';
  }
  if ((type.person || type.who) && !form.person) return 'Pick the person.';
  if (!type.person && type.id !== 'transfer' && !form.category) return 'Pick a category.';
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
    category: type.id === 'transfer' || type.id === 'opening' ? '' : form.category,
    person: form.person || '', fee: num(form.fee) || '', note: form.note.trim(),
  };
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
    resetForm(type.id);
    location.hash = '#home';
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save';
    msg.className = 'hint err'; msg.textContent = 'Not saved: ' + e.message;
  }
}

// ---------- Split payments ----------
// One bank or cash payment made of parts. Each part is saved as its own row (so balances and
// reports work as before), and all rows of one payment share a group_id.

const PART_TYPES = { out: ['expense', 'payment', 'gift', 'advance', 'loan', 'bring_back', 'payback'], in: ['income', 'repayment', 'borrow'] };
const SPLIT_TYPES = new Set([...PART_TYPES.out, ...PART_TYPES.in]);
const PART_LABEL = { expense: 'Spent', income: 'Income' };
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
  return { type, amount: '', pocket, fund: pf || fundFor(pocket), fundFrom: pf ? split.paid_to : '', category: '', person: split.paid_to || '', advance: '', note: '' };
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
      paid_to: '', note: seed.note || '', fee: seed.fee || '', fee_part: 0, parts: [] });
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
  const parts = cash.map(t => ({ type: t.type, amount: String(num(t.amount)), pocket: t.account, fund: t.fund,
    category: t.category || '', person: t.person || '', advance: '', note: common ? '' : (t.note || '') }));
  for (const a of adv) {
    const p = parts.find(p => p.type === 'payment' && p.person === a.person && p.fund === a.fund && !p.advance);
    if (p) p.advance = String(num(a.amount));
  }
  const feeIdx = cash.findIndex(t => num(t.fee));
  return {
    mode: typeOf(cash[0].type).dir > 0 ? 'in' : 'out',
    total: String(round2(cash.reduce((s, t) => s + num(t.amount), 0))),
    date: rows[0].date, account: topOf(cash[0].account), paid_to: rows[0].paid_to || '', note: common,
    fee: feeIdx >= 0 ? String(num(cash[feeIdx].fee)) : '', fee_part: Math.max(feeIdx, 0),
    parts, editGroup: rows[0].group_id || '', editIds: rows.map(t => t.id), open: null,
  };
}

const splitLeft = () => round2(num(split.total) - split.parts.reduce((s, p) => s + num(p.amount), 0));
function leftHtml() {
  const left = splitLeft();
  if (!num(split.total)) return '<span>Type the total first</span>';
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
  const bits = [nameOf(L.accounts(), p.pocket), nameOf(L.funds(), p.fund), what, p.person ? nameOf(L.people(), p.person) : ''];
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
    const type = typeOf(p.type);
    const cats = L.categories().filter(isActive).filter(c => { const k = String(c.kind || 'both'); return k === 'both' || (out ? k === 'expense' : k === 'income'); });
    const owed = p.person ? (b.person[p.person + '|' + (p.fund || '')] || 0) : 0;
    const showAdv = p.type === 'payment' && p.person && (owed > 0 || num(p.advance));
    return `<div class="part open">
      <div class="part-head"><b>Part ${i + 1}</b>${split.parts.length > 1 ? `<button type="button" class="link danger" data-remove="${i}">Remove</button>` : ''}</div>
      <div class="amount-wrap small-amt"><span>R</span><input id="p-amount" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(p.amount)}"></div>
      <button type="button" class="link" id="fill-rest">Fill the rest</button>
      ${pockets.length > 1 ? `<div class="lbl">Pocket</div>${chips('pocket', pockets, p.pocket)}` : ''}
      <div class="lbl">What</div>${chips('ptype', typeItems, p.type)}
      <div class="hint">${esc(type.hint || '')}</div>
      <div class="lbl">Person${type.person || type.who ? '' : ' (optional)'}</div>${chips('person', people, p.person, type.person || type.who ? { add: true } : { none: 'No one', add: true })}
      ${type.person ? '' : `<div class="lbl">Category</div>${chips('category', cats, p.category)}`}
      <div class="lbl">Fund (whose money)</div>${chips('fund', funds, p.fund)}
      ${p.fundFrom && p.fundFrom === p.person ? `<div class="hint">Last used with ${esc(nameOf(L.people(), p.person))}.</div>` : ''}
      ${showAdv ? `<label for="p-advance">Advance deducted (R)</label>
        <input id="p-advance" inputmode="decimal" placeholder="0.00" value="${esc(p.advance)}">
        <div class="hint">${owed > 0 ? `${esc(nameOf(L.people(), p.person))} owes this fund ${money(owed)}. ` : ''}Earned = paid now + advance.${owed > 0 && !num(p.advance) ? ` <button type="button" class="link" id="use-adv">Deduct ${money(owed)}</button>` : ''}</div>` : ''}
      <label for="p-note">Part note (optional)</label>
      <input id="p-note" placeholder="e.g. trips 1–15 Nov" value="${esc(p.note)}" enterkeyhint="done">
      <button type="button" class="ghost" id="done-part">Done with this part</button>
    </div>`;
  };

  const feePockets = split.parts.map((p, i) => ({ id: String(i), label: `${i + 1}. ${nameOf(L.accounts(), p.pocket)}` }));
  v.innerHTML = `
    <header><h1>${split.editGroup || split.editIds ? 'Edit payment' : 'Split payment'}</h1></header>
    <form id="split-form" autocomplete="off">
      ${chips('mode', [{ id: 'out', label: 'Money out' }, { id: 'in', label: 'Money in' }], split.mode)}
      <label for="s-total">Total ${out ? 'paid' : 'received'}</label>
      <div class="amount-wrap"><span>R</span><input id="s-total" inputmode="decimal" enterkeyhint="done" placeholder="0.00" value="${esc(split.total)}"></div>
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
  if ($('p-amount')) $('p-amount').oninput = () => { split.parts[split.open].amount = $('p-amount').value; updateLeft(); };
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
  v.querySelectorAll('[data-remove]').forEach(el => el.onclick = e => {
    e.stopPropagation(); sync();
    const i = Number(el.dataset.remove);
    split.parts.splice(i, 1);
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
      if (name === 'pocket') { p.pocket = val; if (!(p.fundFrom && p.fundFrom === p.person)) p.fund = fundFor(val); }
      else if (name === 'ptype') {
        p.type = val; const t = typeOf(val);
        if (t.cat) p.category = t.cat; else if (t.person) p.category = '';
        if (val !== 'payment') p.advance = '';
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
  if (!(num(split.total) > 0)) return 'Type the total.';
  if (!split.date) return 'Pick a date.';
  if (!split.account) return 'Pick the account.';
  for (let i = 0; i < split.parts.length; i++) {
    const p = split.parts[i], t = typeOf(p.type), n = `Part ${i + 1}: `;
    if (!(num(p.amount) > 0)) return n + 'enter an amount.';
    if (!p.pocket) return n + 'pick the pocket.';
    if (!p.fund) return n + 'pick the fund.';
    if ((t.person || t.who) && !p.person) return n + 'pick the person.';
    if (!t.person && !p.category) return n + 'pick a category.';
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
      paid_to: split.paid_to || '', source: 'app' };
    rows.push(Object.assign({}, base, { type: p.type, amount: amt, amount_zar: amt, account: p.pocket,
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
    split.parts.forEach(p => { if (p.pocket && p.fund && !p.fundFrom) fb[p.pocket] = p.fund; });
    store.setJSON('fundByAccount', fb);
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
  const data = {};
  for (const k of ['mode', 'total', 'date', 'account', 'paid_to', 'note', 'fee', 'fee_part', 'parts', 'editGroup', 'editIds']) data[k] = split[k];
  const btn = $('save-draft'); btn.disabled = true; btn.textContent = 'Saving draft…';
  try {
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
  const who = x.paid_to ? nameOf(L.people(), x.paid_to) : (x.note || 'Split payment');
  return { total, left, who, date: x.date };
}

// One payment, all parts.
function renderPay(v, gid) {
  gid = decodeURIComponent(gid || '');
  const rows = groupRows(gid);
  if (!rows.length) { v.innerHTML = '<header><h1>Payment</h1></header><p class="muted">Payment not found.</p><p><a class="link" href="#home">‹ Home</a></p>'; return; }
  const cash = cashRows(rows), adv = rows.filter(t => t.type === 'advance_used');
  const out = typeOf(cash[0].type).dir < 0;
  const total = cash.reduce((s, t) => s + num(t.amount), 0);
  const fee = cash.reduce((s, t) => s + num(t.fee), 0);
  const b = balances();
  const notes = [...new Set(cash.map(t => t.note || ''))];
  const partLine = (t, i) => {
    const type = typeOf(t.type);
    const a = adv.find(x => x.person === t.person && x.fund === t.fund && t.type === 'payment');
    const what = type.person || type.who ? (PART_LABEL[t.type] || type.label) : (nameOf(L.categories(), t.category) || PART_LABEL[t.type] || type.label);
    const bits = [nameOf(L.accounts(), t.account), nameOf(L.funds(), t.fund), what, t.person ? nameOf(L.people(), t.person) : ''].filter(Boolean);
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
      <dt>${out ? 'From' : 'Into'}</dt><dd>${esc(nameOf(L.accounts(), topOf(cash[0].account)))}</dd>
      ${rows[0].paid_to ? `<dt>${out ? 'Paid to' : 'Received from'}</dt><dd>${esc(nameOf(L.people(), rows[0].paid_to))}</dd>` : ''}
      ${notes.length === 1 && notes[0] ? `<dt>Note</dt><dd>${esc(notes[0])}</dd>` : ''}
    </dl></div>
    <h2>${cash.length} part${cash.length === 1 ? '' : 's'}</h2>
    <div class="card">${cash.map(partLine).join('')}</div>
    <button class="ghost" id="edit">Edit payment</button>
    <button class="ghost danger" id="del">Delete payment</button>
    <button class="ghost" onclick="history.back()">Back</button>`;
  $('edit').onclick = () => { split.ready = false; location.hash = '#split/edit/' + encodeURIComponent(gid); };
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
  const canEdit = SPLIT_TYPES.has(type.id) && t.account && accCurrency(t.account) === 'ZAR' && fromAccounts().some(a => a.id === topOf(t.account));
  const item = (k, val) => val === '' || val == null ? '' : `<dt>${k}</dt><dd>${esc(val)}</dd>`;
  v.innerHTML = `
    <header><h1>${esc(type.label)}</h1></header>
    <div class="card pad"><dl>
      ${item('Amount', money(num(t.amount), cur) + (cur !== 'ZAR' && num(t.amount_zar) ? ' (' + money(num(t.amount_zar)) + ')' : ''))}
      ${item('Date', niceDate(t.date))}
      ${item(isMove(t) ? 'From' : 'Account', accName(t.account))}
      ${isMove(t) ? item('To', accName(t.to_account)) : ''}
      ${item('Fund', nameOf(L.funds(), t.fund))}
      ${item('To fund', nameOf(L.funds(), t.to_fund))}
      ${item('Category', nameOf(L.categories(), t.category))}
      ${item('Person', nameOf(L.people(), t.person))}
      ${item('Rate', t.rate)}
      ${num(t.fee) ? item('Bank fee', money(num(t.fee))) : ''}
      ${item('Note', t.note)}
    </dl></div>
    ${canEdit ? '<button class="ghost" id="edit">Edit or split</button>' : ''}
    <button class="ghost danger" id="del">Delete entry</button>
    <button class="ghost" onclick="history.back()">Back</button>`;
  if ($('edit')) $('edit').onclick = () => { split.ready = false; location.hash = '#split/edit/' + encodeURIComponent(t.id); };
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
if (route()[0] === 'add') resetForm();
if (route()[0] === 'split' && route()[1] !== 'draft' && route()[1] !== 'edit') location.replace('#add');
render();
if (store.get('scriptUrl')) refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
