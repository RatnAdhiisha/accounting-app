// Accounting app, version 0.2: quick entry, balances home screen, entry list.
'use strict';

const VERSION = '0.2';
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
  { id: 'loan',      label: 'Lent',      dir: -1, person: +1, hint: 'You lend money. They will owe you.' },
  { id: 'advance',   label: 'Advance',   dir: -1, person: +1, hint: 'Paid ahead of a payment. They owe it until it is deducted.' },
  { id: 'repayment', label: 'Got back',  dir: +1, person: -1, hint: 'Someone pays you back. Their debt goes down.' },
  { id: 'borrow',    label: 'Borrowed',  dir: +1, person: -1, hint: 'You borrow money. You will owe them.' },
  { id: 'payback',   label: 'Paid back', dir: -1, person: +1, hint: 'You pay back what you borrowed.' },
  { id: 'opening',   label: 'Opening',   dir: +1, hint: 'Starting balance of an account, or what a person owes you (minus if you owe them).' },
  // Used by the sheet import; not offered as buttons.
  { id: 'exchange',      label: 'Exchange',      dir: 0, hidden: true },
  { id: 'fund_transfer', label: 'Fund transfer', dir: 0, hidden: true },
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
    add(acc, t.account, amt);
    add(fund, t.fund, zar);
    add(person, t.person, zar);
  } else {
    add(acc, t.account, type.dir * amt - feeAcc);
    add(fund, t.fund, type.dir * zar - feeZar);
    if (type.person) add(person, t.person, type.person * zar);
  }
  return { acc, fund, person, zar, feeZar };
}

function balances() {
  const acc = {}, fund = {}, person = {};
  const merge = (to, from) => { for (const k in from) to[k] = (to[k] || 0) + from[k]; };
  for (const t of state.txs) { const e = effects(t); merge(acc, e.acc); merge(fund, e.fund); merge(person, e.person); }
  // Round to cents so tiny floating-point leftovers don't show as red −R0.00.
  for (const o of [acc, fund, person]) for (const k in o) o[k] = Math.round(o[k] * 100) / 100 || 0;
  return { acc, fund, person };
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

  const owed = L.people().map(p => ({ p, x: b.person[p.id] || 0 })).filter(o => Math.abs(o.x) > 0.004)
    .sort((a, b) => b.x - a.x);
  const peopleRows = owed.length ? owed.map(({ p, x }) =>
    `<div class="row"><span class="name">${esc(p.name)} <span class="muted small">${x > 0 ? 'owes you' : 'you owe'}</span></span><span class="amt ${x < 0 ? 'neg' : ''}">${money(Math.abs(x))}</span></div>`
  ).join('') : '<div class="empty small">Nobody owes anything.</div>';
  const owesMe = owed.filter(o => o.x > 0).reduce((s, o) => s + o.x, 0);
  const iOwe = owed.filter(o => o.x < 0).reduce((s, o) => s - o.x, 0);

  const recent = sortedTxs().slice(0, 5);

  v.innerHTML = `
    <header><h1>Accounting</h1><button class="refresh" id="refresh">↻ Refresh</button></header>
    <div>${statusLine()}</div>
    <div class="total-box">
      <div class="small">All money${missingRate ? ' (foreign cash without a rate left out)' : ''}</div>
      <div class="big">${money(totalZar)}</div>
      ${owesMe || iOwe ? `<div class="small">${owesMe ? 'Owed to you ' + money(owesMe) : ''}${owesMe && iOwe ? ' · ' : ''}${iOwe ? 'You owe ' + money(iOwe) : ''}</div>` : ''}
    </div>
    <h2>Accounts</h2><div class="card">${accRows}</div>
    <h2>Funds (whose money)</h2><div class="card">${fundRows}</div>
    <h2>People</h2><div class="card">${peopleRows}</div>
    <h2>Recent</h2><div class="card">${recent.length ? recent.map(txRow).join('') : '<div class="empty small">No entries yet. Tap + to add one.</div>'}</div>
    ${recent.length ? '<p><a class="link" href="#list">All entries ›</a></p>' : ''}
  `;
  $('refresh').onclick = refresh;
  bindTxRows(v);
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
  const bits = [niceDate(t.date), isMove(t) ? type.label : accName(t.account),
    nameOf(L.funds(), t.fund), t.person ? nameOf(L.people(), t.person) : ''].filter(Boolean);
  return `<div class="tx" data-id="${esc(t.id)}"><div class="l"><div class="t1">${esc(txTitle(t))}</div><div class="t2">${esc(bits.join(' · '))}</div></div>
    <div class="amt ${type.dir > 0 && type.id !== 'opening' ? 'in' : ''}">${sign}${money(amt, cur)}</div></div>`;
}
function bindTxRows(v) {
  v.querySelectorAll('.tx[data-id]').forEach(el => el.onclick = () => { location.hash = '#tx/' + encodeURIComponent(el.dataset.id); });
}

// ---------- Quick entry ----------

const form = {}; // current form values

function resetForm(keepType) {
  const last = store.getJSON('lastEntry', {});
  const type = keepType || last.type || 'expense';
  const accounts = postable();
  const account = (last.account && accounts.some(a => a.id === last.account)) ? last.account : (accounts[0] && accounts[0].id) || '';
  Object.assign(form, {
    type, amount: '', account, to_account: '', fund: fundFor(account), to_fund: '',
    category: (last.cats || {})[type] || '', person: '', note: '', date: localDay(new Date()),
    fee: '', rate: '', moveFund: false,
  });
}
function fundFor(account) {
  const remembered = store.getJSON('fundByAccount', {});
  return remembered[account] || DEFAULT_FUND[account] || (L.funds()[0] && L.funds()[0].id) || '';
}

function chips(name, items, value, opts = {}) {
  return `<div class="chips" data-name="${name}">${opts.none ? `<button type="button" class="chip ${!value ? 'on' : ''}" data-v="">${esc(opts.none)}</button>` : ''}${
    items.map(i => `<button type="button" class="chip ${i.main ? 'main' : ''} ${i.id === value ? 'on' : ''}" data-v="${esc(i.id)}">${esc(i.label || i.name)}</button>`).join('')}</div>`;
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

      ${type.person || isOpening ? `<div class="lbl">Person${isOpening ? ' (only for a person\'s opening balance)' : ''}</div>${chips('person', people, form.person, isOpening ? { none: 'No one' } : {})}` : ''}

      <div class="lbl">${isTransfer ? 'From' : 'Account'}</div>
      ${chips('account', accs, form.account, isOpening ? { none: 'None' } : {})}

      ${isTransfer ? `<div class="lbl">To</div>${chips('to_account', accs.filter(a => a.id !== form.account), form.to_account)}` : ''}

      ${needRate ? `<label for="f-rate">Rate (rand per 1 ${cur !== 'ZAR' ? cur : accCurrency(form.to_account)})</label>
        <input id="f-rate" inputmode="decimal" placeholder="e.g. 19.85" value="${esc(form.rate)}">` : ''}

      <div class="lbl">${isTransfer && form.moveFund ? 'From fund' : 'Fund (whose money)'}</div>
      ${chips('fund', funds, form.fund, isOpening ? { none: 'None' } : {})}
      ${isTransfer ? `<div class="hint"><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit"><input type="checkbox" id="f-movefund" style="width:auto" ${form.moveFund ? 'checked' : ''}> Money also changes fund</label></div>
        ${form.moveFund ? `<div class="lbl">To fund</div>${chips('to_fund', funds.filter(f => f.id !== form.fund), form.to_fund)}` : ''}` : ''}

      ${!isTransfer && !isOpening ? `<div class="lbl">Category</div>${chips('category', cats, form.category, type.person ? { none: 'None' } : {})}` : ''}

      ${!type.person && !isOpening && !isTransfer ? `<div class="lbl">Person (optional)</div>${chips('person', people, form.person, { none: 'No one' })}` : ''}

      <label for="f-note">Note</label>
      <input id="f-note" placeholder="What was it?" value="${esc(form.note)}" enterkeyhint="done">

      <div class="two">
        <div><label for="f-date">Date</label><input id="f-date" type="date" value="${esc(form.date)}"></div>
        ${!isOpening ? `<div><label for="f-fee">Bank fee (R)</label><input id="f-fee" inputmode="decimal" placeholder="0.00" value="${esc(form.fee)}"></div>` : ''}
      </div>
      ${!isOpening && isTyme ? `<button type="button" class="link" id="sms-fee">+ R0.50 SMS fee</button>` : ''}

      <button class="primary" id="save" type="submit">Save</button>
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
      if (name === 'type') {
        form.type = val;
        const cats = (store.getJSON('lastEntry', {}).cats) || {};
        form.category = cats[val] || '';
        if (val === 'opening') { form.fee = ''; }
      } else if (name === 'account') {
        form.account = val; form.fund = fundFor(val);
        if (form.to_account === val) form.to_account = '';
      } else {
        form[name] = (form[name] === val && name !== 'fund') ? '' : val;
      }
      renderAdd(v);
    };
  });
  if ($('f-movefund')) $('f-movefund').onchange = e => { sync(); form.moveFund = e.target.checked; form.to_fund = ''; renderAdd(v); };
  if ($('sms-fee')) $('sms-fee').onclick = () => { $('f-fee').value = (num($('f-fee').value) + 0.5).toFixed(2); };
  f.onsubmit = async e => { e.preventDefault(); sync(); await saveEntry(); };
}

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
  if (!form.account) return 'Pick an account.';
  if (!form.fund) return 'Pick a fund.';
  if (type.id === 'transfer') {
    if (!form.to_account && !(form.moveFund && form.to_fund)) return 'Pick where the money goes.';
    if (form.moveFund && !form.to_fund) return 'Pick the fund it moves to.';
  }
  if (type.person && !form.person) return 'Pick the person.';
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
    if (form.account && form.fund) { const fb = store.getJSON('fundByAccount', {}); fb[form.account] = form.fund; store.setJSON('fundByAccount', fb); }
    toast(`Saved ${money(amt, cur)}`);
    resetForm(type.id);
    location.hash = '#home';
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Save';
    msg.className = 'hint err'; msg.textContent = 'Not saved: ' + e.message;
  }
}

// ---------- Entry list and detail ----------

const listFilter = { q: '', account: '', fund: '', person: '', month: '' };
function renderList(v) {
  const months = [...new Set(state.txs.map(t => (t.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const opt = (arr, val, all) => `<option value="">${all}</option>` + arr.map(r => `<option value="${esc(r.id)}" ${r.id === val ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const rows = sortedTxs().filter(t => {
    if (listFilter.account && t.account !== listFilter.account && t.to_account !== listFilter.account) return false;
    if (listFilter.fund && t.fund !== listFilter.fund && t.to_fund !== listFilter.fund) return false;
    if (listFilter.person && t.person !== listFilter.person) return false;
    if (listFilter.month && !(t.date || '').startsWith(listFilter.month)) return false;
    if (listFilter.q) {
      const hay = [t.note, accName(t.account), nameOf(L.categories(), t.category), nameOf(L.people(), t.person), nameOf(L.funds(), t.fund), t.amount].join(' ').toLowerCase();
      if (!hay.includes(listFilter.q.toLowerCase())) return false;
    }
    return true;
  });
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
    <p class="muted small">${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</p>
    <div class="card">${rows.length ? rows.slice(0, 300).map(txRow).join('') : '<div class="empty small">Nothing found.</div>'}</div>`;
  $('refresh').onclick = refresh;
  $('q').oninput = e => { listFilter.q = e.target.value; const pos = e.target.selectionStart; renderList(v); const q = $('q'); q.focus(); q.setSelectionRange(pos, pos); };
  ['month', 'account', 'fund', 'person'].forEach(k => $('fl-' + k).onchange = e => { listFilter[k] = e.target.value; renderList(v); });
  bindTxRows(v);
}

function renderTx(v, id) {
  id = decodeURIComponent(id || '');
  const t = state.txs.find(x => x.id === id);
  if (!t) { v.innerHTML = '<header><h1>Entry</h1></header><p class="muted">Entry not found.</p><p><a class="link" href="#home">‹ Home</a></p>'; return; }
  const type = typeOf(t.type), cur = accCurrency(t.account);
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
    <button class="ghost danger" id="del">Delete entry</button>
    <button class="ghost" onclick="history.back()">Back</button>`;
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

window.addEventListener('hashchange', () => { if (route()[0] === 'add') resetForm(); render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.get('scriptUrl')) refresh(); });
if (route()[0] === 'add') resetForm();
render();
if (store.get('scriptUrl')) refresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
