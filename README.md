# Mandarin Zest · Writing practice sheet maker

Type a character → ready-to-print A4 PDF: character with pinyin, meaning and radical, stroke order,
tracing rows and empty 田 / 米 / plain grids. The PDF is made in the visitor's browser.

- **Free:** 3 sheets per person, one character per sheet (email required on first download).
- **Unlimited (US$9 once, lifetime) or Club members (free):** unlimited sheets, words and lists (one page per character, up to 30 per PDF).

## Files
- `index.html`: the tool. Settings at the top of the script: `API_URL`, `PAY_URL`, `FREE_LIMIT`.
- `dict.json`: pinyin, short meaning and radical for ~9,500 characters (from Make Me a Hanzi).
- `apps-script/writing-sheets.gs`: the Google Apps Script behind it (accounts, free counter, 6-digit login codes, Stripe checks).
- `mascot-writing.png`

## How payment works
1. First download asks for an email → the Google Sheet ("Users" tab) creates the person and a private device key.
2. After 3 sheets, "Unlock" opens the Stripe Payment Link in a new tab, with the email pre-filled and the device key as `client_reference_id`.
3. The tool checks every 5 seconds; the Apps Script asks Stripe for a paid checkout with that key → plan = `paid` (for life).
4. Club members: the Apps Script looks up the email in Stripe and finds an active subscription → plan = `club` (re-checked daily, so it ends if they leave the Club).
5. Same email on a new device (or a Club member's first visit) → a 6-digit code is emailed to prove it's theirs.

The Stripe key lives only in the Apps Script's Script properties (restricted key, read-only: Checkout Sessions, Customers, Subscriptions).
Because the PDF is made in the browser, a technical visitor could get around the limit; that's accepted for a US$9 extra.

## Embed (full page, no inner scroll)
```html
<iframe src="https://antoinesjc.github.io/writing-sheets/" title="Writing practice sheets" width="100%" scrolling="no" frameborder="0" style="border:none; display:block; width:100%; height:max(1250px, min(1800px, calc((850px - 100vw) * 1000))); overflow:hidden;"></iframe>
```
(1800px on phones and small tablets where the tool is one column, 1250px on wider screens.)

Data: Make Me a Hanzi (Arphic Public License / CC-CEDICT) via hanzi-writer-data.
