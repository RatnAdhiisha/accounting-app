# Accounting app

Phone-first home-screen web app for personal and fund accounting.

- `index.html`, `style.css`, `app.js` – the app (hosted on GitHub Pages): home screen balances, quick entry, entry list
- `apps-script/Code.gs` – the Google Apps Script that links the app to the data sheet in Google Drive

No financial data is stored in this repository. The app keeps the Apps Script link and secret key only on the device.

## Receipts (version 0.9)

**Scan receipt** (home screen, and on the Add form for money out): pick a scanned PDF (Files app > Scan Documents,
or Notes > Share > Save to Files) or take a photo. The Apps Script saves it in the **Receipts** folder next to the
data sheet and reads shop, date, total and item lines with OpenAI. If an entry with the same amount (within 3 days)
has no receipt yet, the app offers to attach it there; otherwise the payment screen opens filled in. Tap an item's
part number to move it to another part; part amounts follow the items. On save the file is renamed
(`2026-11-20 R1486.50 Build It Soweto.pdf`), `receipt_url` is set on every part, and the items go to the
**Receipt items** tab. Entries also get **Open receipt** and **Attach receipt**.

Since 0.9.2 the payment screen opens at once: while the receipt is saved and read, pick pocket, fund and category.
When reading is done, total, date, note and items fill in (only where nothing was typed), and a matching entry
shows as **Attach to that entry instead**. Save waits until reading is done. No Apps Script change.

**After merging, set it up once:**
1. Apps Script > Project Settings > Script Properties > add `OPENAI_API_KEY` (your OpenAI key). Optional: `OPENAI_MODEL` (default `gpt-5-mini`).
2. Paste the new `apps-script/Code.gs`, Save, then run `checkReceipts` once from the editor and allow Drive and external access. The log shows the folder link and "OpenAI key works."
3. Deploy > Manage deployments > edit > Version: New version > Deploy. The link stays the same.

## Funds that owe each other (version 0.6)

Each account belongs to one fund (Dada Ratna pocket and Cash ZAR: Personal; Dada Guna pocket: Dada Guna;
Agricoop Cash: Agricoop). When another fund's money is spent from an account (an advance for Dada Guna
paid from Cash ZAR), the home screen shows "Dada Guna owes you (Personal)". **Pay back** opens a transfer
from that fund's pocket that keeps the fund the same, which settles it. The Projects pocket holds several
funds on purpose, so only overspending there counts as a debt. No Apps Script update is needed.

**Spent advance**: when someone brings the receipt for an advance, enter what it really cost (no cash moves, their debt goes down, the cost gets a category). Change they give back is a "Got back" entry.

**Paid for me**: someone bought something for you with their own money (e.g. Indrajit buys carrots). One entry, no cash: you owe them, and the cost counts as spending in its category. Later pay them back with "Paid back".

## New people (version 0.5)

Every person list has a **+ New** chip. Type a name (the app warns about names that look like
someone already in the list), an optional note, and optionally money already owed, which is saved
as an `opening` entry for a fund. The Apps Script makes the id from the name; the id never
changes, so the name can be edited in the People tab later. Picking a person fills in the fund
last used with them.

**After merging, update the Apps Script once** (same steps as below) so the app can add people.

## Split payments (version 0.4)

One payment can be split into parts, each with its own pocket, fund, category and person
(e.g. R2,200 to Tumelo: trips from Projects, gifts from Dada Ratna and Dada Guna, cash to bring back).
Each part is one row in the Transactions tab; parts of one payment share `group_id`, and `paid_to`
holds who received the payment. An advance deducted from a payment is a row of type `advance_used`
with no account. Unfinished payments are kept in the Drafts tab.

**After merging, update the Apps Script once:** paste the new `apps-script/Code.gs` into the data
sheet's Apps Script, then Deploy > Manage deployments > edit > Version: New version > Deploy.
The link stays the same. The new columns and the Drafts tab are created on first use.
