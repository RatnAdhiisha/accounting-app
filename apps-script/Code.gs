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
              'fee', 'note', 'receipt_url', 'created_at'],
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
        const headers = TABS.Transactions.headers;
        const t = Object.assign({}, req.data, {
          id: Utilities.getUuid(), created_at: new Date().toISOString() });
        sh.appendRow(headers.map(h => t[h] === undefined ? '' : t[h]));
        return json_({ ok: true, data: { id: t.id } });
      }
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
