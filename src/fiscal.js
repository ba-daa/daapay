// Fiscalization of non-cash invoices with the Montenegrin Tax Administration (UPC), following
// "Tehnička specifikacija v5": IKOF (§4.3.2), RegisterInvoiceRequest (§3.7), XML signature (§4.3.1), QR (§3.7.7).
// The request element is written directly in exclusive-C14N form (sorted attributes, explicit end tags,
// no whitespace), so the digest computed here is the digest the service computes after canonicalization.
export const FS_URL = { prod: 'https://efi.tax.gov.me/fs-v1', test: 'https://efitest.tax.gov.me/fs-v1' };
export const QR_URL = { prod: 'https://mapr.tax.gov.me/ic/#/verify', test: 'https://efitest.tax.gov.me/ic/#/verify' };
const NS = 'https://efi.tax.gov.me/fs/schema', DS = 'http://www.w3.org/2000/09/xmldsig#';
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b) => { let s = ''; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const pemBody = (pem, label) => (String(pem).match(new RegExp('-----BEGIN ' + label + '-----([\\s\\S]*?)-----END ' + label + '-----')) || [])[1]?.replace(/\s+/g, '') || '';

// MD5 (RFC 1321) — the IKOF is the MD5 of the IKOF signature; Web Crypto has no MD5 everywhere.
export function md5(bytes) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const n = bytes.length, len = (((n + 8) >> 6) + 1) * 64, m = new Uint8Array(len); m.set(bytes); m[n] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(len - 8, (n * 8) >>> 0, true); dv.setUint32(len - 4, Math.floor(n / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  for (let o = 0; o < len; o += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getInt32(o + g * 4, true)) | 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new DataView(new ArrayBuffer(16)); [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true));
  return hex(out.buffer);
}

export async function importKey(pkcs8Pem) {
  const der = Uint8Array.from(atob(pemBody(pkcs8Pem, 'PRIVATE KEY')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
const sign = async (key, s) => new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(s)));

// §4.3.2: issuerTIN|dateTimeIssued|invOrdNum|busUnitCode|tcrCode|softCode|totPrice → RSA-SHA256 → MD5.
export async function ikof(key, p) {
  const sig = await sign(key, [p.tin, p.issued, p.ord, p.bu, p.tcr, p.sw, p.total].join('|'));
  return { iic: md5(sig).toUpperCase(), iicSignature: hex(sig).toUpperCase() };
}

// Montenegro local time with offset, e.g. 2026-11-09T10:15:00+01:00 (UTCSType).
export function podgoricaIso(ms) {
  const d = new Date(ms), p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Podgorica', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second), off = Math.round((local - Math.floor(ms / 1000) * 1000) / 60000);
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0'), mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, '0')}:${p.minute}:${p.second}${off < 0 ? '-' : '+'}${hh}:${mm}`;
}

// ---- canonical XML helpers (exclusive C14N output form)
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
function el(name, attrs, children, nsDecl) {
  const a = Object.entries(attrs || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return '<' + name + (nsDecl ? ' xmlns="' + nsDecl + '"' : '') + a.map(([k, v]) => ' ' + k + '="' + escAttr(v) + '"').join('') + '>' + (children || []).join('') + '</' + name + '>';
}
const d2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const d4 = (n) => { let s = (Math.round((Number(n) || 0) * 1e4) / 1e4).toFixed(4); while (s.endsWith('0') && s.split('.')[1].length > 2) s = s.slice(0, -1); return s; };
const q3 = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const COUNTRY = { 'crna gora': 'MNE', montenegro: 'MNE', mne: 'MNE', srbija: 'SRB', serbia: 'SRB', hrvatska: 'HRV', croatia: 'HRV', 'bosna i hercegovina': 'BIH', bih: 'BIH', 'bosnia and herzegovina': 'BIH', slovenija: 'SVN', slovenia: 'SVN', albanija: 'ALB', albania: 'ALB', 'sjeverna makedonija': 'MKD', 'north macedonia': 'MKD', njemačka: 'DEU', germany: 'DEU', austrija: 'AUT', austria: 'AUT', italija: 'ITA', italy: 'ITA', 'velika britanija': 'GBR', 'united kingdom': 'GBR', sad: 'USA', usa: 'USA', 'united states': 'USA', francuska: 'FRA', france: 'FRA', švajcarska: 'CHE', switzerland: 'CHE', holandija: 'NLD', netherlands: 'NLD' };
export const countryCode = (c) => { const t = String(c || '').trim(); return /^[A-Z]{3}$/.test(t) ? t : COUNTRY[t.toLowerCase()] || ''; };

// Lines and totals the way DAA Pay calculates them (2-decimal line totals; sums of lines = totals).
export function lineAmounts(l, inVat) {
  const rate = inVat ? Number(l.rate) || 0 : 0, q = Number(l.qty) || 0, disc = Number(l.disc) || 0, k = 1 - disc / 100;
  let net, gross;
  if (l.mode === 'gross') { gross = Math.round(q * (Number(l.priceGross) || 0) * k * 100) / 100; net = Math.round(gross / (1 + rate / 100) * 100) / 100; }
  else { net = Math.round(q * (Number(l.price) || 0) * k * 100) / 100; gross = Math.round(net * (1 + rate / 100) * 100) / 100; }
  const upb = l.mode === 'gross' ? (Number(l.priceGross) || 0) / (1 + rate / 100) : Number(l.price) || 0;
  return { q, rate, disc, net, gross, vat: Math.round((gross - net) * 100) / 100, upb };
}

// Builds and signs RegisterInvoiceRequest; returns { envelope, iic, iicSignature, issued, uuid }.
export async function buildRequest({ key, certPem, inv, co, ord, year, operator, now, corrective, subseq, issuedAt }) {
  const inVat = inv.vatPayer !== false, sign1 = corrective ? -1 : 1;
  const lines = (inv.lines || []).filter((l) => String(l.name || '').trim()).map((l) => lineAmounts(l, inVat)).map((a, i) => Object.assign(a, { src: inv.lines.filter((l) => String(l.name || '').trim())[i] }));
  const tot = lines.reduce((t, a) => ({ net: t.net + a.net, vat: t.vat + a.vat, gross: t.gross + a.gross }), { net: 0, vat: 0, gross: 0 });
  const T = { net: d2(sign1 * tot.net), vat: d2(sign1 * tot.vat), gross: d2(sign1 * tot.gross) };
  const issued = issuedAt || podgoricaIso(now), f = co.fiscal, b = inv.buyer || {};   // a re-send keeps the original time (same IKOF)
  const { iic, iicSignature } = await ikof(key, { tin: co.pib, issued, ord, bu: f.bu, tcr: f.enu, sw: f.sw, total: T.gross });
  const items = lines.map((a) => el('I', {
    N: cut(a.src.name, 50), U: cut(a.src.unitLabel || a.src.unit || 'kom', 50), Q: q3(sign1 * a.q), UPB: d4(a.upb), UPA: d4(a.q ? a.gross / a.q : 0),
    R: a.disc ? d2(a.disc) : undefined, RR: a.disc ? 'true' : undefined, PB: d2(sign1 * a.net), PA: d2(sign1 * a.gross),
    VR: inVat ? d2(a.rate) : undefined, VA: inVat ? d2(sign1 * a.vat) : undefined, EX: inVat && !a.rate && a.src.exempt ? a.src.exempt : undefined
  }));
  const rates = {}; if (inVat) lines.forEach((a) => { const r = d2(a.rate); rates[r] = rates[r] || { n: 0, base: 0, vat: 0 }; rates[r].n++; rates[r].base += a.net; rates[r].vat += a.vat; });
  const same = Object.keys(rates).sort().map((r) => el('SameTax', { NumOfItems: String(rates[r].n), PriceBefVAT: d2(sign1 * rates[r].base), VATRate: r, VATAmt: d2(sign1 * rates[r].vat) }));
  const cc = countryCode(b.country) || 'MNE';
  const children = [
    corrective ? el('CorrectiveInv', { IICRef: corrective.iic, IssueDateTime: corrective.issued, Type: 'CORRECTIVE' }) : '',
    el('PayMethods', {}, [el('PayMethod', { Type: inv.payMethod || 'ACCOUNT', Amt: T.gross })]),
    el('Seller', { IDType: 'TIN', IDNum: co.pib, Name: cut(co.name, 100), Address: cut(co.address, 200), Town: cut(co.town, 100), Country: 'MNE' }),
    el('Buyer', { IDType: cc === 'MNE' ? 'TIN' : 'VAT', IDNum: cut(b.pib, 20), Name: cut(b.name, 100), Address: cut(b.address, 200), Town: cut(b.town, 100), Country: countryCode(b.country) || undefined }),
    el('Items', {}, items),
    same.length ? el('SameTaxes', {}, same) : ''
  ];
  const invoice = el('Invoice', {
    TypeOfInv: 'NONCASH', InvType: corrective ? 'CORRECTIVE' : inv.type === 'advance' ? 'ADVANCE' : 'INVOICE', IsSimplifiedInv: 'false', IssueDateTime: issued,
    InvNum: `${f.bu}/${ord}/${year}/${f.enu}`, InvOrdNum: String(ord), TCRCode: f.enu, IsIssuerInVAT: inVat ? 'true' : 'false', IsReverseCharge: 'false',
    TotPriceWoVAT: T.net, TotVATAmt: inVat ? T.vat : undefined, TotPrice: T.gross, OperatorCode: operator, BusinUnitCode: f.bu, SoftCode: f.sw,
    IIC: iic, IICSignature: iicSignature, PayDeadline: inv.dueDate && !corrective ? inv.dueDate : undefined
  }, children);
  const uuid = crypto.randomUUID();
  const header = el('Header', { SendDateTime: podgoricaIso(now), UUID: uuid, SubseqDelivType: subseq || undefined });
  const request = el('RegisterInvoiceRequest', { Id: 'Request', Version: '1' }, [header, invoice], NS);
  const digest = b64(await crypto.subtle.digest('SHA-256', enc.encode(request)));
  const signedInfo = '<SignedInfo xmlns="' + DS + '"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></SignatureMethod><Reference URI="#Request"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod><DigestValue>' + digest + '</DigestValue></Reference></SignedInfo>';
  const sigValue = b64(await sign(key, signedInfo));
  const signature = '<Signature xmlns="' + DS + '">' + signedInfo + '<SignatureValue>' + sigValue + '</SignatureValue><KeyInfo><X509Data><X509Certificate>' + pemBody(certPem, 'CERTIFICATE') + '</X509Certificate></X509Data></KeyInfo></Signature>';
  const signed = request.replace(/<\/RegisterInvoiceRequest>$/, signature + '</RegisterInvoiceRequest>');
  const envelope = '<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>' + signed + '</SOAP-ENV:Body></SOAP-ENV:Envelope>';
  return { envelope, iic, iicSignature, issued, uuid, totals: T };
}

// Sends the request; returns { ok, jikr } or { ok: false, code, message, technical }.
export async function send(url, envelope) {
  let r, text;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: 'https://efi.tax.gov.me/fs/RegisterInvoice' }, body: envelope }); text = await r.text(); }
  catch (e) { return { ok: false, technical: true, message: 'No connection to the fiscal service: ' + e.message }; }
  const fic = (text.match(/<(?:[\w-]+:)?FIC>([^<]+)</) || [])[1];
  if (r.ok && fic) return { ok: true, jikr: fic.trim(), response: text };
  const fault = (text.match(/<faultstring[^>]*>([^<]*)</) || [])[1], code = (text.match(/<(?:[\w-]+:)?code>([^<]*)</) || [])[1];
  return { ok: false, technical: !fault || r.status >= 500 && !code, code: code || String(r.status), message: (fault || ('The fiscal service answered ' + r.status)).trim(), response: text.slice(0, 4000) };
}
export const qrUrl = (env, p) => QR_URL[env] + '?iic=' + p.iic + '&tin=' + p.tin + '&crtd=' + p.issued + '&ord=' + p.ord + '&bu=' + p.bu + '&cr=' + p.tcr + '&sw=' + p.sw + '&prc=' + p.total;
