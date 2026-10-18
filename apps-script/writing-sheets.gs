/**
 * Mandarin Zest · Writing sheet maker · account & payment script
 *
 * Lives in a Google Sheet (Extensions → Apps Script). It:
 *  - remembers each email, how many free sheets they used, and their plan (free / paid / club)
 *  - sends a 6-digit code when someone uses their email on a new device
 *  - checks Stripe: a $9 lifetime payment, or an active Club subscription → unlimited
 *
 * Script properties (Project Settings → Script properties):
 *   STRIPE_KEY       a Stripe *restricted* key (rk_live_…) with READ access to:
 *                    Checkout Sessions, Customers, Subscriptions. Nothing else.
 *   PAYMENT_LINK_ID  optional, the plink_… id of the $9 Payment Link (makes payment checks faster)
 *
 * Club members you add by hand: put their emails in column A of a tab named "Club list"
 * (one per line, header optional). They get unlimited even without a Stripe subscription.
 * To give someone lifetime access by hand, set their Plan to "paid" in the Users tab.
 *
 * Deploy → New deployment → Web app → Execute as: Me → Who has access: Anyone.
 */

var FREE_LIMIT = 3;                    // free sheets per person
var SHEET_NAME = 'Users';
var CLUB_LIST = 'Club list';             // optional tab: emails in column A get Club access
var HEAD = ['Email', 'Created', 'Plan', 'Used', 'Consent', 'Paid at', 'Stripe session', 'Club checked', 'Last used', 'Code', 'Code expires', 'Key'];
var C = {}; HEAD.forEach(function (h, i) { C[h] = i; });
var CLUB_RECHECK_HOURS = 24;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json(handle(req));
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return json({ ok: true, service: 'mz-writing-sheets' }); }

function handle(req) {
  var email = String(req.email || '').trim().toLowerCase();
  if (req.action === 'ping') return { ok: true };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return { error: 'email' };
  var sh = sheet(), row = findRow(sh, email);

  // First time on this device: register, or send a code if the email is already known.
  if (req.action === 'hello') {
    if (!row) {
      var key = newKey();
      sh.appendRow([email, new Date(), 'free', 0, req.consent ? 'yes' : 'no', '', '', '', '', '', '', key]);
      row = findRow(sh, email);
      refreshClub(sh, row, email, true);
      // Club members must prove it's their email before getting unlimited.
      if (sh.getRange(row, C['Plan'] + 1).getValue() === 'club') { sendCode(sh, row, email); return { needCode: true }; }
      return state(sh, row, { key: key });
    }
    sendCode(sh, row, email);
    return { needCode: true };
  }
  if (req.action === 'code') { if (row) sendCode(sh, row, email); return { needCode: true }; }
  if (req.action === 'verify') {
    if (!row) return { error: 'code' };
    var v = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
    var ok = v[C['Code']] && String(v[C['Code']]) === String(req.code || '').trim() && new Date(v[C['Code expires']]) > new Date();
    if (!ok) return { error: 'code' };
    sh.getRange(row, C['Code'] + 1, 1, 2).setValues([['', '']]);
    var k = v[C['Key']];
    if (!k) { k = newKey(); sh.getRange(row, C['Key'] + 1).setValue(k); }   // row added by hand
    if (!v[C['Plan']]) sh.getRange(row, C['Plan'] + 1).setValue('free');
    if (v[C['Used']] === '') sh.getRange(row, C['Used'] + 1).setValue(0);
    refreshClub(sh, row, email, true);
    return state(sh, row, { key: k });
  }

  // Everything else needs the device key we gave them.
  if (!row || !authed(sh, row, req.key)) return { needCode: true };

  if (req.action === 'status') {
    if (req.check) { checkPayment(sh, row, email); refreshClub(sh, row, email, true); }
    else refreshClub(sh, row, email, false);
    return state(sh, row);
  }
  if (req.action === 'use') {
    refreshClub(sh, row, email, false);
    var r = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
    var plan = r[C['Plan']], used = Number(r[C['Used']]) || 0;
    if (plan === 'free' && used >= FREE_LIMIT) {
      checkPayment(sh, row, email);                       // maybe they just paid
      r = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
      plan = r[C['Plan']];
      if (plan === 'free') return state(sh, row, { ok: false });
    }
    sh.getRange(row, C['Used'] + 1).setValue(used + (Number(req.pages) || 1));
    sh.getRange(row, C['Last used'] + 1).setValue(new Date());
    return state(sh, row, { ok: true });
  }
  return { error: 'action' };
}

/* ---------- helpers ---------- */
function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) { sh.appendRow(HEAD); sh.setFrozenRows(1); }
  return sh;
}
function findRow(sh, email) {
  var n = sh.getLastRow(); if (n < 2) return 0;
  var f = sh.getRange(2, 1, n - 1, 1).createTextFinder(email).matchEntireCell(true).findNext();
  return f ? f.getRow() : 0;
}
function authed(sh, row, key) { return key && String(sh.getRange(row, C['Key'] + 1).getValue()) === String(key); }
function newKey() { return Utilities.getUuid().replace(/-/g, ''); }
function state(sh, row, extra) {
  var r = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
  var plan = r[C['Plan']] || 'free', used = Number(r[C['Used']]) || 0;
  var out = { plan: plan, used: used, limit: FREE_LIMIT, left: plan === 'free' ? Math.max(0, FREE_LIMIT - used) : null };
  for (var k in (extra || {})) out[k] = extra[k];
  return out;
}
function sendCode(sh, row, email) {
  var code = String(Math.floor(100000 + Math.random() * 900000));
  sh.getRange(row, C['Code'] + 1, 1, 2).setValues([[code, new Date(Date.now() + 20 * 60 * 1000)]]);
  MailApp.sendEmail({
    to: email,
    subject: code + ' is your Mandarin Zest code',
    htmlBody: '<div style="font-family:Arial,sans-serif;font-size:16px;color:#2a2420">' +
      '<p>Here is your code for the Mandarin Zest writing sheet maker:</p>' +
      '<p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#e2632f">' + code + '</p>' +
      '<p>It works for 20 minutes. If you didn\'t ask for it, you can ignore this email.</p>' +
      '<p>加油！<br>Mandarin Zest</p></div>',
    name: 'Mandarin Zest'
  });
}

/* ---------- Stripe ---------- */
function stripe(path) {
  var key = PropertiesService.getScriptProperties().getProperty('STRIPE_KEY');
  if (!key) return null;
  var res = UrlFetchApp.fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.warn('Stripe ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300)); return null; }
  return JSON.parse(res.getContentText());
}
// $9 lifetime: find a paid checkout for this person (by our key, or by their email).
function checkPayment(sh, row, email) {
  var r = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
  if (r[C['Plan']] === 'paid') return true;
  var link = PropertiesService.getScriptProperties().getProperty('PAYMENT_LINK_ID');
  var list = stripe('checkout/sessions?limit=100' + (link ? '&payment_link=' + encodeURIComponent(link) : ''));
  if (!list || !list.data) return false;
  var key = String(r[C['Key']]);
  var hit = list.data.filter(function (s) {
    if (s.payment_status !== 'paid') return false;
    if (s.client_reference_id && s.client_reference_id === key) return true;
    var em = (s.customer_details && s.customer_details.email || s.customer_email || '').toLowerCase();
    return link && em === email;                      // only trust email matches on the dedicated link
  })[0];
  if (!hit) return false;
  sh.getRange(row, C['Plan'] + 1).setValue('paid');
  sh.getRange(row, C['Paid at'] + 1).setValue(new Date(hit.created * 1000));
  sh.getRange(row, C['Stripe session'] + 1).setValue(hit.id);
  return true;
}
// Club: any active (or trialing) subscription under this email.
function inClubList(email) {
  var t = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLUB_LIST);
  if (!t || t.getLastRow() < 1) return false;
  return t.getRange(1, 1, t.getLastRow(), 1).getValues().some(function (r) { return String(r[0]).trim().toLowerCase() === email; });
}
function refreshClub(sh, row, email, force) {
  var r = sh.getRange(row, 1, 1, HEAD.length).getValues()[0];
  if (r[C['Plan']] === 'paid') return;
  if (inClubList(email)) {                              // added by hand: always Club
    if (r[C['Plan']] !== 'club') sh.getRange(row, C['Plan'] + 1).setValue('club');
    return;
  }
  var last = r[C['Club checked']] ? new Date(r[C['Club checked']]) : null;
  if (!force && last && (Date.now() - last.getTime()) < CLUB_RECHECK_HOURS * 3600 * 1000) return;
  var customers = stripe('customers?limit=10&email=' + encodeURIComponent(email));
  if (!customers) return;                              // Stripe not set up or down: keep the current plan
  var club = (customers.data || []).some(function (c) {
    var subs = stripe('subscriptions?status=all&limit=20&customer=' + encodeURIComponent(c.id));
    return subs && (subs.data || []).some(function (s) { return s.status === 'active' || s.status === 'trialing' || s.status === 'past_due'; });
  });
  sh.getRange(row, C['Club checked'] + 1).setValue(new Date());
  if (club && r[C['Plan']] !== 'club') sh.getRange(row, C['Plan'] + 1).setValue('club');
  if (!club && r[C['Plan']] === 'club') sh.getRange(row, C['Plan'] + 1).setValue('free');
}
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* Run once from the editor to check your Stripe key works (see View → Logs). */
function testStripe() {
  console.log(stripe('checkout/sessions?limit=1') ? 'Stripe key works ✓' : 'Stripe key missing or wrong ✗');
}
