# Accounting app

Phone-first home-screen web app for personal and fund accounting.

- `index.html`, `style.css`, `app.js` – the app (hosted on GitHub Pages): home screen balances, quick entry, entry list
- `apps-script/Code.gs` – the Google Apps Script that links the app to the data sheet in Google Drive

No financial data is stored in this repository. The app keeps the Apps Script link and secret key only on the device.

## Split payments (version 0.4)

One payment can be split into parts, each with its own pocket, fund, category and person
(e.g. R2,200 to Tumelo: trips from Projects, gifts from Dada Ratna and Dada Guna, cash to bring back).
Each part is one row in the Transactions tab; parts of one payment share `group_id`, and `paid_to`
holds who received the payment. An advance deducted from a payment is a row of type `advance_used`
with no account. Unfinished payments are kept in the Drafts tab.

**After merging, update the Apps Script once:** paste the new `apps-script/Code.gs` into the data
sheet's Apps Script, then Deploy > Manage deployments > edit > Version: New version > Deploy.
The link stays the same. The new columns and the Drafts tab are created on first use.
