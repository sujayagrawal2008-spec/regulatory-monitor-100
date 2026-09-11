const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const basicAuth = require('express-basic-auth');

// Lazily load AI/PDF packages — startup still works if packages are absent or key unset
let Anthropic = null;
let pdfParse  = null;
let multer    = null;
let PDFDocument = null;
try { Anthropic   = require('@anthropic-ai/sdk'); } catch {}
try { pdfParse    = require('pdf-parse');  } catch {}  // v1.1.1 — exports a function directly
try { multer      = require('multer');     } catch {}
try { PDFDocument = require('pdfkit');     } catch {}  // used only to generate the compliance PDF report

// In-memory storage for uploaded PDFs — 15 MB cap, accepts only application/pdf
const docUpload = multer
  ? multer({
      storage: multer.memoryStorage(),
      limits:  { fileSize: 15 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
        else cb(new Error('Only PDF files are accepted'));
      }
    })
  : null;

const app = express();

// The host platform injects PORT automatically (e.g. Render); fall back to 3000 for local dev.
const PORT = process.env.PORT || 3000;

// DATA_DIR can be overridden to point at a persistent disk mount path (e.g. a Render disk).
// Locally this stays at ./data as before.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'store.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Public URL used in email footer links. Set APP_URL manually in production — no host platform
// we target auto-populates this, so without it, footer links fall back to http://localhost:<port>.
const APP_URL = process.env.APP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

// Set to 'true' on memory-constrained deployments (e.g. Render free tier) serving a fixed
// demo corpus — skips the startup scrape, the periodic 2-hourly scrape, and the post-boot
// chunk/reference backfill jobs entirely. Unset (default) preserves normal local-dev behavior.
const SKIP_STARTUP_SCRAPE = process.env.SKIP_STARTUP_SCRAPE === 'true';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_KEYWORDS = [
  'ECB', 'NCD', 'FPI', 'stamp duty', 'NBFC', 'lending', 'debenture',
  'foreign portfolio', 'external commercial borrowing',
  'insolvency', 'bankruptcy', 'liquidation', 'resolution', 'IBC',
  'NCLT', 'corporate insolvency', 'personal insolvency', 'resolution professional'
];

function defaultStore()  { return { seenIds: [], items: [], chunks: [] }; }
function defaultConfig() {
  return {
    keywords: DEFAULT_KEYWORDS,
    email: { enabled: false, host: '', port: 587, user: '', pass: '' },
    subscribers: [],
    lastScraped: null
  };
}

function readStore()  { try { return JSON.parse(fs.readFileSync(DATA_FILE,   'utf8')); } catch (e) { console.error('readStore: falling back to an empty store —', e.message); return defaultStore();  } }
function writeStore(d)  { fs.writeFileSync(DATA_FILE,   JSON.stringify(d, null, 2)); }
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return defaultConfig(); } }
function writeConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

if (!fs.existsSync(DATA_FILE))   writeStore(defaultStore());
if (!fs.existsSync(CONFIG_FILE)) writeConfig(defaultConfig());

// Serializes any operation that reads store.json, does async work (network/Claude
// calls, throttling delays), and writes store.json back — without this, two such
// operations interleave and whichever writes last silently discards everything the
// other added in between (this is exactly how a document added mid-backfill-batch
// could vanish: the backfill job holds a stale in-memory copy across ~15s of work,
// then overwrites the file with it). Single in-process async queue is sufficient —
// this is one Node process working one file, no cross-process locking needed.
let storeLock = Promise.resolve();
function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => {}, () => {});
  return run;
}

// Returns the effective email configuration.
// Environment variables take priority over config.json values — this lets Railway
// deployments use injected secrets while local dev continues using config.json.
function getEmailConfig() {
  const cfg = readConfig();
  const file = cfg.email || {};
  return {
    enabled: process.env.SMTP_ENABLED !== undefined
               ? process.env.SMTP_ENABLED === 'true'
               : file.enabled || false,
    host:    process.env.SMTP_HOST || file.host || 'smtp.gmail.com',
    port:    Number(process.env.SMTP_PORT || file.port || 465),
    user:    process.env.SMTP_USER || file.user || '',
    pass:    process.env.SMTP_PASS || file.pass || '',
    // Not env-overridable — just a passthrough of the last real send attempt, used by the
    // Email Alerts UI's "Connected / Not configured / Last send failed" status indicator.
    lastSendAt: file.lastSendAt || null,
    lastSendOk: typeof file.lastSendOk === 'boolean' ? file.lastSendOk : null,
  };
}

// AI API key — set via ANTHROPIC_API_KEY environment variable; never hardcode here
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// ─── Date normalisation ───────────────────────────────────────────────────────
// Converts "05.6.2026" or "Jun 03, 2026" or "Apr 08, 2026" → Date object (or null)
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseDate(str) {
  if (!str || !str.trim()) return null;
  str = str.trim();
  // DD.M.YYYY or DD.MM.YYYY  (RBI)
  let m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  // Month-first: "Jun 03, 2026" (SEBI, 3-letter abbreviation) or "September 19, 2008"
  // (full month name — the format RBI's own pages display, so it's exactly what
  // someone copy-pastes into a manual-upload date field). Accepts any month-name
  // length, not just 3 letters, so both forms match uniformly — previously only
  // the abbreviation matched, so a full month name silently failed to parse and
  // the item's dateSort fell back to "now": for an OLD document that's not just
  // cosmetically wrong, it's fatal to Stage 2's candidate search (which requires
  // candidates dated *after* the item being checked) — an item sorted as "now"
  // can never have anything in the store dated after it, so it always got zero
  // candidates and silently reported "Unable to Determine" regardless of what
  // was actually in the store.
  m = str.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo !== undefined) return new Date(Number(m[3]), mo, Number(m[2]));
  }

  // Day-first: "04th June, 2026", "3rd June 2026" (IBBI), or "14 Aug 2026" (no
  // ordinal — the format the Add Document / Check Validity upload forms
  // placeholder-suggest, e.g. "05 Jun 2026"). Ordinal suffix optional, month name
  // any length.
  m = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/i);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mo !== undefined) return new Date(Number(m[3]), mo, Number(m[1]));
  }
  return null;
}

function sortByDate(items) {
  return [...items].sort((a, b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    if (da && db) return db - da;
    if (da) return -1;
    if (db) return 1;
    return 0; // both undated — preserve original order
  });
}

// Caps the store at 1000 items — but only counts AUTO-SCRAPED items against that
// limit. Manually-added documents (Add Document / Check Validity upload) are never
// evicted, regardless of age or count: a user who deliberately uploaded something
// wants it to stay, unlike scraped items which are always re-fetchable on the next
// scrape. This is what makes an old test document (e.g. a genuine 2008 circular)
// stop silently disappearing as newer real items accumulate ahead of it.
function capStoreItems(items) {
  const sorted  = sortByDate(items);
  const manual  = sorted.filter(it => it.addedManually);
  const scraped = sorted.filter(it => !it.addedManually).slice(0, 1000);
  return sortByDate([...manual, ...scraped]);
}

function formatDate(str) {
  const d = parseDate(str);
  if (!d) return null;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

const RBI_SCRIPTS_BASE = 'https://www.rbi.org.in/Scripts/';

function rbiUrl(href) {
  if (!href) return '';
  return href.startsWith('http') ? href : RBI_SCRIPTS_BASE + href;
}

function isJunk(text) {
  if (!text || text.length < 20) return true;
  if (/^\d+(\.\d+)?\s*(kb|mb|bytes?)\s*$/i.test(text.trim())) return true;
  return false;
}

// ─── Claude AI analysis ──────────────────────────────────────────────────────
// Flow: download PDF → extract text with pdf-parse (or scrape HTML) →
//   (a) search full text for user keywords → exact excerpts (done in Node, not Claude)
//   (b) send truncated text to claude-haiku-4-5 → 3-sentence summary

const GROQ_SYSTEM_PROMPT =
  'You are a legal assistant specialising in Indian banking and finance law. ' +
  'Read this regulatory document and write a 3 sentence plain English summary ' +
  'of what it says and what a lawyer needs to know. ' +
  'Return ONLY a valid JSON object — no markdown, no code fences — in exactly ' +
  'this shape: {"summary":"..."}';

// Scans extracted text for each keyword and returns the sentence window around
// the first match.  One excerpt per unique keyword, up to 5 total.
function extractExcerpts(text, keywords) {
  if (!text || !keywords || !keywords.length) return [];
  const results = [];
  const seen    = new Set();

  for (const kw of keywords) {
    const kwKey = kw.toLowerCase();
    if (seen.has(kwKey)) continue;

    const idx = text.toLowerCase().indexOf(kwKey);
    if (idx === -1) continue;

    // Pull a window of ±200 chars around the match
    const winStart = Math.max(0, idx - 200);
    const winEnd   = Math.min(text.length, idx + kw.length + 200);
    let excerpt    = text.slice(winStart, winEnd).trim();

    // Trim leading fragment to the nearest sentence start ('. ' or start of string)
    if (winStart > 0) {
      const cut = excerpt.indexOf('. ');
      if (cut !== -1 && cut < 100) excerpt = excerpt.slice(cut + 2);
    }
    // Trim trailing fragment to the nearest sentence end
    if (winEnd < text.length) {
      const cut = excerpt.lastIndexOf('. ');
      if (cut !== -1 && cut > excerpt.length - 100) excerpt = excerpt.slice(0, cut + 1);
    }

    results.push({ keyword: kw, excerpt: excerpt.trim().slice(0, 400) });
    seen.add(kwKey);
    if (results.length >= 5) break;
  }

  return results;
}

// ─── Document Validity Checker — Stage 1 (deterministic reference extraction) ────
// RBI's circular-number formats are well standardised, so these patterns are the
// primary/reliable set. SEBI/IBBI numbering is far less uniform — their patterns
// below are best-effort and will miss formats they weren't written against; that's
// an accepted tradeoff (Stage 2's semantic check is the fallback for anything Stage
// 1 misses).
const REF_PATTERNS = {
  RBI: [
    // RBI/2025-26/199  or  RBI/DOR/2025-26/199
    /RBI\/(?:[A-Z]{2,10}\/)?\d{4}-\d{2}\/\d{1,4}/g,
    // DOR.ACC.REC.118/21-02-067/2025-26  (dept.subdept.code.number/sub-code/year)
    /\b[A-Z]{2,10}(?:\.[A-Z0-9]{2,10}){1,5}\.\d{1,5}\/[\d-]{2,20}\/\d{4}-\d{2}/g,
    // A.P. (DIR Series) Circular No. 05
    /A\.?\s?P\.?\s*\(DIR\s*Series\)\s*Circular\s*No\.?\s*\d{1,4}/gi
  ],
  SEBI: [
    // SEBI/HO/DEPT/.../CIR/P/2025/123  (or without the /P/)
    /SEBI\/HO\/[A-Z0-9\/]+\/(?:CIR\/P|CIR)\/[A-Z0-9\/]*\d{4}\/\d{1,4}/gi
  ],
  IBBI: [
    // IBBI/DEPT/2025-26/12  or  No. IBBI/.../12
    /IBBI(?:\/[A-Z0-9.]+){1,6}\/\d{4}(?:-\d{2})?\/\d{1,4}/gi
  ]
};

// Pulls year/number components out of a matched reference string, when present —
// best-effort, used only to populate optional display fields, never for matching
// (matching always compares the full normalized raw string).
function decomposeRef(raw) {
  const yearM = raw.match(/\d{4}-\d{2}/);
  // The sequence number is the LAST plain (non-year) slash-delimited number —
  // e.g. "RBI/2025-26/501" -> "501", not the "2025" from the year segment.
  const numM = raw.match(/\/(\d{1,4})\s*$/) || raw.match(/No\.?\s*(\d{1,4})\s*$/i);
  return { year: yearM ? yearM[0] : null, number: numM ? numM[1] : null };
}

// Normalizes a reference string for comparison — case/whitespace-insensitive so
// "RBI/2025-26/199" and "rbi/2025-26/199 " compare equal.
function normalizeRef(raw) {
  return (raw || '').replace(/\s+/g, '').toUpperCase();
}

// Finds this document's own reference number — tries the existing raw `ref` field
// first (cheap, already scraped for RBI Circulars), then the title, then the first
// ~2000 chars of the document body (reference numbers are almost always in the header).
// RBI documents commonly carry MULTIPLE valid reference numbers on the same
// letterhead — e.g. a general "RBI/2025-26/199" serial alongside a department-
// specific "DOR.ACC.REC.118/21-02-067/2025-26" classification code, both identifying
// the SAME document. A document citing this one in a repeal list may use either
// format (confirmed: a real Master Direction's Annex III cited the department code
// while this function previously only ever captured the general serial, since it
// returned on the first match found — meaning that document could never resolve
// against a repeal citing it by its other, equally valid, reference). So this
// collects every distinct reference-shaped string found in the letterhead area
// (item.ref, item.title, and the first ~500 chars of body text) into `allRefs`;
// `raw` stays the first one found, kept for display purposes only — matching must
// always check the full `allRefs` list, never `raw` alone.
function parseOwnReference(item, linePreserved) {
  const patterns = REF_PATTERNS[item.source] || [];
  if (!patterns.length) return null;

  const letterhead = [item.ref, item.title, (linePreserved || '').slice(0, 500)]
    .filter(Boolean).join(' ');

  const seen = new Set();
  const allRefs = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(letterhead)) !== null) {
      const raw = m[0].trim();
      const key = normalizeRef(raw);
      if (!seen.has(key)) {
        seen.add(key);
        allRefs.push(raw);
      }
    }
  }
  if (!allRefs.length) return null;
  return { raw: allRefs[0], allRefs, ...decomposeRef(allRefs[0]), parsedAt: new Date().toISOString() };
}

// Date-like substring finder for text near a repeal reference — deliberately looser
// than parseDate()'s exact-format matching, since repeal-list rows can format dates
// several ways; the matched substring is stored as-is and re-parsed with parseDate()
// only where a hard Date is actually needed.
const LOOSE_DATE_RE = new RegExp(
  '\\b\\d{1,2}[./]\\d{1,2}[./]\\d{4}\\b' +
  '|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\w*,?\\s*\\d{4}\\b',
  'i'
);

const REPEAL_ANCHOR_RE = /\b(repeal(?:ed|s|ing)?|supersed(?:e|ed|es|ing)|rescind(?:ed|s|ing)?|stands?\s+withdrawn|list\s+of\s+circulars)\b/gi;

// Scans a document's line-preserved text for repeal/supersession references to
// *other* (older) documents — anchored on keywords like "repealed"/"superseded",
// then pulls reference-number + date + a short subject fragment from the window
// around each anchor. Deliberately narrow (anchor-scoped, not a whole-document scan)
// to avoid false positives from circulars merely citing other circulars in passing.
// `ownRefRaw` (this document's own reference number, if known) is always excluded —
// otherwise a document's own ref number appearing near a "supersedes" anchor gets
// misread as something it repeals, when it's simply describing itself.
function extractRepealReferences(linePreserved, source, ownRefRaw = null) {
  if (!linePreserved) return [];
  const patterns = REF_PATTERNS[source] || [];
  if (!patterns.length) return [];
  const ownKey = ownRefRaw ? normalizeRef(ownRefRaw) : null;

  const results = [];
  const seen = new Set();
  const WINDOW = 700;
  let anchorMatch;
  REPEAL_ANCHOR_RE.lastIndex = 0;
  while ((anchorMatch = REPEAL_ANCHOR_RE.exec(linePreserved)) !== null) {
    const winStart = Math.max(0, anchorMatch.index - 100);
    const winEnd   = Math.min(linePreserved.length, anchorMatch.index + WINDOW);
    const window   = linePreserved.slice(winStart, winEnd);

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let refMatch;
      while ((refMatch = pattern.exec(window)) !== null) {
        const raw = refMatch[0].trim();
        const key = normalizeRef(raw);
        if (seen.has(key) || key === ownKey) continue;
        seen.add(key);

        // Subject/date: look in a small span right around this specific ref match,
        // not the whole anchor window, so multi-row Annexes don't cross-contaminate.
        const localStart = Math.max(0, refMatch.index - 50);
        const localEnd    = Math.min(window.length, refMatch.index + raw.length + 250);
        const local       = window.slice(localStart, localEnd);
        const dateMatch    = local.match(LOOSE_DATE_RE);

        results.push({
          rawRef:      raw,
          date:        dateMatch ? dateMatch[0] : null,
          subject:     local.replace(raw, '').replace(/\s+/g, ' ').trim().slice(0, 200),
          matchedItemId: null,
          matchedAt:   null
        });
        if (results.length >= 20) return results; // sane cap
      }
    }
  }
  return results;
}

// Bidirectional reference resolver — see plan doc for why this must check both
// directions in one function: documents can arrive in either order (the repealer
// before the repealed document, or after), and whichever arrives second is the one
// that completes the match.
function resolveReferencesForItem(item, store) {
  if (!item) return;
  const pool = store.items;

  // Forward: this item's own repeals[] list, matched against everyone else's refInfo.
  // Checks the full allRefs list, not just the primary `raw` reference — a document
  // can be legitimately cited by any of its own letterhead reference numbers, not
  // only the first one parseOwnReference() happened to find.
  //
  // Deliberately NOT gated on "already matched": an exact reference-number match is
  // an unambiguous identity signal, so EVERY store item sharing that reference gets
  // marked superseded, not just whichever one happened to be processed first. Without
  // this, duplicate uploads of the same real document (which happens — the same
  // circular scraped once and also manually uploaded, or just re-uploaded during
  // testing) would have only one copy ever show "Superseded", with the rest stuck on
  // "Active" depending on nothing but processing order — confirmed as a real, repeated
  // point of confusion, not a hypothetical. `matchedItemId`/`matchedAt` on the entry
  // are therefore last-match-wins and informational only, not a gate.
  if (Array.isArray(item.repeals)) {
    for (const entry of item.repeals) {
      const key = normalizeRef(entry.rawRef);
      const targets = pool.filter(it =>
        it.id !== item.id && it.refInfo?.allRefs?.some(r => normalizeRef(r) === key)
      );
      for (const target of targets) {
        entry.matchedItemId = target.id;
        entry.matchedAt = new Date().toISOString();
        target.supersession = {
          status: 'superseded',
          supersededBy: { docId: item.id, title: item.title, date: item.date, url: item.url, source: item.source, type: item.type, mechanism: 'explicit_reference' },
          stage2Attempted: false,
          checkedAt: new Date().toISOString()
        };
      }
    }
  }

  // Reverse: this item's own allRefs, checked against every other item's repeals[]
  // for an entry pointing at ANY of them (same reasoning as the forward direction
  // above — a repeal citation may use either of this document's valid reference
  // numbers, and every document sharing a reference should resolve, not just the
  // first-processed one).
  if (item.refInfo?.allRefs?.length) {
    const myKeys = new Set(item.refInfo.allRefs.map(normalizeRef));
    for (const other of pool) {
      if (other.id === item.id || !Array.isArray(other.repeals)) continue;
      for (const entry of other.repeals) {
        if (!myKeys.has(normalizeRef(entry.rawRef))) continue;
        entry.matchedItemId = item.id;
        entry.matchedAt = new Date().toISOString();
        item.supersession = {
          status: 'superseded',
          supersededBy: { docId: other.id, title: other.title, date: other.date, url: other.url, source: other.source, type: other.type, mechanism: 'explicit_reference' },
          stage2Attempted: false,
          checkedAt: new Date().toISOString()
        };
      }
    }
  }
}

// ─── Document chunking (RAG) ──────────────────────────────────────────────────
// Splits long text into ~500-800 word chunks with a 100-word overlap so that
// content deep inside long regulatory documents (e.g. "Chapter VIA") remains
// retrievable, and context is preserved across chunk boundaries.
const CHUNK_WORDS   = 800;
const CHUNK_OVERLAP = 100;

function chunkText(text, chunkWords = CHUNK_WORDS, overlapWords = CHUNK_OVERLAP) {
  if (!text || !text.trim()) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= chunkWords) return [words.join(' ')];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkWords, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    start = end - overlapWords;
    if (start < 0) start = 0;
  }
  return chunks;
}

// Builds chunk records for an item — each carries the parent document's
// title/source/date/url so citations always point back to the parent document,
// never to an individual chunk.
function buildChunksForItem(item, fullText) {
  const pieces = chunkText(fullText);
  const total  = pieces.length;
  if (!total) return [];
  return pieces.map((text, idx) => ({
    id:          `${item.id}::chunk${idx + 1}`,
    parentId:    item.id,
    parentTitle: item.title,
    source:      item.source,
    type:        item.type,
    ref:         item.ref || '',
    date:        item.date,
    url:         item.url,
    chunkIndex:  idx + 1,
    totalChunks: total,
    text
  }));
}

// Replaces any existing chunks for this item (e.g. on re-ingest) with a fresh set.
function upsertChunksForItem(store, item, fullText) {
  if (!Array.isArray(store.chunks)) store.chunks = [];
  store.chunks = store.chunks.filter(c => c.parentId !== item.id);
  const fresh = buildChunksForItem(item, fullText);
  if (fresh.length) store.chunks.push(...fresh);
  return fresh;
}

// Collapses horizontal whitespace only (spaces/tabs) and caps blank-line runs —
// keeps newlines, so table rows and paragraph breaks survive. Used for regex
// extraction (Stage 1 reference parsing) where row/section boundaries matter.
function collapseHorizontalWhitespace(text) {
  return (text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Fetches the full text behind an item's URL (PDF or HTML) — shared by the
// scraper's AI-analysis step and the chunk backfill job. Returns both the fully
// whitespace-collapsed text (`fullText`, used by Claude/chunking — unchanged
// behaviour) and a line-preserving variant (`linePreserved`, used by Stage 1
// repeal-reference extraction, which needs table/row boundaries that full
// collapsing destroys). `fullText` is simply `linePreserved` with newlines
// flattened too, so its content is identical to before this was split out.
async function fetchFullTextForItem(item) {
  if (!item || !item.url) return { fullText: '', linePreserved: '' };
  const isPdf = /\.pdf(\?|$)/i.test(item.url);

  let raw = '';
  if (isPdf && pdfParse) {
    let referer = undefined;
    try { referer = new URL(item.url).origin + '/'; } catch {}
    const resp = await axios.get(item.url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024,
      // Some regulator PDF hosts (e.g. RBI's rbidocs.rbi.org.in, a separate subdomain
      // from the page linking to it) reject direct/hotlinked fetches and serve an HTML
      // page instead of the file — a Referer pointing back at the file's own origin is a
      // common, low-risk way past that; assertLooksLikePdf() below catches it cleanly
      // (specific NOT_A_PDF error) on the cases this doesn't fix.
      headers: { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}) }
    });
    assertLooksLikePdf(resp);
    const parsed = await pdfParse(Buffer.from(resp.data));
    raw = parsed.text;
  } else if (!isPdf) {
    const resp = await axios.get(item.url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(resp.data);

    // Confirmed on SEBI's site: many regulation/order detail pages carry NO real content in
    // their own HTML at all — the actual document is embedded as a PDF inside a pdf.js-style
    // viewer iframe (src="…/web/?file=<pdf-url>"), and the page's own body text is just the
    // title repeated twice with a date. That silently produced near-empty, unsearchable
    // documents (confirmed: both a manually-added regulation AND existing scraped SEBI
    // enforcement orders have this exact pattern) — follow that embedded PDF when present
    // instead of taking the page's own thin body text.
    const iframeSrc = $('iframe[src*="file="]').first().attr('src') || '';
    const fileParamMatch = iframeSrc.match(/[?&]file=([^&]+)/);
    const embeddedPdfUrl = fileParamMatch ? decodeURIComponent(fileParamMatch[1]) : null;

    if (embeddedPdfUrl && /\.pdf(\?|$)/i.test(embeddedPdfUrl) && pdfParse) {
      let referer;
      try { referer = new URL(item.url).origin + '/'; } catch {}
      const pdfResp = await axios.get(embeddedPdfUrl, {
        responseType: 'arraybuffer', timeout: 30000, maxContentLength: 20 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}) }
      });
      assertLooksLikePdf(pdfResp);
      const parsed = await pdfParse(Buffer.from(pdfResp.data));
      raw = parsed.text;
    } else {
      $('script, style, nav, header, footer').remove();
      raw = $('body').text();
    }
  }

  const linePreserved = collapseHorizontalWhitespace(raw);
  const fullText = linePreserved.replace(/\s+/g, ' ').trim();
  return { fullText, linePreserved };
}

// Builds inverse-document-frequency weights for the current query's tokens across
// a pool of lower-cased text blobs. Without this, common words (e.g. "via",
// "chapter", "circular") that appear in hundreds of unrelated documents drown out
// rare, distinctive terms (e.g. "delisting") in raw-frequency scoring — causing
// specific-content queries to surface generic documents instead of the right one.
// Rare terms get a high weight, common terms get a weight close to 1.
function buildTokenIdf(lowerTexts, tokens) {
  const idf = new Map();
  const N = lowerTexts.length || 1;
  for (const tok of tokens) {
    let df = 0;
    for (const t of lowerTexts) { if (t.includes(tok)) df++; }
    idf.set(tok, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}

// Score a chunk against the query — phrase + IDF-weighted token hits in the chunk
// text and parent title. `idf` (optional) is a Map<token, weight> from buildTokenIdf;
// rarer/more distinctive query terms count for more than common ones.
function scoreChunk(chunk, question, tokens, idf = null) {
  if (!tokens.length) return 0;
  const text  = (chunk.text || '').toLowerCase();
  const title = (chunk.parentTitle || '').toLowerCase();
  const qLow  = question.toLowerCase();
  let score = 0;

  // Phrase bonus — verbatim 3-5 word runs from the question found in the chunk.
  // Weighted heavily: an exact multi-word phrase match (e.g. "chapter via") is
  // strong evidence of relevance regardless of how common the individual words are.
  const phrases = qLow.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3);
  for (let len = Math.min(5, phrases.length); len >= 3; len--) {
    for (let i = 0; i <= phrases.length - len; i++) {
      const phrase = phrases.slice(i, i + len).join(' ');
      if (text.includes(phrase)) { score += len * 10; break; }
    }
  }

  for (const tok of tokens) {
    // Square the IDF weight so distinctive terms (e.g. "delisting") dominate over
    // common ones (e.g. "via", "chapter") that appear in hundreds of documents —
    // a single hit on a rare term should outweigh several hits on a common one.
    const w = Math.pow(idf ? (idf.get(tok) || 1) : 1, 2);
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp(esc, 'g');
    const rawText  = (text.match(re)  || []).length;
    const rawTitle = (title.match(re) || []).length;
    // Log-scaled term frequency — repeating a common word dozens of times in one
    // chunk shouldn't let it dominate the ranking the way a linear count would.
    const textHits  = rawText  > 0 ? 1 + Math.log(rawText)  : 0;
    const titleHits = rawTitle > 0 ? 1 + Math.log(rawTitle) : 0;
    score += textHits * 2 * w;
    score += titleHits * 3 * w;
  }

  return score;
}

// Topical relevance boosts — for certain query topics, one document is the clearly
// "right" authority on the subject, but broader/tangentially-related documents (e.g.
// general banking master directions that merely mention the term in passing) can
// crowd it out in raw scoring simply by being larger or more numerous. When the
// query's wording signals one of these topics, multiply the matching document's
// score so it's ranked — and cited — as the primary source.
const TOPIC_BOOSTS = [
  {
    // NCD / non-convertible-debenture / non-convertible-securities queries should
    // prioritise SEBI's Issue & Listing of Non-Convertible Securities Regulations
    // over RBI banking master directions that only mention NCDs as an investment type.
    triggers: [
      'ncd', 'ncds', 'non-convertible debenture', 'non convertible debenture',
      'non-convertible debentures', 'non convertible debentures',
      'non-convertible securities', 'non convertible securities',
      'debenture', 'debentures'
    ],
    titleMatch: /issue and listing of non-convertible securities/i,
    factor: 3
  }
];

function applyTopicBoosts(score, parentTitle, qLow) {
  if (score <= 0) return score;
  for (const boost of TOPIC_BOOSTS) {
    if (boost.titleMatch.test(parentTitle || '') && boost.triggers.some(t => qLow.includes(t))) {
      return score * boost.factor;
    }
  }
  return score;
}

// Truncate a chunk's text to at most N words (keeps requests small & predictable).
function truncateWords(text, maxWords) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text.trim() : words.slice(0, maxWords).join(' ') + '…';
}

// Rough token estimate — ~4 characters per token for English text. Good enough
// for keeping context within Claude's token budget without an extra dependency.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// Attempts to repair a JSON object that was cut off mid-stream (e.g. the model
// hit max_tokens before emitting the closing braces). Strategy: locate the first
// '{', drop the trailing incomplete fragment back to the last cleanly-closed
// string/array/object, strip a dangling comma, then balance any open brackets.
function repairTruncatedJson(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let s = raw.slice(start);

  const cut = Math.max(s.lastIndexOf('",'), s.lastIndexOf('"]'), s.lastIndexOf('"}'), s.lastIndexOf('],'), s.lastIndexOf('},'));
  if (cut > 0) s = s.slice(0, cut + 1);
  s = s.replace(/,\s*$/, '');

  const stack = [];
  let inString = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }
  // If the cut point landed mid-string (e.g. the cleanest cut we found was inside
  // a long "answer" sentence), close that string before balancing the structure.
  if (inString) s += '"';
  while (stack.length) s += (stack.pop() === '{' ? '}' : ']');
  return s;
}

// ─── Claude (Anthropic) helper ────────────────────────────────────────────────
// Thin wrapper around the Anthropic Messages API — keeps the system prompt and
// the [{role, content}] message array shape consistent across all call sites,
// and surfaces Anthropic's own error shape (status/type/message) to callers.
async function callClaude(systemPrompt, messages, { maxTokens = 500, temperature = 0.1 } = {}) {
  if (!ANTHROPIC_API_KEY || !Anthropic) throw new Error('Anthropic API key not configured');
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const resp = await anthropic.messages.create({
    model:       CLAUDE_MODEL,
    max_tokens:  maxTokens,
    temperature,
    system:      systemPrompt,
    messages
  });
  return (resp.content || [])
    .map(block => (block && block.type === 'text') ? block.text : '')
    .join('')
    .trim();
}

// Formats an Anthropic SDK error into a short, readable string for logs/responses.
function describeClaudeError(e) {
  if (e && e.status && e.error?.error) {
    return `${e.status} ${e.error.error.type || ''}: ${e.error.error.message || e.message}`.trim();
  }
  if (e && e.status) return `${e.status}: ${e.message}`;
  return e?.message || String(e);
}

// Shared core: given an item and its already-extracted full text, run keyword
// excerpt extraction + Claude summarisation. Used both by the scraper pipeline
// (after fetching item.url) and by the new URL/upload document-input routes
// (which already have fullText in hand, so no re-fetch is needed).
async function analyzeExtractedText(item, fullText, userKeywords = []) {
  if (!ANTHROPIC_API_KEY || !Anthropic) return null;

  try {
    // ── Keyword excerpt extraction (exact text, before any truncation) ───────
    const excerpts = extractExcerpts(fullText, userKeywords);

    // ── Send truncated text to Claude for a short summary ────────────────────
    const docText = (fullText.slice(0, 15000)) ||
      '[Full text could not be retrieved — summarise based on title and type only.]';

    const raw = await callClaude(
      GROQ_SYSTEM_PROMPT,
      [{ role: 'user', content:
          `Document title: ${item.title}\n` +
          `Source: ${item.source} — ${item.type}\n\n` +
          `Document text:\n${docText}` }],
      { maxTokens: 300, temperature: 0.1 }
    );

    // ── Parse JSON from response ──────────────────────────────────────────────
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const matched = cleaned.match(/\{[\s\S]*\}/);
    if (!matched) throw new Error('No JSON object in Claude response');
    const data = JSON.parse(matched[0]);

    return {
      summary:    String(data.summary || '').trim().slice(0, 500),
      excerpts,                   // [{keyword, excerpt}, …]
      analyzedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error(`Claude error [${item.id.slice(0, 30)}]: ${describeClaudeError(e)}`);
    return null;
  }
}

// Fetches full text from item.url (PDF or HTML) then delegates to analyzeExtractedText.
async function analyzeWithGroq(item, userKeywords = []) {
  if (!ANTHROPIC_API_KEY || !Anthropic || !item.url) return null;
  try {
    const { fullText } = await fetchFullTextForItem(item);
    return await analyzeExtractedText(item, fullText, userKeywords);
  } catch (e) {
    console.error(`Claude error [${item.id.slice(0, 30)}]: ${describeClaudeError(e)}`);
    return null;
  }
}

// Fetches full text once, then both summarises (Claude) AND builds RAG chunks from it —
// used by the scrape pipeline so new documents get chunked at ingestion time, just
// like documents added via URL/upload. Also runs Stage 1 reference extraction
// (deterministic, no extra fetch — reuses the same linePreserved text) so items
// processed through this path get refInfo/repeals for free.
async function analyzeAndChunkItem(item, userKeywords = []) {
  if (!item || !item.url) return { ai: null, chunks: [], refInfo: null, repeals: [] };
  try {
    const { fullText, linePreserved } = await fetchFullTextForItem(item);
    const ai     = (ANTHROPIC_API_KEY && Anthropic) ? await analyzeExtractedText(item, fullText, userKeywords) : null;
    const chunks = buildChunksForItem(item, fullText);
    const refInfo = parseOwnReference(item, linePreserved);
    const repeals = extractRepealReferences(linePreserved, item.source, refInfo?.raw);
    return { ai, chunks, refInfo, repeals };
  } catch (e) {
    console.error(`Analyze+chunk error [${item.id.slice(0, 30)}]: ${describeClaudeError(e)}`);
    return { ai: null, chunks: [], refInfo: null, repeals: [] };
  }
}

// Lightweight Stage-1-only pass for new items that don't go through the Claude
// analysis loop (beyond its 20-item cap, or when ANTHROPIC_API_KEY isn't set) —
// still deterministic/no AI call, per spec, just without the summary/chunk work.
async function extractReferencesOnly(item) {
  if (!item || !item.url) return { refInfo: null, repeals: [] };
  try {
    const { linePreserved } = await fetchFullTextForItem(item);
    const refInfo = parseOwnReference(item, linePreserved);
    return {
      refInfo,
      repeals: extractRepealReferences(linePreserved, item.source, refInfo?.raw)
    };
  } catch (e) {
    console.error(`Reference extraction error [${item.id.slice(0, 30)}]: ${e.message}`);
    return { refInfo: null, repeals: [] };
  }
}

// ─── Document Validity Checker — Stage 2 (semantic content-based supersession) ───
// Fallback only, on-demand — never runs automatically (too expensive to run on
// every document). Reuses the existing lexical chunk-scoring machinery that already
// powers /api/ask (buildTokenIdf/scoreChunk, defined above) to narrow the whole store
// down to a handful of topically-relevant, dated-after candidates before asking
// Claude to judge any of them — no new scoring logic, just a new call site.

const SUPERSESSION_CHECK_PROMPT =
  'You are a legal compliance analyst specialising in Indian financial regulation. ' +
  'You are given an OLDER regulatory document (title, summary, key excerpts) and a passage ' +
  'from a NEWER document that may restate, incorporate, or supersede it — even without ' +
  'naming it explicitly. Judge whether the newer passage actually supersedes the substantive ' +
  'obligations/provisions of the older document. Cite which section/paragraph of the newer ' +
  'document corresponds to which part of the older one. ' +
  'Return ONLY valid JSON — no markdown, no code fences — in exactly this shape: ' +
  '{"supersedes": true|false, "confidence": "high"|"medium"|"low", ' +
  '"oldSection": "...", "newSection": "...", "reasoning": "one clear sentence"}. ' +
  'Use "high" confidence only when certain the newer document actually replaces the older ' +
  "one's substantive content, not merely related to it or citing it in passing.";

// Finds up to `limit` newer same-source documents most topically related to `item`.
function findSupersessionCandidates(item, store, limit = 8) {
  const candidatePool = store.items.filter(it =>
    it.id !== item.id &&
    it.source === item.source &&
    (it.dateSort || 0) > (item.dateSort || 0)
  );
  if (!candidatePool.length) return [];

  const candidateIds = new Set(candidatePool.map(it => it.id));
  const chunks = (store.chunks || []).filter(c => candidateIds.has(c.parentId));
  if (!chunks.length) return [];

  const query  = [item.title, item.ai?.summary || ''].join(' ');
  const qLow   = query.toLowerCase();
  const tokens = [...new Set(qLow.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3))];
  const idf    = buildTokenIdf(chunks.map(c => (c.text || '').toLowerCase()), tokens);

  const bestByParent = new Map(); // parentId -> {score, chunk}
  for (const chunk of chunks) {
    const score = applyTopicBoosts(scoreChunk(chunk, query, tokens, idf), chunk.parentTitle, qLow);
    const cur = bestByParent.get(chunk.parentId);
    if (!cur || score > cur.score) bestByParent.set(chunk.parentId, { score, chunk });
  }

  return [...bestByParent.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([parentId, { chunk }]) => ({ item: candidatePool.find(it => it.id === parentId), topChunkText: chunk.text }))
    .filter(c => c.item);
}

// Claude judgment call for one (old, candidate) pair — same callClaude() + JSON-parse
// pattern as compareVersions() above.
async function checkContentSupersession(oldItem, candidate) {
  if (!ANTHROPIC_API_KEY || !Anthropic) return null;
  try {
    const oldCtx = [
      `Title: ${oldItem.title}`,
      `Date: ${oldItem.date || 'unknown'}`,
      oldItem.ai?.summary ? `Summary: ${oldItem.ai.summary}` : '',
      oldItem.ai?.excerpts?.length ? 'Key passages: ' + oldItem.ai.excerpts.map(e => `"${e.excerpt}"`).join(' | ') : ''
    ].filter(Boolean).join('\n');

    const newCtx = [
      `Title: ${candidate.item.title}`,
      `Date: ${candidate.item.date || 'unknown'}`,
      `Passage: ${truncateWords(candidate.topChunkText, 600)}`
    ].join('\n');

    const raw = await callClaude(
      SUPERSESSION_CHECK_PROMPT,
      [{ role: 'user', content: `OLDER DOCUMENT:\n${oldCtx}\n\nNEWER DOCUMENT:\n${newCtx}` }],
      { maxTokens: 400, temperature: 0.1 }
    );
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const matched = cleaned.match(/\{[\s\S]*\}/);
    if (!matched) throw new Error('No JSON in supersession-check response');
    const data = JSON.parse(matched[0]);
    return {
      supersedes: !!data.supersedes,
      confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'low',
      oldSection: String(data.oldSection || '').trim().slice(0, 300),
      newSection: String(data.newSection || '').trim().slice(0, 300),
      reasoning:  String(data.reasoning  || '').trim().slice(0, 300)
    };
  } catch (e) {
    console.error(`Supersession check error [${oldItem.id.slice(0,30)}] vs [${candidate.item.id.slice(0,30)}]: ${describeClaudeError(e)}`);
    return null;
  }
}

// Orchestrates Stage 2 for one document — on-demand only (called only from the
// POST /api/validity/:id/check-content route, never from the scrape pipeline). Tries
// candidates in score order, stops at the first high-confidence match, and always
// caches the outcome — even "nothing found" — so repeat checks are free until forced.
async function runStage2Check(item, store) {
  const candidates = findSupersessionCandidates(item, store);

  let bestNonHigh = null;
  for (let i = 0; i < candidates.length; i++) {
    const result = await checkContentSupersession(item, candidates[i]);
    if (result && result.supersedes) {
      if (result.confidence === 'high') {
        item.supersession = {
          status: 'superseded',
          supersededBy: {
            docId: candidates[i].item.id, title: candidates[i].item.title,
            date: candidates[i].item.date, url: candidates[i].item.url,
            source: candidates[i].item.source, type: candidates[i].item.type,
            mechanism: 'content_match', confidence: 'high',
            citation: { oldSection: result.oldSection, newSection: result.newSection }
          },
          stage2Attempted: true,
          checkedAt: new Date().toISOString()
        };
        return item.supersession;
      }
      if (!bestNonHigh) bestNonHigh = { candidate: candidates[i], result };
    }
    if (i < candidates.length - 1) await new Promise(r => setTimeout(r, 2500));
  }

  item.supersession = bestNonHigh
    ? {
        status: 'possibly_superseded',
        supersededBy: {
          docId: bestNonHigh.candidate.item.id, title: bestNonHigh.candidate.item.title,
          date: bestNonHigh.candidate.item.date, url: bestNonHigh.candidate.item.url,
          source: bestNonHigh.candidate.item.source, type: bestNonHigh.candidate.item.type,
          mechanism: 'content_match', confidence: bestNonHigh.result.confidence,
          citation: { oldSection: bestNonHigh.result.oldSection, newSection: bestNonHigh.result.newSection }
        },
        stage2Attempted: true,
        checkedAt: new Date().toISOString()
      }
    // Both stages have now actually been run and found nothing — this is the one case
    // where "active" is a genuine, checked determination rather than an unverified default.
    : { status: 'active', supersededBy: null, stage2Attempted: true, checkedAt: new Date().toISOString() };

  return item.supersession;
}

// ─── Subscriber matching ──────────────────────────────────────────────────────

// Same haystack as the item's AI summary/excerpts — richer than the title-only
// matchesKeywords() used for the /api/items query filter. Returns EVERY subscriber
// keyword found (in the subscriber's own casing), not just whether any matched — the
// full list powers the "Why this matched" line in the digest email; callers that only
// need a yes/no should check .length, and callers that want just one keyword for short
// copy (subject lines etc.) should use findMatchedKeyword() below.
function matchesSubscriberKeywords(item, keywords) {
  if (!keywords || !keywords.length) return [];
  const hay = [
    item.title || '',
    item.ai?.summary || '',
    (item.ai?.excerpts || []).map(e => e.excerpt).join(' ')
  ].join(' ').toLowerCase();
  return keywords.filter(kw => hay.includes(kw.toLowerCase()));
}

// Returns the first subscriber keyword found in the item — used only to phrase short
// alert copy (subject lines, "touches on X"), never to decide whether something matches.
function findMatchedKeyword(item, keywords) {
  return matchesSubscriberKeywords(item, keywords)[0] || null;
}

// Trims a longer piece of text (an AI summary, typically) down to a short topic phrase —
// first sentence if short enough, else the first few words. Kept short deliberately: this
// feeds subject lines as well as body copy, and a full clause reads like a log line, not
// something a person would actually say.
function shortTopicPhrase(text, maxWords = 6) {
  if (!text) return null;
  const firstSentence = (text.split(/(?<=[.!?])\s/)[0] || text).trim();
  const words = firstSentence.split(/\s+/);
  if (words.length <= maxWords) return firstSentence.replace(/[.!?]+$/, '');
  return words.slice(0, maxWords).join(' ').replace(/[,;:]+$/, '') + '…';
}

// Derives a short, human topic string for one matched item — the subscriber's own matched
// keyword where available (most specific), else a trimmed phrase from the item's AI summary.
// Purely for phrasing subscriber alert emails; does not affect matching.
function deriveItemTopic(item, subscriber) {
  return findMatchedKeyword(item, subscriber?.keywords) || shortTopicPhrase(item.ai?.summary) || null;
}

const SUBSCRIBER_MATCH_SYSTEM_PROMPT =
  'You are a relevance classifier for a legal/regulatory alert system. You are given one ' +
  'regulatory document (title, summary, key excerpts) and a list of subscriber interests, ' +
  'each with an id and a free-text description of what that subscriber cares about. ' +
  'Return ONLY valid JSON — no markdown, no code fences — in exactly this shape: ' +
  '{"matches": [{"id": "<subscriber id>", "reason": "one short sentence on why this document ' +
  'matches that subscriber\'s stated interest"}, ...]}. Include a subscriber only if the ' +
  'document is genuinely relevant to their stated interest, including cases where the document ' +
  'uses different terminology for the same underlying topic (e.g. a subscriber interested in ' +
  '"insolvency proceedings" should match a document about "IBC" or "NCLT" resolution). The ' +
  '"reason" must name the specific connection (e.g. "Introduces new IBC resolution timelines", ' +
  'not "This is relevant to your interests"). If no subscriber is relevant, return {"matches": []}.';

// One Claude call per item — checks it against every subscriber's description at once
// (cheaper than one call per item×subscriber). Returns a Map<subscriberId, reason> — the
// reason is Claude's own one-sentence explanation from the same call, not a second LLM
// call, and feeds the "Why this matched" line in that subscriber's digest email.
async function matchSemanticBatch(item, subscribersWithDescription) {
  if (!ANTHROPIC_API_KEY || !Anthropic) return new Map();
  if (!subscribersWithDescription.length) return new Map();
  try {
    const docCtx = [
      `Title: ${item.title}`,
      `Source: ${item.source} — ${item.type}`,
      item.ai?.summary ? `Summary: ${item.ai.summary}` : '',
      item.ai?.excerpts?.length
        ? 'Key passages: ' + item.ai.excerpts.map(e => `"${e.excerpt}"`).join(' | ')
        : ''
    ].filter(Boolean).join('\n');

    const subsCtx = subscribersWithDescription
      .map(s => `- id: ${s.id} — interest: ${s.description}`)
      .join('\n');

    const raw = await callClaude(
      SUBSCRIBER_MATCH_SYSTEM_PROMPT,
      [{ role: 'user', content: `DOCUMENT:\n${docCtx}\n\nSUBSCRIBER INTERESTS:\n${subsCtx}` }],
      { maxTokens: 400, temperature: 0.1 }
    );
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const matched = cleaned.match(/\{[\s\S]*\}/);
    if (!matched) throw new Error('No JSON in subscriber-match response');
    const data = JSON.parse(matched[0]);
    const validIds = new Set(subscribersWithDescription.map(s => s.id));
    const result = new Map();
    if (Array.isArray(data.matches)) {
      for (const m of data.matches) {
        const id = m?.id;
        if (id && validIds.has(id)) result.set(id, String(m.reason || '').trim().slice(0, 200) || null);
      }
    }
    return result;
  } catch (e) {
    console.error(`Subscriber match error [${item.id.slice(0, 30)}]: ${describeClaudeError(e)}`);
    return new Map();
  }
}

// Generic scraper for RBI pages that use "date header rows" above data rows.
// Structure: some rows contain only a date string (no link) = sets currentDate for rows below.
// Other rows contain title+link in col[0] and filesize in col[1] (ignored).
// Category header rows (no link, not a date) are skipped.
async function scrapeRBIDateHeaderPage(slug, type) {
  const results = [];
  const url = RBI_SCRIPTS_BASE + slug;
  try {
    const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    let currentDate = '';
    $('table.tablebg tr').each((i, row) => {
      const cells = $(row).find('td');
      if (!cells.length) return;
      const link = cells.eq(0).find('a').first();
      const href = link.attr('href') || '';
      if (!href) {
        // No link — may be a date header or category header
        const txt = cells.eq(0).text().replace(/\s+/g, ' ').trim();
        if (parseDate(txt)) currentDate = txt;   // valid date → remember it
        return;                                   // skip this row either way
      }
      const title = link.text().replace(/\s+/g, ' ').trim();
      if (isJunk(title)) return;
      const id = `rbi_${type.replace(/[\s/]+/g,'_').toLowerCase()}_` +
                 Buffer.from((href + title).slice(0, 100)).toString('base64');
      results.push({ id, source: 'RBI', type, title, ref: '', date: currentDate,
        dateSort: parseDate(currentDate) ? parseDate(currentDate).getTime() : 0,
        url: rbiUrl(href), fetchedAt: new Date().toISOString() });
    });
  } catch (e) { console.error(`RBI ${type} error:`, e.message); }
  return results;
}

async function scrapeRBI() {
  const results = [];

  // ── Circulars ─────────────────────────────────────────────────────────────
  // Structure: col[0]=ref+link, col[1]=date, col[3]=subject (plain text, no link)
  try {
    const { data } = await axios.get(RBI_SCRIPTS_BASE + 'BS_CircularIndexDisplay.aspx',
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table.tablebg tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const title = cells.eq(3).text().replace(/\s+/g, ' ').trim();
      const ref   = cells.eq(0).text().replace(/\s+/g, ' ').trim();
      const date  = cells.eq(1).text().trim();
      const href  = cells.eq(0).find('a').first().attr('href') || '';
      if (isJunk(title)) return;
      const id = 'rbi_c_' + Buffer.from((ref + title).slice(0, 100)).toString('base64');
      results.push({ id, source: 'RBI', type: 'Circular', title, ref, date,
        dateSort: parseDate(date) ? parseDate(date).getTime() : 0,
        url: rbiUrl(href), fetchedAt: new Date().toISOString() });
    });
  } catch (e) { console.error('RBI Circular error:', e.message); }

  // ── Press Releases ────────────────────────────────────────────────────────
  // col[0]=title+link, col[1]=filesize (ignored). No date column — use row order.
  try {
    const { data } = await axios.get(RBI_SCRIPTS_BASE + 'BS_PressReleaseDisplay.aspx',
      { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    let rowIndex = 0;
    $('table.tablebg tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (!cells.length) return;
      const link  = cells.eq(0).find('a').first();
      const title = link.text().replace(/\s+/g, ' ').trim();
      const href  = link.attr('href') || '';
      if (isJunk(title)) return;
      const id = 'rbi_pr_' + Buffer.from((href + title).slice(0, 100)).toString('base64');
      results.push({ id, source: 'RBI', type: 'Press Release', title, ref: '', date: '',
        dateSort: -rowIndex,
        url: rbiUrl(href), fetchedAt: new Date().toISOString() });
      rowIndex++;
    });
  } catch (e) { console.error('RBI Press Release error:', e.message); }

  // ── Pages with date-header-row structure ──────────────────────────────────
  const dateHeaderPages = [
    { slug: 'NotificationUser.aspx',              type: 'Notification'     },
    { slug: 'BS_ViewMasDirections.aspx',          type: 'Master Direction' },
    { slug: 'BS_ViewMasterCirculardetails.aspx',  type: 'Master Circular'  },
    { slug: 'BS_SpeechesView.aspx',               type: 'Speech'           },
  ];
  for (const pg of dateHeaderPages) {
    const items = await scrapeRBIDateHeaderPage(pg.slug, pg.type);
    console.log(`  RBI ${pg.type}: ${items.length} items`);
    results.push(...items);
  }

  return results;
}

async function scrapeSEBI() {
  const results = [];
  // Confirmed working sids (all share structure: col[0]=date, col[1]=title+link):
  //   sid=1  Circulars
  //   sid=2  Press Releases
  //   sid=3  Application processing queue (fund/scheme filings) — EXCLUDED (junk)
  //   sid=4  Consultation Papers
  //   sid=6  Speeches & Public Notices
  // SEBI Orders / Regulations / Informal Guidance have no accessible server-side list URL;
  // their pages are JavaScript-rendered and return empty HTML when fetched directly.
  const sources = [
    { url: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=0&smid=0', type: 'Circular' },
    { url: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=0&smid=0', type: 'Press Release' },
    { url: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=4&ssid=0&smid=0', type: 'Consultation Paper' },
    { url: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=6&ssid=0&smid=0', type: 'Speech/Notice' },
  ];

  for (const src of sources) {
    try {
      const { data } = await axios.get(src.url,
        { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = cheerio.load(data);
      // SEBI DataTable: col[0]=date  col[1]=title+link (absolute href)
      $('table tr').each((i, row) => {
        if (i === 0) return;
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const date  = cells.eq(0).text().replace(/\s+/g, ' ').trim();
        const link  = cells.eq(1).find('a').first();
        const title = link.text().replace(/\s+/g, ' ').trim();
        const href  = link.attr('href') || '';
        if (isJunk(title)) return;
        const url = href.startsWith('http') ? href : 'https://www.sebi.gov.in' + href;
        const id  = 'sebi_' + Buffer.from((title + href).slice(0, 100)).toString('base64');
        results.push({ id, source: 'SEBI', type: src.type, title, ref: '', date,
          dateSort: parseDate(date) ? parseDate(date).getTime() : 0,
          url, fetchedAt: new Date().toISOString() });
      });
    } catch (e) { console.error(`SEBI scrape error (${src.type}):`, e.message); }
  }
  return results;
}

async function scrapeIBBI() {
  const results = [];
  // IBBI is a SPA — all "What's New" content is embedded in the homepage
  // inside <ul class="activityTicker"> as dated anchor tags.
  // Link text format: "DDth Month, YYYY <Type>: <Title> (filesize)"
  // hrefs point to PDFs at /uploads/whatsnew/... or /uploads/legalframwork/...
  // We only take items from 2025 onwards to avoid loading the full 2016+ archive.
  const CUTOFF_YEAR = 2025;

  try {
    const { data } = await axios.get('https://ibbi.gov.in', {
      timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const $ = cheerio.load(data);

    // Date prefix pattern: "04th June, 2026 ..."
    const DATE_RE  = /^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+),?\s+(\d{4})\s*/i;
    // File size suffix: " (871.79 KB)" or " (1.2 MB)"
    const SIZE_RE  = /\s*\(\d+[\d.]*\s*(?:KB|MB|bytes?)\)\s*$/i;

    $('ul.activityTicker a, ul.activityTicker li a').each((i, el) => {
      const raw  = $(el).text().replace(/\s+/g, ' ').trim();
      const href = $(el).attr('href') || '';
      if (!raw || !href) return;

      // Parse and validate date
      const dm = raw.match(DATE_RE);
      if (!dm) return;
      const year = Number(dm[3]);
      if (year < CUTOFF_YEAR) return;

      const monthIdx = MONTHS[dm[2].toLowerCase().slice(0, 3)];
      if (monthIdx === undefined) return;
      const dateObj = new Date(year, monthIdx, Number(dm[1]));
      const date    = `${String(dm[1]).padStart(2,'0')}${['st','nd','rd','th'][Math.min(Number(dm[1])-1,3)>3?3:Math.min(Number(dm[1])-1,3)]} ${dm[2]}, ${year}`;

      // Strip date prefix to get the rest
      let rest = raw.replace(DATE_RE, '').trim();
      // Strip file size suffix
      rest = rest.replace(SIZE_RE, '').trim();

      // Classify type and strip type prefix from title
      let type, title;
      if (/^press\s*release\s*[:\-–]/i.test(rest)) {
        type  = 'Press Release';
        title = rest.replace(/^press\s*release\s*[:\-–]\s*/i, '').trim();
      } else if (/^circular\s*[:\-–]/i.test(rest)) {
        type  = 'Circular';
        title = rest.replace(/^circular\s*[:\-–]\s*/i, '').trim();
      } else if (/^order\s*[:\-–]/i.test(rest)) {
        type  = 'Order';
        title = rest.replace(/^order\s*[:\-–]\s*/i, '').trim();
      } else if (/^discussion\s*paper\s*[:\-–]?/i.test(rest)) {
        type  = 'Discussion Paper';
        title = rest.replace(/^discussion\s*paper\s*[:\-–]?\s*/i, '').trim() || rest;
      } else if (/^notification\s*[:\-–]?/i.test(rest)) {
        type  = 'Notification';
        title = rest.replace(/^notification\s*[:\-–]?\s*/i, '').trim() || rest;
      } else if (/^agenda\b|^minutes\b/i.test(rest)) {
        type  = 'Agenda/Minutes';
        title = rest;
      } else if (/regulation|amendment/i.test(rest)) {
        type  = 'Regulation';
        title = rest;
      } else {
        type  = 'Notice';
        title = rest;
      }

      if (isJunk(title)) return;

      const url = href.startsWith('http') ? href : 'https://ibbi.gov.in' + href;
      const id  = 'ibbi_' + Buffer.from((href + title).slice(0, 100)).toString('base64');

      results.push({
        id, source: 'IBBI', type, title, ref: '', date,
        dateSort:  dateObj.getTime(),
        url, fetchedAt: new Date().toISOString()
      });
    });
  } catch (e) { console.error('IBBI scrape error:', e.message); }

  return results;
}

// ─── Keyword matching ─────────────────────────────────────────────────────────

// `chunkTextById` (optional) maps itemId -> concatenated lower-cased chunk text,
// letting the keyword filter match against full document content (not just the
// title) when it's available. Falls back to title-only matching when omitted —
// e.g. during the scrape pipeline, before chunks for new items exist yet.
function matchesKeywords(item, keywords, chunkTextById) {
  if (!keywords || keywords.length === 0) return true;
  let hay = item.title.toLowerCase();
  if (chunkTextById) {
    const chunkText = chunkTextById.get(item.id);
    if (chunkText) hay += ' ' + chunkText;
  }
  return keywords.some(kw => hay.includes(kw.toLowerCase()));
}

// Builds a map of itemId -> concatenated lower-cased chunk text, used so the
// keyword filter can search full document content rather than just titles.
function buildChunkTextIndex(chunks) {
  const map = new Map();
  for (const c of (chunks || [])) {
    if (!c || !c.parentId || !c.text) continue;
    const cur = map.get(c.parentId);
    const piece = c.text.toLowerCase();
    map.set(c.parentId, cur ? cur + ' ' + piece : piece);
  }
  return map;
}

// ─── Email helpers ────────────────────────────────────────────────────────────

// Builds a personalized digest email for one subscriber — same visual structure as the
// original single-recipient email, plus an intro line naming what this subscriber is
// subscribed to so the alert's relevance is obvious at a glance.
function buildSubscriberEmailHtml(items, subscriber, isTest = false) {
  const header = isTest
    ? `<p style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:10px 14px;margin-bottom:20px;font-size:13px;color:#856404">
         ⚠️ This is a <strong>test email</strong> — no new items were actually found. Your alerts are configured correctly.
       </p>`
    : '';

  // Human-toned intro — names what's relevant instead of reading like a match-count log.
  let introHtml = '';
  let closingHtml = '';
  if (!isTest) {
    if (items.length === 1) {
      const topic = deriveItemTopic(items[0], subscriber);
      const relevanceClause = topic
        ? ` — flagged because it touches on <strong>${topic}</strong>, which is one of your alert topics`
        : '';
      introHtml = `
        <p style="color:#374151;margin:0 0 4px;font-size:14px">Hi there,</p>
        <p style="color:#374151;margin:0 0 18px;font-size:14px;line-height:1.5">
          ${items[0].source} just published something that looks relevant to what you're tracking${relevanceClause}.
        </p>`;
      closingHtml = `<p style="color:#374151;margin:16px 0 0;font-size:14px">Worth a look if this touches any live matters.</p>`;
    } else {
      introHtml = `
        <p style="color:#374151;margin:0 0 4px;font-size:14px">Hi there,</p>
        <p style="color:#374151;margin:0 0 18px;font-size:14px">A few things came up worth a look:</p>`;
    }
  }

  const rows = items.map(it => {
    const dateStr  = it.dateFormatted || it.date || '—';
    const srcColor = it.source === 'RBI' ? '#d97706' : '#2563eb';
    const srcBg    = it.source === 'RBI' ? '#fef3c7' : '#dbeafe';
    return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #e5e7eb;vertical-align:top">
        <div style="margin-bottom:6px">
          <span style="display:inline-block;background:${srcBg};color:${srcColor};
            font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;
            letter-spacing:.04em;margin-right:6px">${it.source}</span>
          <span style="display:inline-block;background:#f3f4f6;color:#6b7280;
            font-size:11px;padding:2px 8px;border-radius:10px">${it.type}</span>
          ${dateStr !== '—' ? `<span style="color:#9ca3af;font-size:12px;margin-left:8px">📅 ${dateStr}</span>` : ''}
        </div>
        <div style="margin-bottom:6px">
          <a href="${it.url}" style="color:#1d4ed8;font-size:14px;font-weight:500;
            text-decoration:none;line-height:1.4">${it.title}</a>
        </div>
        ${it.ref ? `<div style="color:#9ca3af;font-size:11px;font-family:monospace">${it.ref}</div>` : ''}
        ${it.whyMatched ? `<div style="color:#6b7280;font-size:12px;margin-top:6px;font-style:italic">
          💡 Why this matched: ${it.whyMatched.detail}${it.whyMatched.matchType === 'keyword' ? ' (keyword)' : ' (semantic match)'}
        </div>` : ''}
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:620px;margin:32px auto;background:#ffffff;
    border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:#1a1d27;padding:20px 28px;display:flex;align-items:center">
      <span style="font-size:20px;margin-right:10px">⚖️</span>
      <span style="color:#ffffff;font-size:17px;font-weight:700">Regulatory Monitor</span>
    </div>

    <!-- Body -->
    <div style="padding:24px 28px">
      ${header}
      ${introHtml}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
        ${rows}
      </table>
      ${closingHtml}
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:12px 28px;font-size:11px;color:#b0b5bd;
      border-top:1px solid #e5e7eb">
      Sent by Regulatory Monitor · Scrapes RBI, SEBI &amp; IBBI every 2 hours ·
      <a href="${APP_URL}" style="color:#9ca3af">Open dashboard</a>
    </div>
  </div>
</body>
</html>`;
}

async function createTransporter() {
  const em = getEmailConfig();
  return nodemailer.createTransport({
    host:   em.host,
    port:   em.port,
    secure: em.port === 465,
    auth:   { user: em.user, pass: em.pass }
  });
}

const SUBSCRIBER_SENT_ID_CAP = 2000;

// Checks every new item against every enabled subscriber (keyword OR Claude semantic match
// against their free-text description) and sends each subscriber a personalized digest
// containing only what's relevant to them. Tracks sent item ids per subscriber so an item
// is never emailed twice to the same person.
async function dispatchSubscriberAlerts(newItems, subscribers, cfg) {
  const em = getEmailConfig();
  if (!em.enabled || !em.user) return;
  if (!newItems.length || !subscribers.length) return;

  // ── Semantic pass: one Claude call per analysed item, checked against all
  // description-bearing subscribers at once ──────────────────────────────────
  const withDescription = subscribers
    .filter(s => s.description && s.description.trim())
    .map(s => ({ id: s.id, description: s.description.trim() }));

  const semanticMap = new Map(); // subscriberId -> Map(itemId -> reason)
  if (withDescription.length) {
    const semanticEligible = newItems.filter(it => it.ai?.summary);
    for (let i = 0; i < semanticEligible.length; i++) {
      const item = semanticEligible[i];
      const matches = await matchSemanticBatch(item, withDescription); // Map<subId, reason>
      for (const [subId, reason] of matches) {
        if (!semanticMap.has(subId)) semanticMap.set(subId, new Map());
        semanticMap.get(subId).set(item.id, reason);
      }
      if (i < semanticEligible.length - 1) await new Promise(r => setTimeout(r, 2500));
    }
  }

  // ── Per-subscriber matching + send ──────────────────────────────────────────
  let configChanged = false;
  for (const sub of subscribers) {
    try {
      const sentSet = new Set(sub.sentItemIds || []);
      const subSemanticReasons = semanticMap.get(sub.id); // Map<itemId, reason> | undefined

      // "Why matched" is resolved once here, per (subscriber, item) pair, and carried on a
      // shallow copy of the item so buildSubscriberEmailHtml() can render it without needing
      // its own matching logic. Keyword match takes priority when both apply (it's the more
      // specific, verifiable reason); falls back to the semantic reason, which is Claude's
      // own explanation from the same matchSemanticBatch() call — no second LLM call.
      const matched = newItems
        .filter(it => !sentSet.has(it.id))
        .map(it => {
          const kwMatches = matchesSubscriberKeywords(it, sub.keywords);
          const semReason = subSemanticReasons?.get(it.id);
          if (!kwMatches.length && !semReason) return null;
          const whyMatched = kwMatches.length
            ? { matchType: 'keyword', detail: kwMatches.join(', ') }
            : { matchType: 'semantic', detail: semReason };
          return { ...it, whyMatched };
        })
        .filter(Boolean);
      if (!matched.length) continue;

      const transporter = await createTransporter();
      const sources = [...new Set(matched.map(it => it.source))];
      // Hardcoded "Sujay" greeting — single-subscriber hackathon demo only, not meant to
      // generalize (no subscriber name field exists/is planned yet).
      let subject;
      if (matched.length === 1) {
        const topic = deriveItemTopic(matched[0], sub);
        subject = topic
          ? `Heads up, Sujay - new ${matched[0].source} circular on ${topic}`
          : `Heads up, Sujay - new ${matched[0].source} circular worth a look`;
      } else if (sources.length === 1) {
        subject = `Heads up, Sujay - ${matched.length} new ${sources[0]} updates worth a look`;
      } else {
        subject = `Heads up, Sujay - new ${sources.join('/')} updates worth a look`;
      }
      await transporter.sendMail({
        from:    `"Regulatory Monitor" <${em.user}>`,
        to:      sub.email,
        subject,
        html:    buildSubscriberEmailHtml(matched, sub)
      });
      console.log(`Email sent to ${sub.email}: ${matched.length} items`);

      sub.sentItemIds = [...sentSet, ...matched.map(it => it.id)].slice(-SUBSCRIBER_SENT_ID_CAP);
      // Email Alerts UI tracking only — doesn't affect who gets matched or when alerts fire.
      // Powers the delivery settings' connection-status indicator (Task 2). No such tracking
      // existed before that.
      cfg.email.lastSendAt = new Date().toISOString();
      cfg.email.lastSendOk = true;
      configChanged = true;
    } catch (e) {
      console.error(`Subscriber email error [${sub.email}]:`, e.message);
      cfg.email.lastSendAt = new Date().toISOString();
      cfg.email.lastSendOk = false;
      configChanged = true;
    }
  }

  if (configChanged) writeConfig(cfg);
}

// ─── Main scrape job ──────────────────────────────────────────────────────────

let scrapeLog = [];

async function runScrape(manual = false) {
  console.log(`[${new Date().toISOString()}] Scrape started (${manual ? 'manual' : 'scheduled'})`);
  const cfg = readConfig();

  // Network scraping happens before the store lock is acquired — it doesn't touch
  // store.json and can take a while; no reason to block uploads/backfill on it.
  let rbiItems = [], sebiItems = [], ibbiItems = [];
  try { rbiItems  = await scrapeRBI();   } catch (e) { console.error('RBI failed:',  e.message); }
  try { sebiItems = await scrapeSEBI();  } catch (e) { console.error('SEBI failed:', e.message); }
  try { ibbiItems = await scrapeIBBI();  } catch (e) { console.error('IBBI failed:', e.message); }
  const allFetched = [...rbiItems, ...sebiItems, ...ibbiItems];

  const { newItems, matching } = await withStoreLock(async () => {
  const store = readStore();
  const seenSet = new Set(store.seenIds);
  const newItems = allFetched.filter(it => !seenSet.has(it.id));

  // ── Claude AI analysis — only on new items ──────────────────────────────────
  // Throttled with a short delay between calls to stay well within rate limits.
  // Cap at 20 items per scrape so a large first-run doesn't hammer the API.
  const claudeAnalyzed = new Set();
  if (ANTHROPIC_API_KEY && newItems.length > 0) {
    const toAnalyze = newItems.slice(0, 20);
    console.log(`Claude: analysing ${toAnalyze.length} of ${newItems.length} new items…`);
    for (let i = 0; i < toAnalyze.length; i++) {
      const result = await analyzeAndChunkItem(toAnalyze[i], cfg.keywords);
      toAnalyze[i].ai       = result.ai;
      toAnalyze[i].refInfo  = result.refInfo;
      toAnalyze[i].repeals  = result.repeals;
      claudeAnalyzed.add(toAnalyze[i].id);
      if (result.chunks.length) {
        if (!Array.isArray(store.chunks)) store.chunks = [];
        store.chunks = store.chunks.filter(c => c.parentId !== toAnalyze[i].id);
        store.chunks.push(...result.chunks);
      }
      if (toAnalyze[i].ai) {
        const ex = toAnalyze[i].ai.excerpts.length;
        console.log(`  ✓ excerpts=${ex} chunks=${result.chunks.length} "${toAnalyze[i].title.slice(0, 50)}"`);
      }
      if (i < toAnalyze.length - 1) await new Promise(r => setTimeout(r, 2500));
    }
  }

  // ── Document Validity Checker Stage 1 — deterministic, runs on EVERY new item ──
  // (not just the Claude-capped 20) since it's regex-only, no AI call, per spec.
  // Items already processed above got refInfo/repeals for free from that same fetch.
  const remainingForRefs = newItems.filter(it => !claudeAnalyzed.has(it.id));
  if (remainingForRefs.length > 0) {
    console.log(`Stage 1: extracting references for ${remainingForRefs.length} more new items…`);
    for (let i = 0; i < remainingForRefs.length; i++) {
      const result = await extractReferencesOnly(remainingForRefs[i]);
      remainingForRefs[i].refInfo = result.refInfo;
      remainingForRefs[i].repeals = result.repeals;
      if (i < remainingForRefs.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  const matching   = newItems.filter(it => matchesKeywords(it, cfg.keywords));

  newItems.forEach(it => seenSet.add(it.id));
  store.seenIds = [...seenSet];
  // Store all items sorted by date descending — capped at 1000, but manually-added
  // documents are exempt (see capStoreItems).
  store.items = capStoreItems([...newItems, ...store.items]);

  // Resolve Stage 1 references now that the full pool (old + all new items from
  // this scrape) is assembled — handles both arrival orders (see resolveReferencesForItem).
  for (const it of newItems) {
    if (it.refInfo || (it.repeals && it.repeals.length)) resolveReferencesForItem(it, store);
  }

  writeStore(store);
  return { newItems, matching };
  }); // end withStoreLock

  cfg.lastScraped = new Date().toISOString();
  writeConfig(cfg);

  const entry = { time: new Date().toISOString(), fetched: allFetched.length, newItems: newItems.length, matching: matching.length };
  scrapeLog.unshift(entry);
  scrapeLog = scrapeLog.slice(0, 50);

  const activeSubscribers = (cfg.subscribers || []).filter(s => s.enabled !== false);
  if (newItems.length > 0 && activeSubscribers.length > 0) {
    await dispatchSubscriberAlerts(newItems, activeSubscribers, cfg);
  }

  console.log(`Scrape done: fetched=${allFetched.length} new=${newItems.length} matching=${matching.length}`);
  return entry;
}

// ─── Chunk backfill (RAG) ─────────────────────────────────────────────────────
// Re-processes documents that predate chunking — re-fetches each one's URL,
// extracts its text, and stores ~650-word overlapping chunks so older
// documents become searchable at the section level too. Runs in small,
// rate-limited batches (no Claude calls — just fetch + parse + chunk) and
// re-schedules itself until every document with a URL has been chunked.
let chunkBackfillRunning = false;

// The slow part (fetching each candidate's URL — up to 30s timeout each, ×25 items)
// runs UNLOCKED, so a document upload or another operation isn't stuck waiting behind
// a whole batch of network I/O. The store lock is only held for the brief final merge
// + write. (An earlier version held the lock for the entire batch, which — combined
// with a slow/flaky network path to the regulator sites in testing — could stall
// everything else for many minutes; this also still needs the lock at all, since
// without it a document uploaded mid-batch could vanish when this job's stale
// in-memory copy overwrote the file.)
async function backfillChunksBatch(batchSize = 25) {
  if (chunkBackfillRunning) return { ok: false, busy: true };
  chunkBackfillRunning = true;
  try {
    const snapshot = readStore();
    const chunkedParents = new Set((snapshot.chunks || []).map(c => c.parentId));
    const candidates = snapshot.items.filter(it => it.url && !chunkedParents.has(it.id));
    const todo = candidates.slice(0, batchSize);
    if (!todo.length) return { ok: true, processed: 0, remaining: 0 };

    console.log(`Chunk backfill: processing ${todo.length} of ${candidates.length} remaining documents…`);
    const results = [];
    let failed = 0;
    for (const item of todo) {
      try {
        const { fullText } = await fetchFullTextForItem(item);
        if (fullText && fullText.trim()) {
          results.push({ id: item.id, fullText });
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 600)); // be polite to regulator websites
    }

    const { processed, remaining, totalChunks } = await withStoreLock(async () => {
      const store = readStore();
      if (!Array.isArray(store.chunks)) store.chunks = [];
      let processed = 0;
      for (const r of results) {
        const item = store.items.find(it => it.id === r.id);
        if (!item) continue;
        upsertChunksForItem(store, item, r.fullText);
        processed++;
      }
      writeStore(store);
      const stillChunkedParents = new Set(store.chunks.map(c => c.parentId));
      const remaining = store.items.filter(it => it.url && !stillChunkedParents.has(it.id)).length;
      return { processed, remaining, totalChunks: store.chunks.length };
    });

    console.log(`Chunk backfill batch done: processed=${processed} failed=${failed} remaining=${remaining} totalChunks=${totalChunks}`);
    return { ok: true, processed, failed, remaining };
  } catch (e) {
    console.error('Chunk backfill error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    chunkBackfillRunning = false;
  }
}

// Keeps running small batches until every existing document has been chunked.
function scheduleChunkBackfill(delayMs = 12000) {
  setTimeout(async () => {
    const result = await backfillChunksBatch(25);
    if (result && result.ok && result.remaining > 0) {
      scheduleChunkBackfill(15000);
    } else if (result && result.ok) {
      console.log('Chunk backfill: all existing documents have been chunked.');
    } else {
      scheduleChunkBackfill(60000); // back off on error / busy
    }
  }, delayMs);
}

// ─── Document Validity Checker — reference backfill ───────────────────────────
// Mirrors the chunk backfill above exactly, but for Stage 1 reference extraction.
// A SEPARATE job (not folded into the chunk backfill) because that job's candidate
// filter is "not yet chunked" — nearly the whole existing store is already chunked,
// so it would never revisit these documents to parse references. Runs continuously
// in the background; not a prerequisite for the feature working on any one document,
// since both fresh-ingestion paths already call resolveReferencesForItem() themselves.
let referenceBackfillRunning = false;

// Same shape as backfillChunksBatch above: slow network fetches run unlocked, the
// store lock is only held for the brief final merge + write.
async function backfillReferencesBatch(batchSize = 25) {
  if (referenceBackfillRunning) return { ok: false, busy: true };
  referenceBackfillRunning = true;
  try {
    const snapshot = readStore();
    // `repeals` is always set to an array (possibly empty) once Stage 1 has run on an
    // item, via any path — so "undefined" is the reliable "never processed" sentinel.
    // (Checking refInfo instead would be wrong: it's legitimately `null` for documents
    // with no parseable reference number of their own, which is a normal, done state.)
    const candidates = snapshot.items.filter(it => it.url && it.repeals === undefined);
    const todo = candidates.slice(0, batchSize);
    if (!todo.length) return { ok: true, processed: 0, remaining: 0 };

    console.log(`Reference backfill: processing ${todo.length} of ${candidates.length} remaining documents…`);
    const results = [];
    let failed = 0;
    for (const item of todo) {
      try {
        const { linePreserved } = await fetchFullTextForItem(item);
        const refInfo = parseOwnReference(item, linePreserved);
        const repeals = extractRepealReferences(linePreserved, item.source, refInfo?.raw);
        results.push({ id: item.id, refInfo, repeals });
      } catch (e) {
        failed++;
        // Still record this item as "processed" (repeals: []) rather than leaving
        // repeals undefined — otherwise a permanently-failing fetch (file too large,
        // a non-regulator host blocking scrapers, a malformed PDF) retries forever,
        // every batch, indefinitely. `refExtractionFailed` keeps that distinguishable
        // from "genuinely no references found" for anyone inspecting the record later;
        // POST /api/validity/:id/reprocess-stage1 can still retry it manually on demand.
        results.push({ id: item.id, refInfo: null, repeals: [], failedReason: e.message });
      }
      await new Promise(r => setTimeout(r, 600)); // be polite to regulator websites
    }

    const { processed, remaining } = await withStoreLock(async () => {
      const store = readStore();
      let processed = 0;
      for (const r of results) {
        const item = store.items.find(it => it.id === r.id);
        if (!item) continue;
        item.refInfo = r.refInfo;
        item.repeals = r.repeals;
        if (r.failedReason) item.refExtractionFailed = r.failedReason;
        else delete item.refExtractionFailed;
        if (item.refInfo || item.repeals.length) resolveReferencesForItem(item, store);
        processed++;
      }
      writeStore(store);
      const remaining = store.items.filter(it => it.url && it.repeals === undefined).length;
      return { processed, remaining };
    });

    console.log(`Reference backfill batch done: processed=${processed} failed=${failed} remaining=${remaining}`);
    return { ok: true, processed, failed, remaining };
  } catch (e) {
    console.error('Reference backfill error:', e.message);
    return { ok: false, error: e.message };
  } finally {
    referenceBackfillRunning = false;
  }
}

function scheduleReferenceBackfill(delayMs = 12000) {
  setTimeout(async () => {
    const result = await backfillReferencesBatch(25);
    if (result && result.ok && result.remaining > 0) {
      scheduleReferenceBackfill(15000);
    } else if (result && result.ok) {
      console.log('Reference backfill: all existing documents have been checked for references.');
    } else {
      scheduleReferenceBackfill(60000); // back off on error / busy
    }
  }, delayMs);
}

// ─── API ──────────────────────────────────────────────────────────────────────

app.use(basicAuth({
  users: { [process.env.DEMO_USER]: process.env.DEMO_PASSWORD },
  challenge: true,
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET items
app.get('/api/items', (req, res) => {
  const store = readStore();
  let items = store.items; // already sorted by date desc

  const { source, keywords, page = 1, limit = 100 } = req.query;

  if (source && source !== 'ALL') items = items.filter(i => i.source === source);

  // keywords = comma-separated active keyword filter (empty = show all)
  if (keywords && keywords.trim()) {
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (kws.length > 0) {
      // Search full chunk content (not just titles) so the filter surfaces any
      // document where the keyword appears anywhere in its text.
      const chunkTextById = buildChunkTextIndex(store.chunks);
      items = items.filter(i => matchesKeywords(i, kws, chunkTextById));
    }
  }

  const start = (Number(page) - 1) * Number(limit);
  res.json({
    total: items.length,
    page: Number(page),
    items: items.slice(start, start + Number(limit)).map(it => ({
      ...it,
      dateFormatted: formatDate(it.date) || it.date || null
    })),
    lastScraped: readConfig().lastScraped
  });
});

// GET config
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  const em  = getEmailConfig();
  // Never send the real password to the frontend — show masked value if set
  res.json({ ...cfg, email: { ...em, pass: em.pass ? '••••••' : '' } });
});

// PUT config
app.put('/api/config', (req, res) => {
  const cfg  = readConfig();
  const body = req.body;
  if (Array.isArray(body.keywords)) cfg.keywords = body.keywords;
  if (body.email) {
    const prev = cfg.email.pass;
    cfg.email = { ...cfg.email, ...body.email };
    if (cfg.email.pass === '••••••') cfg.email.pass = prev;
  }
  writeConfig(cfg);
  res.json({ ok: true });
});

// POST manual scrape
app.post('/api/scrape', (req, res) => {
  res.json({ ok: true });
  runScrape(true).catch(console.error);
});

// GET / POST chunk backfill status & manual trigger (RAG re-processing of older documents)
app.get('/api/chunks/status', (req, res) => {
  const store = readStore();
  const chunks = Array.isArray(store.chunks) ? store.chunks : [];
  const chunkedParents = new Set(chunks.map(c => c.parentId));
  const withUrl = store.items.filter(it => it.url).length;
  res.json({
    totalChunks:    chunks.length,
    documentsChunked: chunkedParents.size,
    documentsWithUrl: withUrl,
    remaining:      Math.max(0, withUrl - chunkedParents.size),
    running:        chunkBackfillRunning
  });
});

app.post('/api/chunks/backfill', (req, res) => {
  res.json({ ok: true, started: true });
  backfillChunksBatch(Number(req.body?.batchSize) || 25).then(result => {
    if (result && result.ok && result.remaining > 0) scheduleChunkBackfill(8000);
  }).catch(console.error);
});

// GET scrape log
app.get('/api/log', (req, res) => res.json(scrapeLog));

// ─── Subscribers ──────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function genSubscriberId() {
  return 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// GET subscribers — no auth on this app (internal tool), same as /api/config
app.get('/api/subscribers', (req, res) => {
  const cfg = readConfig();
  res.json(cfg.subscribers || []);
});

// POST subscribers — create. Requires a valid email and at least one of keywords/description.
app.post('/api/subscribers', (req, res) => {
  const { email, keywords, description } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  const kws = Array.isArray(keywords) ? keywords.map(k => String(k).trim()).filter(Boolean) : [];
  const desc = typeof description === 'string' ? description.trim() : '';
  if (!kws.length && !desc) {
    return res.status(400).json({ ok: false, error: 'Provide at least one keyword or a description' });
  }

  const cfg = readConfig();
  if (!Array.isArray(cfg.subscribers)) cfg.subscribers = [];
  const subscriber = {
    id: genSubscriberId(),
    email: email.trim(),
    keywords: kws,
    description: desc,
    enabled: true,
    createdAt: new Date().toISOString(),
    sentItemIds: []
  };
  cfg.subscribers.push(subscriber);
  writeConfig(cfg);
  res.json({ ok: true, subscriber });
});

// PUT subscribers/:id — update keywords / description / enabled
app.put('/api/subscribers/:id', (req, res) => {
  const cfg = readConfig();
  const sub = (cfg.subscribers || []).find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });

  const { keywords, description, enabled } = req.body || {};
  if (Array.isArray(keywords)) sub.keywords = keywords.map(k => String(k).trim()).filter(Boolean);
  if (typeof description === 'string') sub.description = description.trim();
  if (typeof enabled === 'boolean') sub.enabled = enabled;
  if (!sub.keywords.length && !sub.description) {
    return res.status(400).json({ ok: false, error: 'Subscriber must keep at least one keyword or a description' });
  }
  writeConfig(cfg);
  res.json({ ok: true, subscriber: sub });
});

// DELETE subscribers/:id — unsubscribe
app.delete('/api/subscribers/:id', (req, res) => {
  const cfg = readConfig();
  const before = (cfg.subscribers || []).length;
  cfg.subscribers = (cfg.subscribers || []).filter(s => s.id !== req.params.id);
  if (cfg.subscribers.length === before) return res.status(404).json({ ok: false, error: 'Subscriber not found' });
  writeConfig(cfg);
  res.json({ ok: true });
});

// TEMPORARY verification-only route for the "Why this matched" feature — runs the real
// matchesSubscriberKeywords()/matchSemanticBatch() against specific real store items for a
// real subscriber (so the semantic reason is an actual Claude call, made server-side where
// the API key lives, not fabricated) and sends the real digest email, with the exact same
// subject line dispatchSubscriberAlerts() would use — not a "[TEST]"-style label. Does NOT
// touch sentItemIds. Meant to be removed once verified — not a feature the UI exposes.
app.post('/api/subscribers/:id/test-real-match', async (req, res) => {
  const cfg = readConfig();
  const sub = (cfg.subscribers || []).find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });
  const em = getEmailConfig();
  if (!em.enabled || !em.user) return res.status(400).json({ ok: false, error: 'SMTP sender is not configured' });

  try {
    const store = readStore();
    const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
    const items = itemIds.map(id => store.items.find(it => it.id === id)).filter(Boolean);
    if (!items.length) return res.status(400).json({ ok: false, error: 'No matching items found for the given itemIds.' });

    const semanticEligible = sub.description?.trim() ? items.filter(it => it.ai?.summary) : [];
    const semanticReasonByItemId = new Map();
    for (let i = 0; i < semanticEligible.length; i++) {
      const matches = await matchSemanticBatch(semanticEligible[i], [{ id: sub.id, description: sub.description.trim() }]);
      const reason = matches.get(sub.id);
      if (reason !== undefined) semanticReasonByItemId.set(semanticEligible[i].id, reason);
      if (i < semanticEligible.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    const matched = items.map(it => {
      const kwMatches = matchesSubscriberKeywords(it, sub.keywords);
      const semReason = semanticReasonByItemId.get(it.id);
      const whyMatched = kwMatches.length
        ? { matchType: 'keyword', detail: kwMatches.join(', ') }
        : (semReason ? { matchType: 'semantic', detail: semReason } : null);
      return { ...it, whyMatched };
    });

    // Same subject-building logic as dispatchSubscriberAlerts() — reused, not duplicated
    // with different wording, so this test reflects exactly what a real alert would say.
    const sources = [...new Set(matched.map(it => it.source))];
    let subject;
    if (matched.length === 1) {
      const topic = deriveItemTopic(matched[0], sub);
      subject = topic
        ? `Heads up, Sujay - new ${matched[0].source} circular on ${topic}`
        : `Heads up, Sujay - new ${matched[0].source} circular worth a look`;
    } else if (sources.length === 1) {
      subject = `Heads up, Sujay - ${matched.length} new ${sources[0]} updates worth a look`;
    } else {
      subject = `Heads up, Sujay - new ${sources.join('/')} updates worth a look`;
    }

    const transporter = await createTransporter();
    await transporter.sendMail({
      from: `"Regulatory Monitor" <${em.user}>`,
      to: sub.email,
      subject,
      html: buildSubscriberEmailHtml(matched, sub, false)
    });
    res.json({ ok: true, sentTo: sub.email, subject, whyMatched: matched.map(it => ({ id: it.id, title: it.title, whyMatched: it.whyMatched })) });
  } catch (e) {
    console.error('test-real-match error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST subscribers/:id/test — sends a sample digest (up to 3 real stored items, or a
// placeholder if none exist yet). Does not touch sentItemIds — a test send is not a real alert.
app.post('/api/subscribers/:id/test', async (req, res) => {
  const cfg = readConfig();
  const sub = (cfg.subscribers || []).find(s => s.id === req.params.id);
  if (!sub) return res.status(404).json({ ok: false, error: 'Subscriber not found' });

  const em = getEmailConfig();
  if (!em.enabled || !em.user) {
    return res.status(400).json({ ok: false, error: 'SMTP sender is not configured' });
  }
  try {
    const store    = readStore();
    const samples  = store.items.slice(0, 3);
    const isTest   = samples.length === 0;
    const items    = isTest
      ? [{ source:'RBI', type:'Circular', title:'Sample: Investments by Foreign Portfolio Investors in Government Securities',
           date:'05 Jun 2026', dateFormatted:'05 Jun 2026', ref:'RBI/2026-2027/97',
           url:'https://www.rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx' }]
      : samples;

    const transporter = await createTransporter();
    await transporter.sendMail({
      from:    `"Regulatory Monitor" <${em.user}>`,
      to:      sub.email,
      subject: `[TEST] Regulatory Monitor email test`,
      html:    buildSubscriberEmailHtml(items, sub, true)
    });
    // Counts toward the connection-status indicator (any successful send proves SMTP
    // works) — consistent with test sends already being excluded from sentItemIds above.
    cfg.email.lastSendAt = new Date().toISOString();
    cfg.email.lastSendOk = true;
    writeConfig(cfg);
    res.json({ ok: true, sentTo: sub.email, sentAt: cfg.email.lastSendAt });
  } catch (e) {
    console.error('Test email error:', e.message);
    cfg.email.lastSendAt = new Date().toISOString();
    cfg.email.lastSendOk = false;
    writeConfig(cfg);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Document input (URL + file upload) ──────────────────────────────────────

// Map a hostname to a known regulator. Returns null if not recognised —
// used to validate that pasted URLs come from RBI / SEBI / IBBI.
function detectSourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('rbi.org.in'))  return 'RBI';
    if (host.includes('sebi.gov.in')) return 'SEBI';
    if (host.includes('ibbi.gov.in')) return 'IBBI';
    return null;
  } catch { return null; }
}

// Confirms an axios arraybuffer response actually is a PDF before handing it to
// pdf-parse — some regulator PDF hosts serve an HTML page (redirect, error, or
// anti-bot block) instead of the requested file, which pdf-parse only reports as
// an opaque "Invalid PDF structure". Checking content-type + the %PDF magic bytes
// catches this specifically, so the route can give a clear, actionable error
// instead of a generic failure.
function assertLooksLikePdf(resp) {
  const contentType = resp.headers?.['content-type'] || '';
  const buf = Buffer.from(resp.data);
  const looksLikePdf = /pdf/i.test(contentType) || buf.slice(0, 4).toString('latin1') === '%PDF';
  if (!looksLikePdf) throw new Error('NOT_A_PDF');
}

// Builds a canonical store item — identical shape to the ones produced by the scrapers —
// runs AI analysis, dedupes, saves, and returns the finished item.
async function ingestDocument({ source, type, title, ref, date, url, fullText, linePreserved }) {
  const cfg = readConfig();

  const id = `manual-${source}-${Buffer.from(url || title).toString('base64').slice(0, 40)}-${Date.now()}`;

  const item = {
    id,
    source,
    type:      type || 'Document',
    title:     title || 'Untitled document',
    ref:       ref || '',
    date:      date || formatDate(new Date().toISOString()) || new Date().toISOString().slice(0, 10),
    dateSort:  parseDate(date) ? parseDate(date).getTime() : Date.now(),
    url:       url || '',
    fetchedAt: new Date().toISOString(),
    addedManually: true
  };

  // Run AI summarisation directly off the text we already extracted (no re-fetch).
  // Deliberately done BEFORE the store lock below — this is the slow part (a Claude
  // call), and it doesn't touch store.json, so there's no reason to hold the lock
  // (and block uploads/scrapes/backfill) for its duration.
  item.ai = await analyzeExtractedText(item, fullText, cfg.keywords);

  // Document Validity Checker Stage 1 — deterministic reference extraction, always
  // runs at ingestion (no extra fetch — linePreserved was captured by the caller
  // from the same PDF/HTML parse used for fullText above). Also doesn't touch store.json.
  item.refInfo = parseOwnReference(item, linePreserved || '');
  item.repeals = extractRepealReferences(linePreserved || '', source, item.refInfo?.raw);

  await withStoreLock(async () => {
    const store = readStore();

    // Chunk the full text immediately so this document is searchable at the
    // section level (RAG) the moment it's added — exactly like scraped documents.
    upsertChunksForItem(store, item, fullText);

    const seenSet = new Set(store.seenIds);
    seenSet.add(id);
    store.seenIds = [...seenSet];
    // item.addedManually is always true here — capStoreItems() keeps it regardless
    // of the 1000-item cap on auto-scraped documents.
    store.items   = capStoreItems([item, ...store.items]);

    // Resolve against the now-complete pool — handles both arrival orders (see
    // resolveReferencesForItem): this document may be the repealer or the repealed one.
    if (item.refInfo || item.repeals.length) resolveReferencesForItem(item, store);

    writeStore(store);
  });

  return item;
}

// Try to pull a sensible title and date out of an HTML regulator page.
function extractTitleAndDateFromHtml($) {
  $('script, style, nav, header, footer').remove();

  // RBI's classic detail-page template (NotificationUser.aspx and similar) wraps the
  // document's own title in a "p.head" — confirmed on a real notification page that the
  // page's <h1> is just a section-wide label ("Notifications", shared by every page in
  // that section), not the document's own title, which produced a useless generic title.
  // Fall back to h1/title/h2 for page templates that don't have "p.head" (SEBI/IBBI pages,
  // other RBI page types).
  const headEl = $('p.head').first();
  let title = headEl.length ? headEl.text().trim() : '';
  if (!title) {
    title = $('h1').first().text().trim() ||
            $('title').first().text().trim() ||
            $('h2').first().text().trim() || '';
  }
  title = title.replace(/\s+/g, ' ').trim().slice(0, 300);

  // Search for a date within the title's own container when found (its enclosing
  // table cell/div) rather than the whole page — the wider body text can contain
  // unrelated dates (widgets, tickers, "last refreshed on" notices) that matched
  // before the real document date, confirmed producing today's date instead of the
  // notification's actual date. Falls back to the whole body when there's no "p.head".
  const scopeText = (headEl.length ? headEl.closest('td, div').text() : $('body').text())
    .replace(/\s+/g, ' ');
  const dateMatch =
       scopeText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4}\b/i)
    || scopeText.match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\b/i)
    || scopeText.match(/\b\d{4}-\d{2}-\d{2}\b/)
    || scopeText.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  const date = dateMatch ? dateMatch[0] : '';
  return { title, date };
}

// Turns an axios/pdf-parse/network error into a specific, actionable message instead of
// a generic "something went wrong" — timeout, DNS failure, connection reset, HTTP status
// code, and parse failures are all distinguishable from each other and worth telling the
// user apart, since the fix differs for each (retry later vs. wrong URL vs. blocked host).
function describeFetchError(e) {
  if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message)) return 'the request timed out';
  if (e.code === 'ECONNRESET') return 'the connection was reset by the server (socket hang up) — the host may be blocking automated requests or is temporarily unavailable';
  if (e.code === 'ENOTFOUND') return `could not resolve that host (DNS lookup failed)`;
  if (e.code === 'ECONNREFUSED') return 'the connection was refused by the server';
  if (e.response?.status) return `the server responded with HTTP ${e.response.status}${e.response.status === 403 ? ' (forbidden — likely blocking automated requests)' : ''}`;
  return e.message || 'unknown error';
}

// POST /api/documents/url — fetch a URL pasted by the user (PDF or regulator webpage),
// Normalized-title duplicate check, shared by both manual-add paths (URL-paste and direct
// PDF upload). Confirmed necessary: the URL-match and reference-number duplicate checks
// both miss the case where the exact same document was added once as a PDF upload
// (url: '' — uploads have no source URL by nature) and once via URL-paste (a real url) —
// neither url nor refInfo overlaps between the two entries, but the title is byte-identical.
function normalizeDocTitle(title) {
  return (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function findDuplicateByTitle(title, source, store) {
  const key = normalizeDocTitle(title);
  if (!key) return null;
  return store.items.find(it => it.source === source && normalizeDocTitle(it.title) === key) || null;
}

// extract its text, summarise it, and store it exactly like a scraped document.
app.post('/api/documents/url', async (req, res) => {
  const url = (req.body && req.body.url || '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'Please provide a URL.' });

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return res.status(400).json({ ok: false, error: 'That does not look like a valid URL.' });
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    return res.status(400).json({ ok: false, error: 'Only http/https URLs are supported.' });
  }

  const source = detectSourceFromUrl(url);
  if (!source) {
    return res.status(400).json({ ok: false, error: 'URL must be from an RBI, SEBI, or IBBI website.' });
  }

  // Duplicate check #1 — same URL already in the store. Cheap, no fetch needed, catches
  // the common case (re-pasting the same link) outright. Confirmed real: without this,
  // three separate entries were created for the same document from repeated Add Document
  // calls, each with a distinct manual-<timestamp> id.
  const existingByUrl = readStore().items.find(it => it.url === url);
  if (existingByUrl) {
    return res.json({
      ok: true,
      duplicate: true,
      message: 'This document is already in the store — showing the existing entry instead of adding a duplicate.',
      item: {
        id: existingByUrl.id, title: existingByUrl.title, source: existingByUrl.source,
        date: formatDate(existingByUrl.date) || existingByUrl.date, supersession: existingByUrl.supersession
      }
    });
  }

  try {
    const isPdf = /\.pdf(\?|$)/i.test(url);
    if (isPdf && !pdfParse) {
      return res.status(500).json({ ok: false, error: 'PDF parsing is unavailable on the server.' });
    }

    let title = '', date = '', type = isPdf ? 'PDF' : 'Document';

    // Same text-extraction path used for every already-scraped document (see
    // fetchFullTextForItem(), which powers scrapeRBI()'s full-text/chunking pipeline for
    // the ~1000 documents already in the store) — a direct PDF URL is parsed as a PDF,
    // otherwise the page's own HTML body text is used as the document content. Deliberately
    // does NOT go hunting for a linked PDF on the page: confirmed on a real RBI
    // NotificationUser.aspx page that a naive "first PDF link on the page" selector grabs
    // an unrelated annexure/reference PDF belonging to a totally different, older document
    // — whose fetch then fails and previously took down the whole request, even though the
    // notification's own real content was sitting right there in the page's own HTML.
    const { fullText, linePreserved } = await fetchFullTextForItem({ url });

    if (isPdf) {
      title = (fullText.split(/(?<=[.?!])\s/)[0] || '').slice(0, 200) || decodeURIComponent(parsedUrl.pathname.split('/').pop() || 'PDF document');
    } else {
      const resp = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const $ = cheerio.load(resp.data);
      const meta = extractTitleAndDateFromHtml($);
      title = meta.title;
      date  = meta.date;
    }

    if (!title) title = 'Untitled document';
    if (!fullText) {
      return res.status(422).json({ ok: false, error: 'Could not extract any readable text from that page.' });
    }

    // Content-quality guard: if what's left after stripping the title out is still
    // suspiciously thin, this is very likely a page whose real content lives somewhere
    // fetchFullTextForItem() couldn't follow (confirmed happening: some pages embed their
    // actual content via a viewer/JS mechanism with no plain-HTML fallback, leaving only the
    // title repeated) — fail loudly rather than silently storing a near-empty, unsearchable
    // entry that looks legitimate in the UI but can never be retrieved for anything.
    if (!isPdf) {
      const withoutTitle = title ? fullText.split(title).join(' ') : fullText;
      const meaningfulWordCount = withoutTitle.trim().split(/\s+/).filter(Boolean).length;
      if (meaningfulWordCount < 30) {
        return res.status(422).json({
          ok: false,
          error: `Only found ${meaningfulWordCount} words of real content on that page beyond the title — it looks like this page's actual content isn't in the plain HTML (e.g. rendered via JavaScript or an embedded viewer this fetch couldn't follow). Try finding a direct link to the PDF, or download the document yourself and use "Upload PDF from computer" instead.`
        });
      }
    }

    // Duplicate check #2 — same reference number under a different URL (e.g. this exact
    // document already exists as a scraped item with its own listing-page URL). Only
    // possible after parsing, since it needs the newly-extracted text to derive a
    // reference number to compare.
    const previewRefInfo = parseOwnReference({ source, title, ref: '' }, linePreserved);
    if (previewRefInfo?.allRefs?.length) {
      const previewKeys = new Set(previewRefInfo.allRefs.map(normalizeRef));
      const existingByRef = readStore().items.find(it =>
        it.refInfo?.allRefs?.some(r => previewKeys.has(normalizeRef(r)))
      );
      if (existingByRef) {
        return res.json({
          ok: true,
          duplicate: true,
          message: 'This document (same reference number) is already in the store under a different URL — showing the existing entry instead of adding a duplicate.',
          item: {
            id: existingByRef.id, title: existingByRef.title, source: existingByRef.source,
            date: formatDate(existingByRef.date) || existingByRef.date, supersession: existingByRef.supersession
          }
        });
      }
    }

    // Duplicate check #3 — exact title match, same source. Catches the case checks #1/#2
    // miss entirely: the same document already in the store via a PDF upload (url: '',
    // refInfo often null too for SEBI's less-standardised numbering) — url and reference
    // number can't overlap with that kind of entry no matter what, but the title will.
    const existingByTitle = findDuplicateByTitle(title, source, readStore());
    if (existingByTitle) {
      return res.json({
        ok: true,
        duplicate: true,
        message: 'A document with this exact title is already in the store (likely added a different way, e.g. PDF upload) — showing the existing entry instead of adding a duplicate.',
        item: {
          id: existingByTitle.id, title: existingByTitle.title, source: existingByTitle.source,
          date: formatDate(existingByTitle.date) || existingByTitle.date, supersession: existingByTitle.supersession
        }
      });
    }

    const item = await ingestDocument({ source, type, title, ref: '', date, url, fullText, linePreserved });
    res.json({ ok: true, item: { id: item.id, title: item.title, source: item.source, date: formatDate(item.date) || item.date, supersession: item.supersession } });
  } catch (e) {
    const reason = describeFetchError(e);
    console.error(`Document URL ingest error [${url}]: ${reason}`, e.stack || e);
    if (e.message === 'NOT_A_PDF') {
      return res.status(422).json({
        ok: false,
        error: "The linked PDF couldn't be downloaded directly — the file host returned a webpage instead of the file (this happens on some regulator PDF hosts that block direct/automated downloads). Try downloading the PDF yourself and using \"Upload PDF from computer\" instead."
      });
    }
    res.status(500).json({ ok: false, error: `Failed to fetch or process that URL: ${reason}` });
  }
});

// POST /api/documents/upload — user uploads a PDF directly + supplies title/source/date
app.post('/api/documents/upload', (req, res, next) => {
  if (!docUpload) return res.status(500).json({ ok: false, error: 'File upload is unavailable on the server.' });
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed.' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Please choose a PDF file to upload.' });
    if (!pdfParse) return res.status(500).json({ ok: false, error: 'PDF parsing is unavailable on the server.' });

    const { title, source, date } = req.body || {};
    const validSources = ['RBI', 'SEBI', 'IBBI'];
    if (!title || !title.trim())   return res.status(400).json({ ok: false, error: 'Please provide a document title.' });
    if (!validSources.includes(source)) return res.status(400).json({ ok: false, error: 'Please select a source: RBI, SEBI, or IBBI.' });
    if (!date || !date.trim())     return res.status(400).json({ ok: false, error: 'Please provide a document date.' });

    const parsed        = await pdfParse(req.file.buffer);
    const linePreserved = collapseHorizontalWhitespace(parsed.text);
    const fullText       = linePreserved.replace(/\s+/g, ' ').trim();
    if (!fullText) return res.status(422).json({ ok: false, error: 'Could not extract any readable text from that PDF.' });

    // Same exact-title duplicate check as /api/documents/url — catches the case where this
    // exact document was already added via URL-paste (which has a real url/possibly refInfo
    // that this upload, having neither, could never match against).
    const existingByTitle = findDuplicateByTitle(title.trim(), source, readStore());
    if (existingByTitle) {
      return res.json({
        ok: true,
        duplicate: true,
        message: 'A document with this exact title is already in the store (likely added a different way, e.g. URL paste) — showing the existing entry instead of adding a duplicate.',
        item: {
          id: existingByTitle.id, title: existingByTitle.title, source: existingByTitle.source,
          date: formatDate(existingByTitle.date) || existingByTitle.date, supersession: existingByTitle.supersession
        }
      });
    }

    const item = await ingestDocument({
      source, type: 'PDF', title: title.trim(), ref: '', date: date.trim(), url: '', fullText, linePreserved
    });
    res.json({ ok: true, item: { id: item.id, title: item.title, source: item.source, date: formatDate(item.date) || item.date, supersession: item.supersession } });
  } catch (e) {
    console.error('Document upload ingest error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to process that PDF. Please ensure it is a valid, text-based PDF file.' });
  }
});

// ─── Document Validity Checker ────────────────────────────────────────────────

// A document that's never been checked has no `supersession` field at all — this fills in
// the "not yet verified" default so API responses always have a consistent shape for the
// frontend to render. Deliberately NOT 'active': Stage 1 finding nothing only rules out one
// detection path, it doesn't establish the document is still in force — 'active' is reserved
// for when Stage 2 has also run and found nothing (see runStage2Check above).
function formatSupersession(item) {
  return item.supersession || { status: 'not_yet_verified', supersededBy: null, stage2Attempted: false, checkedAt: null };
}

// GET /api/validity/:id — current status for a stored document (Stage 1 result,
// already computed automatically at ingestion/backfill; Stage 2 only if it's been
// explicitly run before via the endpoint below).
//
// If Stage 1 hasn't reached this document yet, it's run on demand right here before
// answering — the background reference-backfill queue processes newest-first, so an
// older scraped document (e.g. a Master Direction from months ago) can sit with
// refInfo/repeals still `undefined` for a long time. Without this, "Check Validity"
// on such a document would report "Active" even when a later document already in the
// store explicitly repeals it — not because the matching logic is one-directional
// (resolveReferencesForItem() below already checks both directions), but because the
// older document's own reference had simply never been extracted yet to match against.
app.get('/api/validity/:id', async (req, res) => {
  const store = readStore();
  let item = store.items.find(it => it.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Document not found' });

  if (item.repeals === undefined && item.url) {
    try {
      const { linePreserved } = await fetchFullTextForItem(item);
      const refInfo = parseOwnReference(item, linePreserved);
      const repeals = extractRepealReferences(linePreserved, item.source, refInfo?.raw);

      await withStoreLock(async () => {
        const freshStore = readStore();
        const freshItem = freshStore.items.find(it => it.id === req.params.id);
        if (freshItem) {
          freshItem.refInfo = refInfo;
          freshItem.repeals = repeals;
          if (freshItem.refInfo || freshItem.repeals.length) resolveReferencesForItem(freshItem, freshStore);
          writeStore(freshStore);
          item = freshItem; // reflect the just-computed state below
        }
      });
    } catch (e) {
      console.error(`On-demand reference check error [${item.id.slice(0, 30)}]:`, e.message);
      // Fall through and answer with whatever we have — a fetch failure here
      // shouldn't fail the whole validity check.
    }
  }

  res.json({
    ok: true,
    id: item.id, title: item.title, source: item.source, date: formatDate(item.date) || item.date, url: item.url,
    refInfo: item.refInfo || null,
    repeals: item.repeals || [],
    supersession: formatSupersession(item)
  });
});

// POST /api/validity/:id/check-content — runs Stage 2 (semantic, on-demand only) for
// one document. Returns the cached result instead of re-running unless {force:true}.
app.post('/api/validity/:id/check-content', async (req, res) => {
  const store = readStore();
  const item = store.items.find(it => it.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Document not found' });

  const force = !!(req.body && req.body.force);
  if (item.supersession?.stage2Attempted && !force) {
    return res.json({ ok: true, cached: true, supersession: item.supersession });
  }
  if (!ANTHROPIC_API_KEY || !Anthropic) {
    return res.status(503).json({ ok: false, error: 'Anthropic API key not configured — set ANTHROPIC_API_KEY and restart' });
  }

  try {
    // Deliberately outside the store lock — this can take 10-20s+ (multiple
    // throttled Claude calls). Holding the lock that whole time would block
    // uploads/scrapes/backfill for no benefit, since only this item's own
    // supersession field needs to be persisted, not a snapshot of the whole store.
    const supersession = await runStage2Check(item, store);

    await withStoreLock(async () => {
      const freshStore = readStore();
      const freshItem = freshStore.items.find(it => it.id === req.params.id);
      if (freshItem) {
        freshItem.supersession = supersession;
        writeStore(freshStore);
      }
    });

    res.json({ ok: true, cached: false, supersession });
  } catch (e) {
    console.error('Stage 2 check error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/validity/:id/reprocess-stage1 — force Stage 1 (regex reference extraction)
// to re-run for one document, overwriting refInfo/repeals. Needed for two cases: (a) a
// URL-backed document whose extraction should be redone (e.g. after a regex fix), and
// (b) a document with no URL (a direct PDF upload) — for those, there's no live source
// to re-fetch, so this reconstructs the original text from its already-stored chunks
// (chunking always runs at ingestion regardless of AI key, so this is available for
// every ingested document). Does NOT re-run automatically anywhere — on-demand only,
// since re-extracting is only useful right after an extraction-logic change.
app.post('/api/validity/:id/reprocess-stage1', async (req, res) => {
  const snapshot = readStore();
  const item = snapshot.items.find(it => it.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Document not found' });

  try {
    let linePreserved;
    if (item.url) {
      ({ linePreserved } = await fetchFullTextForItem(item));
    } else {
      const chunks = snapshot.chunks
        .filter(c => c.parentId === item.id)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (!chunks.length) return res.status(422).json({ ok: false, error: 'No URL and no stored chunks to reprocess from.' });
      linePreserved = chunks.map(c => c.text).join(' ');
    }

    const refInfo = parseOwnReference(item, linePreserved);
    const repeals = extractRepealReferences(linePreserved, item.source, refInfo?.raw);

    await withStoreLock(async () => {
      const store = readStore();
      const freshItem = store.items.find(it => it.id === req.params.id);
      if (freshItem) {
        freshItem.refInfo = refInfo;
        freshItem.repeals = repeals;
        if (freshItem.refInfo || freshItem.repeals.length) resolveReferencesForItem(freshItem, store);
        writeStore(store);
      }
    });

    const refreshed = readStore().items.find(it => it.id === req.params.id);
    res.json({ ok: true, refInfo: refreshed.refInfo || null, repeals: refreshed.repeals || [], supersession: formatSupersession(refreshed) });
  } catch (e) {
    console.error('Reprocess Stage 1 error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/validity/upload — upload a PDF to check its validity. Reuses the same
// ingestion path as /api/documents/upload (permanently stored, per confirmed design)
// so it's searchable/chunked like any other document; Stage 1 already runs inline
// inside ingestDocument().
app.post('/api/validity/upload', (req, res, next) => {
  if (!docUpload) return res.status(500).json({ ok: false, error: 'File upload is unavailable on the server.' });
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed.' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Please choose a PDF file to upload.' });
    if (!pdfParse) return res.status(500).json({ ok: false, error: 'PDF parsing is unavailable on the server.' });

    const { title, source, date } = req.body || {};
    const validSources = ['RBI', 'SEBI', 'IBBI'];
    if (!title || !title.trim())        return res.status(400).json({ ok: false, error: 'Please provide a document title.' });
    if (!validSources.includes(source)) return res.status(400).json({ ok: false, error: 'Please select a source: RBI, SEBI, or IBBI.' });
    if (!date || !date.trim())          return res.status(400).json({ ok: false, error: 'Please provide a document date.' });

    const parsed         = await pdfParse(req.file.buffer);
    const linePreserved  = collapseHorizontalWhitespace(parsed.text);
    const fullText        = linePreserved.replace(/\s+/g, ' ').trim();
    if (!fullText) return res.status(422).json({ ok: false, error: 'Could not extract any readable text from that PDF.' });

    const item = await ingestDocument({
      source, type: 'PDF', title: title.trim(), ref: '', date: date.trim(), url: '', fullText, linePreserved
    });
    res.json({
      ok: true,
      id: item.id, title: item.title, source: item.source, date: formatDate(item.date) || item.date,
      refInfo: item.refInfo || null,
      repeals: item.repeals || [],
      supersession: formatSupersession(item)
    });
  } catch (e) {
    console.error('Validity upload ingest error:', e.message);
    res.status(500).json({ ok: false, error: 'Failed to process that PDF. Please ensure it is a valid, text-based PDF file.' });
  }
});

// ─── Compliance Checker × Validity Checker cross-link ─────────────────────────
// The compliance check works on ad-hoc uploaded PDFs, not on items already sitting
// in the store — so before running the compliance comparison, do a best-effort,
// read-only pass to see whether the uploaded regulation is a document the platform
// already knows to be superseded. Reuses the exact Stage 1 parsing function
// (parseOwnReference) and the same normalizeRef-based matching approach as
// resolveReferencesForItem's reverse branch — just without mutating the store,
// since this upload isn't itself being persisted as a store item.

// parseOwnReference() needs a `source` to pick the right regex set, but the
// compliance uploader doesn't collect one — so try all three and merge whatever
// each finds. Cross-source false positives are unlikely given how source-specific
// these patterns are (RBI/SEBI/IBBI prefixes are baked into each pattern).
function guessOwnReference(linePreserved) {
  let combined = null;
  for (const src of ['RBI', 'SEBI', 'IBBI']) {
    const r = parseOwnReference({ source: src, title: '', ref: '' }, linePreserved);
    if (!r) continue;
    if (!combined) combined = { raw: r.raw, allRefs: [], year: r.year, number: r.number };
    for (const ref of r.allRefs) if (!combined.allRefs.includes(ref)) combined.allRefs.push(ref);
  }
  return combined;
}

// Stage 1, reverse direction only, read-only: does any existing stored document's
// repeals[] already cite this reference number? Same normalizeRef comparison as
// resolveReferencesForItem (server.js ~line 394), just without writing anything back.
function checkExplicitSupersessionReverse(refInfo, store) {
  if (!refInfo?.allRefs?.length) return null;
  const myKeys = new Set(refInfo.allRefs.map(normalizeRef));
  for (const other of store.items) {
    if (!Array.isArray(other.repeals)) continue;
    for (const entry of other.repeals) {
      if (myKeys.has(normalizeRef(entry.rawRef))) {
        return { docId: other.id, title: other.title, date: formatDate(other.date) || other.date, url: other.url, source: other.source, type: other.type, mechanism: 'explicit_reference' };
      }
    }
  }
  return null;
}

// What fraction of a candidate title's significant words appear in the regulation's
// own extracted text (letterhead window only) — used to find "this uploaded PDF is
// actually document X already in the store" when parseOwnReference finds no reference
// number at all (common for older/non-standard-format circulars). Asymmetric on
// purpose: a short title fully contained in a long body should score ~1.0, which a
// plain Jaccard/titleSimilarity comparison (built for title-vs-title) would not give.
function titleContainmentScore(bodyText, title) {
  const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  const titleWords = words(title || '');
  if (!titleWords.size) return 0;
  const bodyWords = words((bodyText || '').slice(0, 3000));
  let hits = 0;
  for (const w of titleWords) if (bodyWords.has(w)) hits++;
  return hits / titleWords.size;
}

// Best-effort identification of "this uploaded regulation is already item X in the
// store" — tries reference-number overlap first (precise), falls back to title
// containment (for documents whose reference number Stage 1 couldn't parse).
function findMatchingStoreItem(refInfo, linePreserved, store) {
  if (refInfo?.allRefs?.length) {
    const myKeys = new Set(refInfo.allRefs.map(normalizeRef));
    const byRef = store.items.find(it => it.refInfo?.allRefs?.some(r => myKeys.has(normalizeRef(r))));
    if (byRef) return byRef;
  }
  let best = null, bestScore = 0;
  for (const it of store.items) {
    const score = titleContainmentScore(linePreserved, it.title);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 0.7 ? best : null;
}

// Orchestrates the cross-link: Stage 1 (always, cheap) then Stage 2 only if a
// matching store item already has a cached result — never triggers a fresh Stage 2
// call from here, since that's an expensive on-demand Claude call reserved for the
// "Check Validity" tab itself.
function checkRegulationSupersession(regFile, linePreserved, store) {
  const refInfo = guessOwnReference(linePreserved);

  const explicit = checkExplicitSupersessionReverse(refInfo, store);
  const matchedItem = findMatchingStoreItem(refInfo, linePreserved, store);
  const regulationTitle = matchedItem?.title || regFile.originalname.replace(/\.pdf$/i, '');

  if (explicit) return { regulationTitle, supersededBy: explicit };

  if (matchedItem?.supersession?.stage2Attempted &&
      ['superseded', 'possibly_superseded'].includes(matchedItem.supersession.status) &&
      matchedItem.supersession.supersededBy) {
    return { regulationTitle, supersededBy: matchedItem.supersession.supersededBy };
  }

  return null;
}

// POST /api/compliance/check — "Policy Compliance Checker": takes two PDFs
// (a regulation + an internal policy), extracts their text, and asks Claude to
// compare them into three short sections: Compliant / Non-Compliant / Missing.
app.post('/api/compliance/check', (req, res, next) => {
  if (!docUpload) return res.status(500).json({ ok: false, error: 'File upload is unavailable on the server.' });
  docUpload.fields([{ name: 'regulation', maxCount: 1 }, { name: 'policy', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Upload failed.' });
    next();
  });
}, async (req, res) => {
  try {
    if (!pdfParse) return res.status(500).json({ ok: false, error: 'PDF parsing is unavailable on the server.' });
    if (!ANTHROPIC_API_KEY || !Anthropic) {
      return res.status(503).json({ ok: false, error: 'Anthropic API key not configured — set ANTHROPIC_API_KEY and restart' });
    }

    const regFile    = req.files?.regulation?.[0];
    const policyFile = req.files?.policy?.[0];
    if (!regFile)    return res.status(400).json({ ok: false, error: 'Please upload the regulation PDF.' });
    if (!policyFile) return res.status(400).json({ ok: false, error: 'Please upload the policy PDF.' });

    const [regParsed, policyParsed] = await Promise.all([
      pdfParse(regFile.buffer),
      pdfParse(policyFile.buffer)
    ]);
    const regText    = regParsed.text.replace(/\s+/g, ' ').trim();
    const policyText = policyParsed.text.replace(/\s+/g, ' ').trim();
    if (!regText)    return res.status(422).json({ ok: false, error: 'Could not extract any readable text from the regulation PDF.' });
    if (!policyText) return res.status(422).json({ ok: false, error: 'Could not extract any readable text from the policy PDF.' });

    // Task 1: silent cross-link against the Validity Checker — Stage 1 always,
    // Stage 2 only if a matching store item already has a cached result.
    const regLinePreserved   = collapseHorizontalWhitespace(regParsed.text);
    const supersessionResult = checkRegulationSupersession(regFile, regLinePreserved, readStore());

    // Keep both documents within a sane combined budget for the model.
    const MAX_WORDS_EACH = 6000;
    const truncate = (t) => { const w = t.split(/\s+/); return w.length > MAX_WORDS_EACH ? w.slice(0, MAX_WORDS_EACH).join(' ') : t; };

    // Task 2 + Task 4 share this one prompt/schema change: Non-Compliant and Missing
    // findings come back as structured objects (severity + rationale + suggested
    // remediation text), not flat bullet paragraphs — Compliant stays a plain list
    // since there's no defect there to triage or remediate.
    const systemPrompt =
      'You are a regulatory compliance analyst. Compare the two documents provided. ' +
      'Document 1 is a regulation. Document 2 is an internal policy. Identify: ' +
      'COMPLIANT — specific things the policy covers correctly (plain statements, no severity needed). ' +
      'NON-COMPLIANT — specific ways the policy conflicts with or misstates the regulation. ' +
      'MISSING — specific regulatory requirements the policy does not address at all. ' +
      'For every Non-Compliant and Missing finding, also provide: ' +
      'severity — exactly "Critical", "High", or "Medium" (Critical = material legal/regulatory violation or ' +
      'enforcement risk; High = significant compliance gap; Medium = minor or procedural gap); ' +
      'rationale — one short clause explaining why that severity was assigned; ' +
      'remediation — suggested fix text: for a Non-Compliant finding, proposed replacement clause wording for the ' +
      'existing policy section it conflicts with; for a Missing finding, proposed new clause wording to add. ' +
      'Return ONLY valid JSON, no markdown, in exactly this shape: ' +
      '{"compliant":["...","..."],' +
      '"nonCompliant":[{"finding":"...","severity":"Critical|High|Medium","rationale":"...","remediation":"..."}],' +
      '"missing":[{"finding":"...","severity":"Critical|High|Medium","rationale":"...","remediation":"..."}]} ' +
      '— each array 0-8 items, concise and specific.';

    const userContent =
      `Document 1 (Regulation — "${regFile.originalname}"):\n${truncate(regText)}\n\n---\n\n` +
      `Document 2 (Internal Policy — "${policyFile.originalname}"):\n${truncate(policyText)}\n\n---\n\n` +
      'Compare these two documents per the schema described. Be concise and specific, and give every ' +
      'Non-Compliant/Missing finding a severity, rationale, and suggested remediation.';

    const rawReply = await callClaude(systemPrompt, [{ role: 'user', content: userContent }], { maxTokens: 2200, temperature: 0.1 });

    const raw = rawReply.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let data = null;
    const matched = raw.match(/\{[\s\S]*\}/);
    if (matched) { try { data = JSON.parse(matched[0]); } catch { /* repair below */ } }
    if (!data) {
      const repaired = repairTruncatedJson(raw);
      if (repaired) { try { data = JSON.parse(repaired); } catch { /* still no good */ } }
    }
    if (!data) {
      console.error('Raw Claude output (compliance check, unparseable JSON):', raw.slice(0, 1000));
      throw new Error('No JSON object in Claude response');
    }

    const VALID_SEVERITIES = ['Critical', 'High', 'Medium'];
    const sanitizeFindings = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 8).map(f => ({
      finding:     String(f?.finding || '').trim().slice(0, 500),
      severity:    VALID_SEVERITIES.includes(f?.severity) ? f.severity : 'Medium',
      rationale:   String(f?.rationale || '').trim().slice(0, 300),
      remediation: String(f?.remediation || '').trim().slice(0, 1000)
    })).filter(f => f.finding);
    const sanitizeCompliant = (arr) => (Array.isArray(arr) ? arr : [])
      .slice(0, 8).map(s => String(s || '').trim().slice(0, 500)).filter(Boolean);

    res.json({
      ok:           true,
      regulationTitle: supersessionResult?.regulationTitle || regFile.originalname.replace(/\.pdf$/i, ''),
      policyTitle:     policyFile.originalname.replace(/\.pdf$/i, ''),
      compliant:    sanitizeCompliant(data.compliant),
      nonCompliant: sanitizeFindings(data.nonCompliant),
      missing:      sanitizeFindings(data.missing),
      supersessionWarning: supersessionResult
    });
  } catch (e) {
    console.error('Compliance check error:', describeClaudeError(e));
    res.status(500).json({ ok: false, error: 'Failed to compare those documents. Please ensure both are valid, text-based PDFs.' });
  }
});

const SEVERITY_PDF_COLOR = { Critical: '#dc2626', High: '#ea580c', Medium: '#ca8a04' };
const SEVERITY_ORDER     = { Critical: 0, High: 1, Medium: 2 };

// Renders one Non-Compliant/Missing section (sorted Critical-first, same ordering as the
// frontend) into the PDF document, including severity tag, rationale, and remediation.
function renderFindingsSection(doc, heading, headingColor, findings) {
  doc.moveDown(1);
  doc.fontSize(13).fillColor(headingColor).font('Helvetica-Bold').text(heading);
  doc.moveDown(0.4);

  if (!findings || !findings.length) {
    doc.fontSize(10).fillColor('#888').font('Helvetica').text('None identified.');
    return;
  }

  const sorted = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  for (const f of sorted) {
    const color = SEVERITY_PDF_COLOR[f.severity] || SEVERITY_PDF_COLOR.Medium;
    doc.fontSize(9).fillColor(color).font('Helvetica-Bold').text(`[${(f.severity || 'MEDIUM').toUpperCase()}]  `, { continued: true });
    doc.fontSize(10.5).fillColor('#111').font('Helvetica').text(f.finding || '');
    if (f.rationale) {
      doc.fontSize(9).fillColor('#666').font('Helvetica-Oblique').text(f.rationale, { indent: 12 });
    }
    if (f.remediation) {
      doc.fontSize(9).fillColor('#444').font('Helvetica-Bold').text('Suggested fix: ', { indent: 12, continued: true });
      doc.font('Helvetica').fillColor('#333').text(f.remediation);
    }
    doc.moveDown(0.6);
  }
}

// POST /api/compliance/report — Task: exportable PDF report. Takes the already-computed
// result from /api/compliance/check (the frontend holds it after rendering) and formats it
// into a downloadable PDF — no re-analysis, no re-upload of the source PDFs. Uses pdfkit,
// the only PDF-*writing* library in the project (pdf-parse only reads).
app.post('/api/compliance/report', (req, res) => {
  if (!PDFDocument) return res.status(500).json({ ok: false, error: 'PDF generation is unavailable on the server.' });

  const { regulationTitle, policyTitle, compliant, nonCompliant, missing, supersessionWarning } = req.body || {};

  try {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="compliance-report.pdf"');
    doc.pipe(res);

    doc.fontSize(18).fillColor('#111').font('Helvetica-Bold').text('Compliance Check Report');
    doc.fontSize(9).fillColor('#888').font('Helvetica').text(`Generated ${new Date().toLocaleString('en-IN')}`);
    doc.moveDown(1);

    doc.fontSize(10.5).fillColor('#333').font('Helvetica-Bold').text('Regulation: ', { continued: true });
    doc.font('Helvetica').fillColor('#111').text(regulationTitle || '—');
    doc.font('Helvetica-Bold').fillColor('#333').text('Policy document: ', { continued: true });
    doc.font('Helvetica').fillColor('#111').text(policyTitle || '—');

    if (supersessionWarning) {
      doc.moveDown(0.8);
      const sb = supersessionWarning.supersededBy || {};
      const y0 = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#991b1b')
        .text('⚠ Supersession warning', 50, y0, { width: 495 });
      doc.font('Helvetica').fontSize(9.5).fillColor('#7f1d1d').text(
        `This check was run against "${regulationTitle}", but that regulation has since been superseded by ` +
        `"${sb.title || 'a later document'}"${sb.date ? ` (${sb.date})` : ''}. Results below may not reflect current requirements.`,
        { width: 495 }
      );
      doc.rect(45, y0 - 6, 505, doc.y - y0 + 12).stroke('#fecaca');
    }

    doc.moveDown(1.2);
    doc.fontSize(13).fillColor('#16a34a').font('Helvetica-Bold').text('Compliant');
    doc.moveDown(0.4);
    if (compliant && compliant.length) {
      doc.fontSize(10.5).fillColor('#111').font('Helvetica');
      for (const s of compliant) doc.text(`•  ${s}`);
    } else {
      doc.fontSize(10).fillColor('#888').font('Helvetica').text('None identified.');
    }

    renderFindingsSection(doc, 'Non-Compliant', '#dc2626', nonCompliant);
    renderFindingsSection(doc, 'Missing', '#d97706', missing);

    doc.end();
  } catch (e) {
    console.error('Compliance PDF report error:', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Failed to generate the PDF report.' });
  }
});

// GET /api/documents/uploaded — list of manually-added documents (via URL or file
// upload), for the chat's "Document Q&A" mode dropdown. Returns lightweight
// metadata only (no chunk text) so the list loads instantly.
app.get('/api/documents/uploaded', (req, res) => {
  const store = readStore();
  const parentCounts = {};
  for (const c of (store.chunks || [])) parentCounts[c.parentId] = (parentCounts[c.parentId] || 0) + 1;

  const uploaded = store.items
    .filter(it => it.addedManually || (it.id || '').startsWith('manual-'))
    .map(it => ({
      id:          it.id,
      title:       it.title,
      source:      it.source,
      type:        it.type,
      date:        formatDate(it.date) || it.date || null,
      totalChunks: parentCounts[it.id] || 0
    }));

  res.json({ ok: true, items: uploaded });
});

// POST /api/ask/document — "Document Q&A" mode: answers a question using ONLY
// one specific manually-added document. Loads every chunk belonging to that
// document (in original order), reassembles the full text, and sends it to
// Claude in its entirety — bypassing the general corpus-wide search/retrieval
// entirely, so the answer is grounded strictly in that single document.
app.post('/api/ask/document', async (req, res) => {
  const { documentId, question, sessionId } = req.body || {};
  if (!documentId || !String(documentId).trim()) {
    return res.status(400).json({ ok: false, error: 'No document selected.' });
  }
  if (!question || !question.trim()) {
    return res.status(400).json({ ok: false, error: 'No question provided' });
  }
  if (!ANTHROPIC_API_KEY || !Anthropic) {
    return res.status(503).json({ ok: false, error: 'Anthropic API key not configured — set ANTHROPIC_API_KEY and restart' });
  }

  const store = readStore();
  const item = store.items.find(it => it.id === documentId);
  if (!item) return res.status(404).json({ ok: false, error: 'That document was not found in the database.' });
  if (!(item.addedManually || (item.id || '').startsWith('manual-'))) {
    return res.status(400).json({ ok: false, error: 'Document Q&A mode is only available for manually-added/uploaded documents.' });
  }

  // Pull every chunk for this document, restored to its original reading order.
  const chunks = (store.chunks || [])
    .filter(c => c.parentId === documentId)
    .sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));

  if (!chunks.length) {
    return res.status(422).json({ ok: false, error: 'This document has not been chunked yet — try again after the chunking pipeline finishes processing it.' });
  }

  // Reassemble the full document text from its chunks, in order. Consecutive
  // chunks overlap by design (CHUNK_OVERLAP words), so naive concatenation would
  // duplicate that overlapping text — trim each chunk's leading words that match
  // the tail of the previous chunk to reconstruct a clean, deduplicated full text.
  function dedupeOverlap(prevText, nextText, maxOverlapWords = CHUNK_OVERLAP + 20) {
    const prevWords = prevText.trim().split(/\s+/);
    const nextWords = nextText.trim().split(/\s+/);
    const maxCheck = Math.min(maxOverlapWords, prevWords.length, nextWords.length);
    for (let n = maxCheck; n > 0; n--) {
      const prevTail = prevWords.slice(-n).join(' ');
      const nextHead = nextWords.slice(0, n).join(' ');
      if (prevTail === nextHead) return nextWords.slice(n).join(' ');
    }
    return nextText;
  }
  let fullText = chunks[0].text;
  for (let i = 1; i < chunks.length; i++) {
    fullText += ' ' + dedupeOverlap(chunks[i - 1].text, chunks[i].text);
  }

  // ── Token budget: Claude's context window is large but not unlimited. Send the
  // complete document when it fits; otherwise progressively trim from the end
  // (keeping the beginning, where titles/definitions/scope usually live) and warn.
  const FIXED_OVERHEAD_TOKENS = 1500;
  const TOKEN_BUDGET = 150000;
  let docText = fullText;
  let truncated = false;
  if (FIXED_OVERHEAD_TOKENS + estimateTokens(docText) > TOKEN_BUDGET) {
    truncated = true;
    const words = docText.trim().split(/\s+/);
    // ~0.75 tokens/word heuristic (matches estimateTokens' rough ratio) — trim to budget
    const targetWords = Math.max(2000, Math.floor((TOKEN_BUDGET - FIXED_OVERHEAD_TOKENS) / 1.4));
    docText = words.slice(0, targetWords).join(' ');
  }

  const session = getOrCreateSession(sessionId);
  const history = session ? session.history : [];

  const systemPrompt =
    'You are a regulatory document analyst. You have been given the COMPLETE text of ONE specific document ' +
    `(${item.source} ${item.type}: "${item.title}"). ` +
    'Answer the user\'s question using ONLY this document — do not draw on any other regulation, document, or outside knowledge. ' +
    'If the answer is present anywhere in the document, quote or closely paraphrase the relevant part precisely. ' +
    'If the document genuinely does not address the question, say so plainly — do not guess or fabricate. ' +
    'Give a precise, well-organised answer (use short paragraphs or bullet points as appropriate, up to ~6 sentences/points). ' +
    'Return ONLY valid JSON, no markdown: {"answer":"..."}';

  const userContent =
    `Document: [${item.source} ${item.type}${item.date ? ' · ' + formatDate(item.date) : ''}${item.ref ? ' · ' + item.ref : ''}] ${item.title}\n\n` +
    `Full document text:\n${docText}\n\n---\n\nQuestion: ${question}`;

  const priorMessages = history.slice(-12).map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 900)
  }));

  try {
    const rawReply = await callClaude(
      systemPrompt,
      [...priorMessages, { role: 'user', content: userContent }],
      { maxTokens: 900, temperature: 0.1 }
    );

    const raw = rawReply.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let data = null;
    const matched = raw.match(/\{[\s\S]*\}/);
    if (matched) { try { data = JSON.parse(matched[0]); } catch { /* repair below */ } }
    if (!data) {
      const repaired = repairTruncatedJson(raw);
      if (repaired) { try { data = JSON.parse(repaired); } catch { /* still no good */ } }
    }
    if (!data) {
      console.error('Raw Claude output (Document Q&A, unparseable JSON):', raw.slice(0, 1000));
      // Same fallback as /api/ask — Claude occasionally replies in plain text for
      // casual input instead of the requested JSON; use it directly rather than
      // failing the request outright.
      data = { answer: raw.trim().slice(0, 1800) || "I'm not sure how to respond to that." };
    }

    let answer = String(data.answer || '').trim().slice(0, 1800);
    if (truncated) {
      answer += "\n\n_Note: this document is very large — the answer is based on its opening portion (which contains the title, scope, and definitions); later sections may not have been included._";
    }

    if (session) {
      session.history.push({ role: 'user',      content: question });
      session.history.push({ role: 'assistant', content: answer });
      if (session.history.length > SESSION_MAX_TURNS) session.history = session.history.slice(-SESSION_MAX_TURNS);
      session.lastCited = [item];
      session.updatedAt = Date.now();
    }

    console.log(`Ask [document Q&A]: "${question.slice(0,55)}" on "${item.title.slice(0,50)}" → ${chunks.length} chunks, ${docText.split(/\s+/).length} words sent`);

    res.json({
      ok:           true,
      sessionId:    sessionId || null,
      queryType:    'narrative',
      answer,
      sources: [{
        title:  item.title,
        source: item.source,
        type:   item.type,
        date:   formatDate(item.date) || item.date || null,
        url:    item.url,
        ref:    item.ref || null
      }],
      totalMatched: 1,
      sentToGroq:   1,
      documentMode: true,
      contextLimited: truncated
    });
  } catch (e) {
    console.error('Ask (document Q&A) error:', describeClaudeError(e));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Chat session store (in-memory, server-side conversation memory) ─────────
// sessionId -> { history: [{role,content}], lastCited: [item,...], updatedAt }
const chatSessions = new Map();
const SESSION_TTL_MS   = 2 * 60 * 60 * 1000; // 2 hours idle → drop
const SESSION_MAX_TURNS = 40;                 // cap stored messages per session

function getOrCreateSession(sessionId) {
  if (!sessionId) return null;
  let s = chatSessions.get(sessionId);
  if (!s) {
    s = { history: [], lastCited: [], updatedAt: Date.now() };
    chatSessions.set(sessionId, s);
  }
  return s;
}

function cleanupChatSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of chatSessions) {
    if (s.updatedAt < cutoff) chatSessions.delete(id);
  }
}
setInterval(cleanupChatSessions, 30 * 60 * 1000); // sweep every 30 min

// Detect references to "the previous one / that circular / the second document"
// so follow-ups can be scoped to exactly the documents already discussed.
const REFERENCE_RE = /\b(that|this|those|these|previous|prior|earlier|preceding|same|aforementioned|above|mentioned|it|first|second|third|fourth|fifth|last|latter|former)\b.*\b(one|circular|document|notification|direction|rule|item|that|this|it)\b|\b(tell me more|more (details|info|information)|elaborate|expand on|go deeper|continue|more about (that|this|it))\b/i;

// ─── Intelligence Search helpers ─────────────────────────────────────────────

// Stop-words filtered out before token scoring
const ASK_STOP = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','shall','can','need','dare','ought',
  'i','me','my','we','our','you','your','it','its','this','that','those','these',
  'and','or','but','in','on','at','to','for','of','with','by','from','about',
  'as','into','through','during','before','after','between','among',
  'what','which','who','whom','when','where','why','how',
  'all','any','both','each','few','more','most','other','some','such',
  'no','not','only','same','so','than','too','very','just','now','also',
  'please','tell','give','show','find','get','make','put','take','come','go',
  'changed','change','update','updates','recent','recently','latest','new',
  'rules','rule','regulation','regulations','guideline','guidelines',
  'circular','circulars','notification','notifications','press','release',
  'document','documents','about','regarding','related','under','per'
]);

// Recency-sensitive query detection — simple keyword/pattern check, not fancy on purpose
// (see the consortium-lending case: "what's the latest guideline on X" answered with a
// 2008 circular that had since been superseded, because nothing checked whether a
// later-dated document was also in the retrieved set). Any question matching this should
// get explicit date-ordering + supersession context passed into synthesis, not just rely
// on the model noticing dates buried in the passage text.
const RECENCY_QUERY_RE = /\b(latest|current(?:ly)?|recent(?:ly)?|\bnow\b|as of|still (?:in effect|valid|applicable|current|in force)|up[- ]?to[- ]?date|in force|still (?:the )?(?:law|rule|regulation))\b/i;

// One-line, human-readable summary of an item's supersession status, or null if it has
// none — appended to that document's context block so synthesis can state it explicitly
// instead of only citing the superseding document as an aside.
function supersessionContextLine(item) {
  const sup = item.supersession;
  if (!sup || !sup.status || sup.status === 'active' || sup.status === 'not_yet_verified') return null;
  const sb = sup.supersededBy;
  if (!sb) return null;
  const verb = sup.status === 'possibly_superseded' ? 'POSSIBLY SUPERSEDED' : 'SUPERSEDED';
  const mechanism = sb.mechanism === 'explicit_reference' ? 'explicit reference' : 'content match';
  const confidencePart = sb.confidence ? `, confidence: ${sb.confidence}` : '';
  return `Supersession status: ${verb} by "${sb.title}"${sb.date ? ` (${sb.date})` : ''} — ${mechanism}${confidencePart}`;
}

// Detect what kind of response the user wants
function detectQueryIntent(question) {
  const q = question.toLowerCase();
  // Table intent: user wants structured/tabular output
  if (/\b(table|tabulate|tabular|spreadsheet)\b/.test(q))           return 'table';
  if (/\b(list all|show all|all the|every|all disclosures?)\b/.test(q)) return 'table';
  if (/\b(checklist|breakdown|compare|comparison|side.by.side)\b/.test(q)) return 'table';
  if (/\bdisclosures? required\b/.test(q))                          return 'table';
  if (/\ball (requirements?|obligations?|conditions?)\b/.test(q))   return 'table';
  if (/\bwhat are (all|the) (key |main )?(requirements?|obligations?|conditions?)\b/.test(q)) return 'list';
  if (/\b(key points?|main points?|highlights?|summary of|summarise|summarize)\b/.test(q)) return 'list';
  if (/\bsteps?\b|\bprocess\b/.test(q))                             return 'list';
  return 'narrative';
}

// Score an item against the query — phrase + token + source boost + recency
function scoreAskItem(item, question, tokens, idf = null) {
  if (!tokens.length) return 0;
  const qLow = question.toLowerCase();

  const fields = {
    title:    (item.title || '').toLowerCase(),
    summary:  (item.ai?.summary || '').toLowerCase(),
    excerpts: (item.ai?.excerpts || []).map(e => e.excerpt).join(' ').toLowerCase(),
    type:     (item.type || '').toLowerCase(),
    ref:      (item.ref  || '').toLowerCase()
  };
  const haystack = Object.values(fields).join(' ');

  let score = 0;

  // Phrase bonus — if a 3+ word run from the question appears verbatim
  const phrases = qLow.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3);
  for (let len = Math.min(5, phrases.length); len >= 3; len--) {
    for (let i = 0; i <= phrases.length - len; i++) {
      const phrase = phrases.slice(i, i + len).join(' ');
      if (haystack.includes(phrase)) { score += len * 3; break; }
    }
  }

  // Token scoring with per-field weights: title 5×, summary 3×, excerpts 2×, rest 1×.
  // IDF-weighted (squared, log-scaled tf — see buildTokenIdf/scoreChunk) so rare,
  // distinctive terms outrank common ones that appear across hundreds of documents.
  for (const tok of tokens) {
    const w = Math.pow(idf ? (idf.get(tok) || 1) : 1, 2);
    const esc  = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re   = new RegExp(esc, 'g');
    const rth  = (fields.title.match(re)    || []).length;
    const rsh  = (fields.summary.match(re)  || []).length;
    const rexh = (fields.excerpts.match(re) || []).length;
    const roh  = Math.max(0, (haystack.match(re) || []).length - rth - rsh - rexh);
    const th   = rth  > 0 ? 1 + Math.log(rth)  : 0;
    const sh   = rsh  > 0 ? 1 + Math.log(rsh)  : 0;
    const exh  = rexh > 0 ? 1 + Math.log(rexh) : 0;
    const oh   = roh  > 0 ? 1 + Math.log(roh)  : 0;
    score += (th * 5 + sh * 3 + exh * 2 + oh) * w;
  }

  // Source boost when question explicitly names the regulator
  if (item.source === 'RBI'  && qLow.includes('rbi'))  score *= 1.6;
  if (item.source === 'SEBI' && qLow.includes('sebi')) score *= 1.6;
  if (item.source === 'IBBI' && (qLow.includes('ibbi') || qLow.includes('insolvency board'))) score *= 1.6;

  // Type boost when question names the document type
  if (qLow.includes('master direction') && fields.type.includes('master direction')) score *= 1.4;
  if (qLow.includes('circular') && fields.type.includes('circular'))                 score *= 1.3;

  // Recency tiebreaker
  if (item.dateSort > 0) score += item.dateSort / 1e12;

  return score;
}

// Build the Claude system prompt for each intent type — kept short and focused.
function buildAskPrompt(intent) {
  const base =
    'You are a regulatory intelligence assistant for Indian financial regulation (RBI, SEBI, IBBI). ' +
    'Answer STRICTLY and ONLY using the numbered documents and "Relevant passages" provided below — ' +
    'they are direct excerpts from the actual regulatory documents, not summaries. ' +
    'If the answer to the question — or any part of it — appears anywhere in the provided passages, ' +
    'you MUST use it, even if it is brief, partial, or phrased differently than the question. ' +
    'Quote or closely paraphrase the relevant passage and cite its document by [number]. ' +
    'Do NOT say information is "not available" or "not found" if it is present in the passages — read them carefully first. ' +
    'Only say the context is insufficient if the passages truly contain nothing relevant to the question. ' +
    'When multiple documents are relevant, prioritise the document that most directly addresses the specific question. ' +
    'For questions about NCD issuance requirements, SEBI regulations on issue and listing of non-convertible securities ' +
    'should take priority over banking investment guidelines. ' +
    'Return ONLY valid JSON, no markdown. ';

  if (intent === 'table') {
    return base +
      'Return: {"answer":"2-3 sentence overview","tableHeaders":["Col1",...],' +
      '"tableRows":[["val",...],...],"cited":[1,2,...]} — at least 2 rows, cells under 80 chars. ';
  }
  if (intent === 'list') {
    return base +
      'Return: {"answer":"1-2 sentence overview","listItems":["Point 1",...],"cited":[1,2,...]} — 4-10 items. ';
  }
  // narrative (default)
  return base + 'Give a precise 3-5 sentence answer. Return: {"answer":"...","cited":[1,2,...]} ';
}

// POST /api/ask — Intelligent search with session memory + intent detection
app.post('/api/ask', async (req, res) => {
  const { question, sessionId, history: clientHistory } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ ok: false, error: 'No question provided' });
  }
  if (!ANTHROPIC_API_KEY || !Anthropic) {
    return res.status(503).json({ ok: false, error: 'Anthropic API key not configured — set ANTHROPIC_API_KEY and restart' });
  }

  const store = readStore();
  if (!store.items.length) {
    return res.status(404).json({ ok: false, error: 'No documents in the database yet — run a scrape first' });
  }

  // ── Resolve session — server is the source of truth for conversation memory ──
  const session = getOrCreateSession(sessionId);
  const history = session ? session.history : (Array.isArray(clientHistory) ? clientHistory : []);
  const isFollowUp = history.length > 0;

  // Does this message reference earlier discussion? ("that circular", "tell me more", "the second one"...)
  const isReference = isFollowUp && REFERENCE_RE.test(question);

  // Small-talk ("hi", "thanks", "bye"...) must never inherit the previous topic's
  // retrieval context — confirmed happening: without this, saying "hi" after a
  // substantive question got the *combined* query "hi <last 3 user messages>"
  // (see historyUserText below), which still scored the old topic's documents
  // highly and answered as if "hi" were a continuation of that topic instead of
  // a fresh greeting.
  const isTrivialMessage = /^\s*(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|bye|goodbye|good morning|good afternoon|good evening)[\s!.,]*$/i.test(question);

  // Intent is detected from the current question only
  const intent = detectQueryIntent(question);
  const SEND_LIMIT = intent === 'narrative' ? 12 : 15;
  const isRecencyQuery = RECENCY_QUERY_RE.test(question);

  let topItems = [];
  let scoredCount = 0;
  let scopedToPrevious = false;
  // parentItemId -> [chunk, ...] — the specific passages that earned a document its place,
  // sent to Claude instead of (or alongside) the document's top-level summary/excerpts.
  let topChunksByItemId = new Map();
  let preassembledContext = null; // built directly during chunk retrieval (carries the final, budget-fitted text)
  let contextLimited = false;     // true if we had to fall back to a minimal 3-chunk context

  if (isReference && session && session.lastCited && session.lastCited.length) {
    // ── Scoped mode: restrict strictly to the documents already discussed ──────
    // Prevents unrelated circulars from other sources leaking into follow-up
    // answers/tables (e.g. "now show me a table for that circular").
    topItems = session.lastCited.slice(0, SEND_LIMIT);
    scoredCount = topItems.length;
    scopedToPrevious = true;
  } else {
    // ── Fresh search: combine current question with recent user turns so   ────
    // follow-ups like "tell me more about ECB" still retrieve the right docs.
    // Skipped for trivial small-talk (see isTrivialMessage above) — otherwise
    // "hi" inherits and re-answers whatever the previous real question was.
    const historyUserText = (isFollowUp && !isTrivialMessage)
      ? history.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' ')
      : '';
    const combinedText = (question + ' ' + historyUserText).trim();
    const queryTokens  = combinedText.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !ASK_STOP.has(t));

    // ── RAG retrieval: search inside document chunks (not just titles/summaries) ──
    // so content buried deep in a document — e.g. "Chapter VIA" — can be found.
    // We pick a FLAT list of the single best-matching chunks across the whole
    // corpus (most relevant passages first, regardless of which document they're
    // from), which keeps the payload small and focused — then map back to their
    // parent documents for citation.
    const itemById  = new Map(store.items.map(it => [it.id, it]));
    const chunkPool = Array.isArray(store.chunks) ? store.chunks : [];

    // IDF weighting: compute how distinctive each query term is across the corpus
    // so rare terms (e.g. "delisting") outrank common ones (e.g. "via", "chapter")
    // that would otherwise flood the ranking with irrelevant documents.
    const chunkTextsLower = chunkPool.map(c => (c.text || '').toLowerCase());
    const itemTextsLower  = store.items.map(it => (
      (it.title || '') + ' ' + (it.ai?.summary || '') + ' ' +
      (it.ai?.excerpts || []).map(e => e.excerpt).join(' ')
    ).toLowerCase());
    const chunkIdf = buildTokenIdf(chunkTextsLower, queryTokens);
    const itemIdf  = buildTokenIdf(itemTextsLower,  queryTokens);

    const qLowForBoost = combinedText.toLowerCase();

    const scoredChunks = chunkPool
      .map(c => ({ chunk: c, score: applyTopicBoosts(scoreChunk(c, combinedText, queryTokens, chunkIdf), c.parentTitle, qLowForBoost) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    // Fallback: title/summary/excerpt scoring catches documents that haven't
    // been chunked yet, or that match mainly on metadata rather than body text.
    const itemScored = store.items
      .map(it => ({ item: it, score: applyTopicBoosts(scoreAskItem(it, combinedText, queryTokens, itemIdf), it.title, qLowForBoost) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    scoredCount = new Set([...scoredChunks.map(x => x.chunk.parentId), ...itemScored.map(x => x.item.id)]).size;

    topChunksByItemId = new Map();
    topItems = [];
    let limitedContext = false;

    // Builds {context, items, chunksByItem} from the top N scored chunks, topped
    // up with summary-only matches (for un-chunked docs) up to SEND_LIMIT.
    function assemble(maxChunks, wordsPerChunk) {
      const chosen = scoredChunks.slice(0, maxChunks);
      const seen = new Set();
      const items = [];
      const chunksByItem = new Map();
      for (const { chunk } of chosen) {
        const it = itemById.get(chunk.parentId);
        if (!it) continue;
        if (!seen.has(it.id)) { seen.add(it.id); items.push(it); chunksByItem.set(it.id, []); }
        chunksByItem.get(it.id).push(chunk);
      }
      for (const { item } of itemScored) {
        if (items.length >= SEND_LIMIT) break;
        if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
      }
      // If a retrieved document has been superseded, always pull its superseding document
      // into the candidate pool too — even if it wouldn't otherwise have scored into the
      // top N. Confirmed happening: the superseded doc alone scores well enough to retrieve
      // (it's literally what the question is about), but the newer document that actually
      // answers "what's current" can rank just outside the cutoff on pure keyword relevance,
      // leaving nothing for the model to cite/link as the answer even though it's the whole
      // point of the question. This runs after the SEND_LIMIT top-up on purpose — it's a
      // correctness guarantee, not subject to the same budget cap.
      for (const it of [...items]) {
        const docId = it.supersession?.supersededBy?.docId;
        if (docId && !seen.has(docId)) {
          const superseding = itemById.get(docId);
          if (superseding) { seen.add(docId); items.push(superseding); }
        }
      }
      // Recency-sensitive queries: explicitly sort candidates newest-first before they're
      // numbered, so the ordering itself — not just dates buried in passage text — signals
      // to the model which document is actually most recent.
      if (isRecencyQuery) items.sort((a, b) => (b.dateSort || 0) - (a.dateSort || 0));
      const ctx = items.map((it, i) => {
        const parts = [
          `[${i + 1}] ${it.source} ${it.type}${it.date ? ' · ' + it.date : ''}${it.ref ? ' · ' + it.ref : ''}`,
          `Title: ${it.title}`
        ];
        const chunks = chunksByItem.get(it.id) || [];
        if (chunks.length) {
          parts.push('Relevant passages:\n' + chunks
            .map(c => `  • "${truncateWords(c.text, wordsPerChunk)}"`)
            .join('\n'));
        } else if (it.ai?.summary) {
          parts.push(`Summary: ${it.ai.summary}`);
        } else if (it.ai?.excerpts?.length) {
          parts.push('Key excerpts: ' + it.ai.excerpts.slice(0, 2).map(e => `"${e.excerpt.slice(0, 200)}"`).join(' | '));
        }
        const supLine = supersessionContextLine(it);
        if (supLine) parts.push(supLine);
        return parts.join('\n');
      }).join('\n\n---\n\n');
      return { context: ctx, items, chunksByItem, chunkCount: chosen.length };
    }

    // ── Token estimator + progressive reduction ──────────────────────────────
    // Claude Haiku has a much larger context window (~200K tokens) than the old
    // Groq free-tier model, so we can comfortably send more/larger chunks. We
    // still keep a generous budget check as a safety net for pathological cases.
    const FIXED_OVERHEAD_TOKENS = 1200; // system prompt + history + question (rough)
    const TOKEN_BUDGET = 60000;

    let maxChunks = Math.min(10, scoredChunks.length); // start at up to 10 most relevant chunks
    let wordsPerChunk = 800;                           // ≤ 800 words per chunk
    let assembled = assemble(maxChunks, wordsPerChunk);

    while (maxChunks > 5 && FIXED_OVERHEAD_TOKENS + estimateTokens(assembled.context) > TOKEN_BUDGET) {
      maxChunks -= 1;
      assembled = assemble(maxChunks, wordsPerChunk);
    }
    if (FIXED_OVERHEAD_TOKENS + estimateTokens(assembled.context) > TOKEN_BUDGET) {
      // Still too large — fall back to the top 5 chunks only and warn the user
      maxChunks = Math.min(5, scoredChunks.length);
      wordsPerChunk = 500;
      assembled = assemble(maxChunks, wordsPerChunk);
      limitedContext = scoredChunks.length > 0;
    }

    topItems          = assembled.items;
    topChunksByItemId = assembled.chunksByItem;
    contextLimited    = limitedContext;
    preassembledContext = assembled.context; // already budget-fitted — use as-is
  }

  // For follow-up turns with zero fresh matches we still ground in history — but
  // never for trivial small-talk, which should always get the plain conversational
  // prompt regardless of what was discussed earlier.
  const hasDocContext = topItems.length > 0 || (isFollowUp && !isTrivialMessage);

  // ── Context string sent to Claude ─────────────────────────────────────────────
  // Fresh-search path already assembled (and budget-fitted) its context above;
  // the scoped-to-previous path (no chunks selected) builds a lightweight
  // summary-based context for the documents already discussed.
  if (preassembledContext === null && isRecencyQuery && topItems.length > 0) {
    topItems = [...topItems].sort((a, b) => (b.dateSort || 0) - (a.dateSort || 0));
  }
  const context = preassembledContext !== null
    ? preassembledContext
    : (topItems.length > 0
        ? topItems.map((it, i) => {
            const parts = [
              `[${i + 1}] ${it.source} ${it.type}${it.date ? ' · ' + it.date : ''}${it.ref ? ' · ' + it.ref : ''}`,
              `Title: ${it.title}`
            ];
            if (it.ai?.summary) parts.push(`Summary: ${it.ai.summary}`);
            if (it.ai?.excerpts?.length)
              parts.push('Key excerpts: ' + it.ai.excerpts.slice(0, 2).map(e => `"${e.excerpt.slice(0, 200)}"`).join(' | '));
            const supLine = supersessionContextLine(it);
            if (supLine) parts.push(supLine);
            return parts.join('\n');
          }).join('\n\n---\n\n')
        : '');

  // ── Build system prompt ───────────────────────────────────────────────────────
  const conversationalSystemPrompt =
    'You are a friendly assistant for a regulatory monitoring platform (RBI, SEBI, IBBI). ' +
    'Respond naturally; for greetings/small talk be warm and brief. If no documents matched a regulatory question, ' +
    'give a short general answer and suggest running a scrape. Use chat history to resolve references like "that one". ' +
    'Return ONLY valid JSON: {"answer":"...","cited":[]}';

  let systemPrompt = hasDocContext ? buildAskPrompt(intent) : conversationalSystemPrompt;

  if (scopedToPrevious) {
    systemPrompt += ' Answer using ONLY the document(s) already discussed below — do not bring in other sources.';
  }

  // Recency-sensitive query: documents below are explicitly sorted newest-first — the
  // model must use that ordering, not infer recency from passage content, and must not
  // call something "latest"/"current" if a later-dated document also appears below.
  if (hasDocContext && isRecencyQuery) {
    systemPrompt += ' This question asks about what is CURRENT or LATEST. The numbered documents below are ' +
      'sorted newest-first by their own date — before calling any document "latest," "current," or "still in ' +
      'effect," check whether a document with a more recent date also appears in the list below; if so, that ' +
      'later document is the current one, and you must say so even if the older document seems to answer the ' +
      'question more directly.';
  }

  // Any retrieved document carrying a "Supersession status" line must be stated explicitly
  // in the answer — not left as an aside about "a newer document" — and low-confidence
  // supersessions must be phrased as uncertain, not settled fact.
  if (hasDocContext && topItems.some(it => supersessionContextLine(it))) {
    systemPrompt += ' One or more documents below include a "Supersession status" line. You must state that ' +
      'status explicitly in your answer (e.g. "This has been superseded by X") — do not just mention the ' +
      'superseding document in passing. If its confidence is "low," phrase this as uncertain ' +
      '(e.g. "may have been superseded — worth verifying") rather than as settled fact. If the superseding ' +
      'document also appears as one of the numbered documents below, you MUST include its [number] in "cited" ' +
      'too, not just the number of the older/superseded document — a reader needs to be able to click through ' +
      'to the current document, not only the one that was replaced.';
  }

  const userContent = context
    ? `${isFollowUp ? 'Follow-up query' : 'Query'}: ${question}\n\n${scopedToPrevious ? 'Previously discussed document(s)' : 'Relevant Regulatory Documents'}:\n\n${context}`
    : `${isFollowUp ? 'Follow-up query' : 'Query'}: ${question}`;

  // ── Full conversation history sent to Claude (capped to keep token usage sane) ──
  const priorMessages = history.slice(-16).map(m => ({
    role:    m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 900)
  }));

  const maxTokens = intent === 'table' ? 1300 : intent === 'list' ? 1000 : 700;

  try {
    const rawReply = await callClaude(
      systemPrompt,
      [...priorMessages, { role: 'user', content: userContent }],
      { maxTokens, temperature: hasDocContext ? 0.1 : 0.7 }
    );

    const raw = rawReply.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    let data = null;
    const matched = raw.match(/\{[\s\S]*\}/);
    if (matched) {
      try { data = JSON.parse(matched[0]); } catch { /* fall through to repair */ }
    }
    if (!data) {
      // Likely truncated mid-JSON (hit max_tokens before the closing brace was emitted —
      // the regex above found no/an unparseable object). Try to repair it: drop the
      // trailing incomplete fragment and balance braces/brackets, then re-parse.
      const repaired = repairTruncatedJson(raw);
      if (repaired) { try { data = JSON.parse(repaired); } catch { /* still no good */ } }
    }
    if (!data) {
      console.error('Raw Claude output (unparseable/truncated JSON):', raw.slice(0, 1200));
      // Claude sometimes ignores "return ONLY JSON" for casual/conversational input
      // (e.g. "Hi") and just replies in plain text — confirmed happening for exactly
      // that case. Rather than failing the whole request, fall back to using that
      // plain text as the answer directly instead of erroring out. Only reached when
      // no JSON object could be extracted or repaired at all.
      data = { answer: raw.trim().slice(0, 1800) || "I'm not sure how to respond to that — try asking about a specific regulation or circular.", cited: [] };
    }

    // ── Resolve cited indices → source objects ────────────────────────────────
    // Deduped by value here (Claude can list the same index twice in its own "cited"
    // array — e.g. after citing a document twice in the prose) and again by document id
    // below when building `sources`, so the same document can never appear twice in
    // "Sources cited" regardless of how the duplicate got introduced.
    const citedRaw = Array.isArray(data.cited) ? data.cited : [];
    const citedIdx = hasDocContext
      ? [...new Set(citedRaw.map(n => Number(n) - 1).filter(n => n >= 0 && n < topItems.length))]
      : [];

    // If Claude didn't cite anything but we scoped to previous docs, keep citing them
    let effectiveCitedIdx = (citedIdx.length === 0 && scopedToPrevious)
      ? topItems.map((_, i) => i)
      : citedIdx;

    // Deterministic backstop, not just a prompt instruction: if a cited document has been
    // superseded and the superseding document is also among topItems, always include it too
    // — confirmed the model will sometimes name/describe the superseding document in prose
    // (correctly) without adding its own index to "cited", which would otherwise leave the
    // reader with a link to only the outdated document.
    const idByIndex = new Map(topItems.map((it, i) => [it.id, i]));
    const supersedingIdx = new Set();
    for (const i of effectiveCitedIdx) {
      const docId = topItems[i]?.supersession?.supersededBy?.docId;
      if (docId && idByIndex.has(docId) && !effectiveCitedIdx.includes(idByIndex.get(docId))) {
        supersedingIdx.add(idByIndex.get(docId));
      }
    }
    if (supersedingIdx.size) effectiveCitedIdx = [...effectiveCitedIdx, ...supersedingIdx];

    // Final safety net: dedupe by document id, not just index — guards against the store
    // itself briefly containing two entries for the same real document (confirmed
    // happening via repeated Add Document calls before duplicate detection existed there)
    // ending up cited as if they were two different sources.
    const seenSourceIds = new Set();
    const sources = effectiveCitedIdx
      .filter(i => {
        const id = topItems[i]?.id;
        if (!id || seenSourceIds.has(id)) return false;
        seenSourceIds.add(id);
        return true;
      })
      .map(i => ({
        title:  topItems[i].title,
        source: topItems[i].source,
        type:   topItems[i].type,
        date:   formatDate(topItems[i].date) || topItems[i].date || null,
        url:    topItems[i].url,
        ref:    topItems[i].ref || null
      }));

    // ── Validate structured fields ────────────────────────────────────────────
    const tableHeaders = (intent === 'table' && Array.isArray(data.tableHeaders))
      ? data.tableHeaders.slice(0, 8)
      : null;
    const tableRows = (intent === 'table' && Array.isArray(data.tableRows))
      ? data.tableRows.slice(0, 30).map(r => Array.isArray(r) ? r.map(c => String(c).slice(0, 120)) : [])
      : null;
    const listItems = (intent === 'list' && Array.isArray(data.listItems))
      ? data.listItems.slice(0, 15).map(s => String(s).trim())
      : null;

    let answer = String(data.answer || '').trim().slice(0, 1500);
    if (contextLimited) {
      answer += "\n\n_Note: this answer is based on a limited set of the most relevant passages — the question matched an unusually large amount of content, so context was trimmed to stay within the AI model's request size limits._";
    }

    // ── Persist this exchange into server-side session memory ─────────────────
    if (session) {
      session.history.push({ role: 'user',      content: question });
      session.history.push({ role: 'assistant', content: answer });
      if (session.history.length > SESSION_MAX_TURNS) {
        session.history = session.history.slice(-SESSION_MAX_TURNS);
      }
      // Remember exactly which documents were cited so follow-ups can stay scoped
      if (effectiveCitedIdx.length) {
        session.lastCited = effectiveCitedIdx.map(i => topItems[i]);
      }
      session.updatedAt = Date.now();
    }

    console.log(`Ask [${intent}]: "${question.slice(0,55)}" → ${scoredCount} matched, ${sources.length} cited` +
      `${scopedToPrevious ? ' (scoped to previous)' : ''}${hasDocContext ? '' : ' (conversational)'}`);

    res.json({
      ok:           true,
      sessionId:    sessionId || null,
      queryType:    intent,
      answer,
      tableHeaders,
      tableRows,
      listItems,
      sources,
      totalMatched: scoredCount,
      sentToGroq:   topItems.length, // field name kept for frontend compatibility
      scopedToPrevious,
      contextLimited
    });

  } catch (e) {
    console.error('Ask error:', describeClaudeError(e));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ask/new — start a fresh conversation (clears server-side session memory)
app.post('/api/ask/new', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && chatSessions.has(sessionId)) {
    chatSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

// GET stats
app.get('/api/stats', (req, res) => {
  const store = readStore();
  const cfg   = readConfig();
  res.json({
    total: store.items.length,
    rbi:   store.items.filter(i => i.source === 'RBI').length,
    sebi:  store.items.filter(i => i.source === 'SEBI').length,
    ibbi:  store.items.filter(i => i.source === 'IBBI').length,
    seen:  store.seenIds.length,
    lastScraped: cfg.lastScraped
  });
});

// ─── Cron: every 2 hours ──────────────────────────────────────────────────────
cron.schedule('0 */2 * * *', () => {
  if (SKIP_STARTUP_SCRAPE) return;
  runScrape().catch(console.error);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Regulatory Monitor → http://localhost:${PORT}`);
  if (SKIP_STARTUP_SCRAPE) {
    console.log('SKIP_STARTUP_SCRAPE=true — serving the existing store as-is; no startup scrape, periodic scrape, or backfill jobs will run.');
  } else {
    setTimeout(() => runScrape(true).catch(console.error), 2000);
    // Re-process pre-existing documents into RAG chunks in the background, in small batches
    scheduleChunkBackfill(20000);
    // Re-process pre-existing documents for Document Validity Checker reference data
    scheduleReferenceBackfill(25000);
  }
});
