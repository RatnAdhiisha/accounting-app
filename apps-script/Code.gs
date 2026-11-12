/**
 * Accounting app – data link.
 * Paste this into Extensions > Apps Script of the "Accounting App Data" sheet.
 * 1. Run setup() once: it creates the tabs and lists, and prints your secret key.
 * 2. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 */

const TABS = {
  Accounts: {
    headers: ['id', 'name', 'parent', 'type', 'currency', 'active', 'note'],
    rows: [
      ['tyme',          'TymeBank',      '',     'bank',   'ZAR', true,  'One account with three pockets'],
      ['tyme-ratna',    'Dada Ratna',    'tyme', 'pocket', 'ZAR', true,  ''],
      ['tyme-guna',     'Dada Guna',     'tyme', 'pocket', 'ZAR', true,  ''],
      ['tyme-transit',  'Transit',       'tyme', 'pocket', 'ZAR', true,  ''],
      ['fnb',           'FNB',           '',     'bank',   'ZAR', false, 'Closed 8 Sep 2026'],
      ['cash-zar',      'Cash ZAR',      '',     'cash',   'ZAR', true,  ''],
      ['cash-eur',      'Cash EUR',      '',     'cash',   'EUR', true,  ''],
      ['agricoop-cash', 'Agricoop Cash', '',     'cash',   'ZAR', true,  ''],
    ],
  },
  Funds: {
    headers: ['id', 'name', 'active', 'note'],
    rows: [
      ['personal', 'Personal',                true, ''],
      ['guna',     'Dada Guna',               true, ''],
      ['feeding',  "Dada K's feeding program", true, ''],
      ['amsai',    'AMSAI solar',             true, ''],
      ['agricoop', 'Agricoop',                true, ''],
      ['ajbulk',   'AJ Bulk',                 true, 'Stock paid from the feeding program'],
    ],
  },
  Categories: {
    headers: ['id', 'name', 'kind', 'active', 'note'],
    rows: [
      ['donations',      'Donations',      'both',    true, ''],
      ['communication',  'Communication',  'expense', true, 'Includes phone data'],
      ['subscriptions',  'Subscriptions',  'expense', true, ''],
      ['fees',           'Fees',           'expense', true, ''],
      ['groceries',      'Groceries',      'expense', true, ''],
      ['transportation', 'Transportation', 'expense', true, ''],
      ['stipends',       'Stipends',       'both',    true, ''],
      ['investments',    'Investments',    'expense', true, 'Support to people and the Agricoop initiative'],
      ['expenses',       'Expenses',       'expense', true, ''],
      ['sales',          'Sales',          'income',  true, ''],
      ['exchange',       'Exchange',       'both',    true, ''],
      ['miscellaneous',  'Miscellaneous',  'both',    true, ''],
    ],
  },
  People: {
    headers: ['id', 'name', 'active', 'note'],
    rows: [
      ['mohapi',    'Mohapi',    true, ''],
      ['dadak',     'Dada K',    true, ''],
      ['indrajiit', 'Indrajiit', true, ''],
      ['tumelo',    'Tumelo',    true, ''],
      ['phillemon', 'Phillemon', true, ''],
      ['stanley',   'Stanley',   true, ''],
      ['abel',      'Abel',      true, ''],
      ['gugu',      'Gugu',      true, 'Advance until salary, 4 Nov 2026'],
    ],
  },
  Transactions: {
    headers: ['id', 'date', 'type', 'amount', 'currency', 'rate', 'amount_zar',
              'account', 'to_account', 'fund', 'to_fund', 'category', 'person',
              'fee', 'note', 'receipt_url', 'created_at', 'source', 'group_id', 'paid_to'],
    rows: [],
  },
  // Unfinished split payments. "data" holds the app's form as text.
  Drafts: {
    headers: ['id', 'updated_at', 'data'],
    rows: [],
  },
};

/** Run once from the editor. Safe to run again: it only fills tabs that are empty. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.entries(TABS).forEach(([name, def]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      if (def.rows.length) sh.getRange(2, 1, def.rows.length, def.headers.length).setValues(def.rows);
      sh.setFrozenRows(1);
    }
  });
  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);

  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('API_KEY', key);
  }
  console.log('Your secret key: ' + key);
}

function readTab_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const [headers, ...rows] = sh.getDataRange().getValues();
  return rows.filter(r => r.some(v => v !== '')).map(r =>
    Object.fromEntries(headers.map((h, i) => [h, r[i] instanceof Date ? r[i].toISOString() : r[i]])));
}

// The tab, created with its headers if it doesn't exist yet.
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    const h = TABS[name].headers;
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// The tab's headers, adding any missing ones at the end (older sheets keep their columns and rows).
function headers_(sh, want) {
  let h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const missing = want.filter(x => !h.includes(x));
  if (missing.length) {
    sh.getRange(1, h.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    h = h.concat(missing);
  }
  return h;
}

function appendRows_(sh, headers, objs) {
  if (!objs.length) return;
  const values = objs.map(t => headers.map(h => t[h] === undefined ? '' : t[h]));
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

// Deletes every row for which test(row object) is true. Returns how many.
function deleteRowsWhere_(sh, test) {
  const data = sh.getDataRange().getValues();
  const h = data[0];
  let n = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    const row = Object.fromEntries(h.map((k, j) => [k, data[i][j]]));
    if (test(row)) { sh.deleteRow(i + 1); n++; }
  }
  return n;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  const real = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!real || key !== real) throw new Error('Wrong secret key');
}

function doGet(e) {
  try {
    checkKey_(e.parameter.key);
    switch (e.parameter.action) {
      case 'ping':  return json_({ ok: true, data: 'pong' });
      case 'lists': return json_({ ok: true, data: {
        Accounts: readTab_('Accounts'), Funds: readTab_('Funds'),
        Categories: readTab_('Categories'), People: readTab_('People') } });
      case 'transactions': return json_({ ok: true, data: readTab_('Transactions') });
      case 'drafts': return json_({ ok: true, data: readTab_('Drafts') });
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const req = JSON.parse(e.postData.contents);
    checkKey_(req.key);
    lock.waitLock(10000);
    switch (req.action) {
      case 'addTransaction': {
        const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Transactions');
        const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
        const t = Object.assign({}, req.data, {
          id: Utilities.getUuid(), created_at: new Date().toISOString() });
        sh.appendRow(headers.map(h => t[h] === undefined ? '' : t[h]));
        return json_({ ok: true, data: { id: t.id } });
      }
      case 'deleteTransaction': {
        const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Transactions');
        const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
        for (let i = ids.length - 1; i >= 1; i--) {
          if (ids[i][0] === req.data.id) { sh.deleteRow(i + 1); return json_({ ok: true, data: { id: req.data.id } }); }
        }
        throw new Error('Entry not found');
      }
      // A payment with one or more parts: one row per part, all with the same group_id.
      // When editing, the old rows are removed only after the new ones are written.
      case 'savePayment': {
        const d = req.data;
        if (!d.rows || !d.rows.length) throw new Error('No parts to save');
        const sh = sheet_('Transactions');
        const headers = headers_(sh, TABS.Transactions.headers);
        const group = d.group_id || Utilities.getUuid();
        const now = new Date().toISOString();
        const rows = d.rows.map(r => Object.assign({}, r, { id: Utilities.getUuid(), group_id: group, created_at: now }));
        appendRows_(sh, headers, rows);
        const keep = new Set(rows.map(r => r.id));
        const replaceIds = new Set(d.replace_ids || []);
        deleteRowsWhere_(sh, r => !keep.has(r.id) &&
          ((d.group_id && r.group_id === d.group_id) || replaceIds.has(r.id)));
        if (d.draft_id) deleteRowsWhere_(sheet_('Drafts'), r => r.id === d.draft_id);
        return json_({ ok: true, data: { group_id: group, ids: rows.map(r => r.id), created_at: now } });
      }
      case 'deletePayment': {
        const g = req.data.group_id;
        if (!g) throw new Error('No payment given');
        const n = deleteRowsWhere_(sheet_('Transactions'), r => r.group_id === g);
        if (!n) throw new Error('Payment not found');
        return json_({ ok: true, data: { group_id: g, deleted: n } });
      }
      case 'saveDraft': {
        const sh = sheet_('Drafts');
        const headers = headers_(sh, TABS.Drafts.headers);
        const id = req.data.id || Utilities.getUuid();
        const row = { id, updated_at: new Date().toISOString(), data: req.data.data };
        deleteRowsWhere_(sh, r => r.id === id);
        appendRows_(sh, headers, [row]);
        return json_({ ok: true, data: row });
      }
      case 'deleteDraft': {
        deleteRowsWhere_(sheet_('Drafts'), r => r.id === req.data.id);
        return json_({ ok: true, data: { id: req.data.id } });
      }
      // A new person from the app. The id is made from the name and never changes;
      // the name can be edited in the sheet later.
      case 'addPerson': {
        const name = String(req.data.name || '').trim();
        if (!name) throw new Error('No name given');
        const sh = sheet_('People');
        const headers = headers_(sh, TABS.People.headers);
        const people = readTab_('People');
        const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const same = people.find(p => squash(p.name) === squash(name));
        if (same) throw new Error(same.name + ' is already in the list');
        const base = squash(name) || 'person';
        let id = base, n = 2;
        while (people.some(p => String(p.id) === id)) id = base + n++;
        const row = { id, name, active: true, note: String(req.data.note || '').trim() };
        appendRows_(sh, headers, [row]);
        return json_({ ok: true, data: row });
      }
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
