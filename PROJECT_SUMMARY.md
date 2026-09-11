# Regulatory Monitor — Project Summary

> Deeper technical reference — repo structure, data schemas, and internals. See [README.md](README.md) for what the platform does and how to use it.

> Last updated: September 2026
> Status: **Fully operational**

---

## 1. File Structure

```
regulatory-monitor-100\
│
├── server.js               # Express backend — all scraping, AI, scheduling, API, email
├── package.json             # npm dependencies
├── package-lock.json        # Locked dependency versions
├── .gitignore                # Excludes node_modules/, .env; data/store.json and
│                              # data/config.json are deliberately tracked in this repo
├── .env.example              # Documents every environment variable required
├── README.md                  # What the platform does and how to use it
├── PROJECT_SUMMARY.md          # This file
│
├── public\
│   └── index.html            # Complete frontend — single-file, no framework, no build step
│
└── data\
    ├── store.json            # Scraped + manually-uploaded items, chunks, and list of every seen item ID
    └── config.json            # Saved keywords, per-subscriber alert list, and email SMTP sender settings
                                 # (email.host/user/pass are stripped from the tracked copy — set via
                                 # SMTP_* env vars in deployment instead)
```

### `server.js` — internal sections

| Function / Section | Purpose |
|---|---|
| `parseDate()` | Normalises three date formats: `DD.M.YYYY` (RBI), `Mon DD, YYYY` (SEBI), `DDth Month, YYYY` (IBBI) |
| `sortByDate()` | Sorts items newest-first using parsed timestamps |
| `isJunk()` | Rejects strings under 20 chars or matching a file-size pattern (e.g. `"141 KB"`) |
| `getEmailConfig()` | Merges env vars (`SMTP_*`) over `config.json` values — env vars win |
| `extractExcerpts()` | Scans extracted document text for each user keyword; returns the sentence window (±200 chars) around the first match, trimmed to sentence boundaries |
| `analyzeExtractedText()` | Runs `extractExcerpts()` on full text, sends it to Claude (`claude-haiku-4-5`) for a summary, returns `{summary, excerpts, analyzedAt}` with a fallback plain-text response if Claude doesn't return parseable JSON |
| `scrapeRBI()` | Fetches 6 RBI sections using two scraper patterns (see below) |
| `scrapeRBIDateHeaderPage()` | Generic helper for RBI pages that interleave date-header rows with content rows |
| `scrapeSEBI()` | Fetches 4 SEBI DataTable listing pages (sid param) |
| `scrapeIBBI()` | Parses the IBBI homepage `<ul class="activityTicker">` — a SPA where all content is embedded on one page |
| `matchesKeywords()` | Case-insensitive title match against user's keyword list |
| `capStoreItems()` | Caps auto-scraped items at 1,000 (oldest first); items with `addedManually: true` are always kept regardless of count |
| `withStoreLock()` | In-process async mutex serialising `store.json` read-modify-write cycles across concurrent scrapes/uploads/backfills; only the final merge+write is locked, slow network I/O happens outside it |
| `collapseHorizontalWhitespace()` / `fetchFullTextForItem()` | Extraction pass that preserves newlines (unlike the fully-collapsed `fullText` used for AI/chunking) so Stage 1 regex can see table/paragraph structure |
| `parseOwnReference()` / `extractRepealReferences()` / `resolveReferencesForItem()` | Check Validity Stage 1: find this doc's own reference number(s), find what it explicitly repeals, bidirectionally match against every other item in the store |
| `findSupersessionCandidates()` / `checkContentSupersession()` / `runStage2Check()` | Check Validity Stage 2: retrieve same-source later-dated candidates via the existing chunk scoring, ask Claude to judge content supersession and cite matching sections |
| `backfillReferencesBatch()` / `scheduleReferenceBackfill()` | Background job applying Stage 1 to the pre-existing corpus, 7 items per batch, self-rescheduling; permanently-failing items are marked `refExtractionFailed` so they don't retry forever |
| `matchSubscriberKeywords()` / Claude-assisted description matching | Per-subscriber alert matching: keyword substring match or semantic match against a subscriber's free-text description |
| `buildSubscriberEmailHtml()` / `dispatchSubscriberAlerts()` | Constructs and sends one branded HTML email per matching subscriber (source badges, type, date, links) |
| `runScrape()` | Full scrape cycle: fetch all sources → deduplicate → cap via `capStoreItems()` → Claude analysis → Stage 1 reference resolution → `dispatchSubscriberAlerts()` |
| `ingestDocument()` | Shared ingestion path for manual URL/PDF uploads (including Check Validity uploads) — sets `addedManually: true`, runs Claude analysis, chunking, and Stage 1 inline |
| `GET /api/items` | Returns paginated items; supports `source`, `keywords`, `page`, `limit` query params |
| `GET /api/config` | Returns keywords and masked email config |
| `PUT /api/config` | Saves updated keywords or email settings |
| `GET/POST/PUT/DELETE /api/subscribers` | CRUD for per-subscriber alert recipients; `POST /api/subscribers/:id/test` sends a test email |
| `GET /api/validity/:id` | Returns an item's current `supersession`/`refInfo`/`repeals`, running Stage 1 on-demand if not yet computed |
| `POST /api/validity/:id/check-content` | Runs Stage 2 for one item (cached unless `force:true`) |
| `POST /api/validity/upload` | Uploads a PDF, permanently stores it via `ingestDocument()`, returns Stage 1 result |
| `POST /api/scrape` | Triggers an immediate scrape |
| `GET /api/log` | Returns last 50 scrape log entries |
| `GET /api/stats` | Returns `{total, rbi, sebi, ibbi, seen, lastScraped}` |
| `POST /api/test-email` | Sends a test email using up to 3 real stored items |
| cron | `node-cron` schedule `0 */2 * * *` — fires at the top of every even hour (skipped entirely when `SKIP_STARTUP_SCRAPE=true`) |

---

## 2. Data Schemas

### `data/store.json`

```json
{
  "seenIds": ["rbi_c_abc123", "sebi_pr_xyz456"],
  "items": [
    {
      "id":          "rbi_c_<base64>",
      "source":      "RBI",
      "type":        "Circular",
      "title":       "Investments by Foreign Portfolio Investors...",
      "ref":         "RBI/2026-27/05 A.P.(DIR Series) Circular No.05",
      "date":        "06.4.2026",
      "dateSort":    1744070400000,
      "url":         "https://www.rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx?Id=13464",
      "fetchedAt":   "2026-06-06T10:11:56.527Z",
      "ai": {
        "summary":    "This circular amends the regulatory framework for FPI investments...",
        "excerpts": [
          {
            "keyword": "FPI",
            "excerpt": "investments by Foreign Portfolio Investors (FPIs) in Government Securities through the General Route are subject to..."
          }
        ],
        "analyzedAt": "2026-06-06T14:10:45.123Z"
      }
    }
  ],
  "chunks": [
    { "parentId": "rbi_c_<base64>", "text": "...", "index": 0 }
  ]
}
```

**`seenIds`** — flat array of every item ID ever fetched. An item in this list will never be
emailed again, even if it is re-fetched. This is the sole deduplication mechanism for scraping.

**`ai`** — present once Claude analysis has run on an item (inline for new items during a scrape,
or via the background chunk-backfill job for older ones).

Items also carry (once Stage 1/2 processing has run):

```json
{
  "addedManually": true,
  "refInfo":  { "raw": "RBI/2025-26/199", "allRefs": ["RBI/2025-26/199"], "year": "2025-26", "number": "199", "parsedAt": "..." },
  "repeals":  [ { "rawRef": "RBI/2008-09/109", "date": "19.9.2008", "subject": "...", "matchedItemId": "rbi_c_abc", "matchedAt": "..." } ],
  "supersession": {
    "status": "active | superseded | possibly_superseded | unknown",
    "supersededBy": { "docId": "...", "title": "...", "date": "...", "url": "...", "source": "RBI", "type": "Master Direction", "mechanism": "explicit_reference | content_match", "confidence": "high|medium|low", "citation": { "oldSection": "...", "newSection": "..." } },
    "stage2Attempted": false,
    "checkedAt": null
  }
}
```

`addedManually: true` is set on any document added via URL, PDF upload, or Check Validity's
upload flow — these items are **exempt from the 1,000-item cap** and are never evicted, even
across restarts. Only auto-scraped items are capped, oldest-first.

### `data/config.json`

```json
{
  "keywords": [
    "ECB", "NCD", "FPI", "stamp duty", "NBFC", "lending", "debenture",
    "foreign portfolio", "external commercial borrowing",
    "insolvency", "bankruptcy", "liquidation", "resolution", "IBC",
    "NCLT", "personal insolvency", "resolution professional"
  ],
  "policies": [
    { "id": "ecb", "name": "ECB Policy", "department": "Treasury", "keywords": ["ECB", "external commercial borrowing"] }
  ],
  "subscribers": [
    {
      "id": "sub_abc123",
      "email": "user@example.com",
      "keywords": ["NBFC", "stamp duty"],
      "description": "Anything relevant to debenture trustee compliance",
      "enabled": true,
      "createdAt": "...",
      "sentItemIds": ["rbi_c_abc123"]
    }
  ],
  "email": {
    "port": 465,
    "to": "",
    "lastSendAt": "...",
    "lastSendOk": true
  },
  "lastScraped": "2026-06-06T14:10:56.527Z"
}
```

`email.host`/`email.user`/`email.pass`/`email.enabled` are intentionally absent from the tracked
copy of this file — those are set via `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`SMTP_ENABLED` env vars
in deployment instead, so no credential sits in the repo. Locally, `getEmailConfig()` falls back
to these file fields when the env vars aren't set — see `server.js:98`. Alert **recipients** are
the `subscribers` array, each with their own keyword list and/or free-text description; matching
is a keyword substring match OR a Claude semantic match against the description, run per
newly-scraped item during each scrape cycle.

---

## 3. Features — Complete List

### Scraping

**RBI (6 sections):**
- `BS_CircularIndexDisplay.aspx` → Circulars (col[3] = subject, col[1] = date, col[0] = link)
- `BS_PressReleaseDisplay.aspx` → Press Releases (col[0] = title+link; no date available)
- `NotificationUser.aspx` → Notifications (date-header-row pattern)
- `BS_ViewMasDirections.aspx` → Master Directions (date-header-row pattern)
- `BS_ViewMasterCirculardetails.aspx` → Master Circulars (date-header-row pattern)
- `BS_SpeechesView.aspx` → Speeches (date-header-row pattern)

**Date-header-row pattern:** Some RBI pages interleave date-only rows (no link) between
content rows. `scrapeRBIDateHeaderPage()` tracks the last-seen date row and applies it to
all content rows below it, until the next date row.

**SEBI (4 sections, ~25 items each):**
- `sid=1` → Circulars
- `sid=2` → Press Releases
- `sid=4` → Consultation Papers
- `sid=6` → Speeches & Public Notices

SEBI `sid=3` is excluded — confirmed to be an internal application processing queue.
SEBI Orders, Regulations and Informal Guidance are not accessible (JavaScript-rendered pages
return empty HTML when fetched server-side). Some SEBI detail pages embed the actual document
as a PDF inside an `iframe[src*="file="]` rather than in the page's own HTML —
`fetchFullTextForItem()` detects this and extracts the PDF URL from the iframe `src`.

**IBBI (homepage SPA, 2025+ only):**
- All content lives in `<ul class="activityTicker">` on the homepage
- Link text format: `"DDth Month, YYYY Type: Title (filesize)"`
- Types classified by regex: Press Release, Circular, Order, Discussion Paper, Notification,
  Agenda/Minutes, Regulation, Notice
- Items older than 2025 are excluded to keep the list manageable

### Scheduling

- Cron fires at `0 */2 * * *` — top of every even hour (00:00, 02:00, 04:00…)
- First scrape runs 2 seconds after server start
- "Scrape Now" button in the dashboard header triggers an immediate scrape
- Both the startup scrape and the periodic cron scrape (plus the post-boot chunk/reference
  backfill jobs) are skipped entirely when `SKIP_STARTUP_SCRAPE=true` — used on the memory-
  constrained Render deployment, which serves a fixed curated corpus rather than live-scraping

### Deduplication

- Each item gets a stable ID: `source_type_base64(url+title).slice(0,100)`
- All seen IDs are written to `store.json → seenIds` permanently
- On each scrape, only items whose ID is not in `seenIds` are treated as new
- Manual URL/PDF ingestion additionally runs three duplicate checks before storing: exact URL
  match, parsed-reference-number match, and exact normalised-title match (`findDuplicateByTitle()`)
  — the last one catches the same document added twice via different ingestion paths (e.g.
  upload vs. URL-paste), which can't collide on URL or reference number alone
- Historical items (already seen) are never re-emailed

### Claude AI Analysis

**Model:** `claude-haiku-4-5` via the Anthropic API

**Triggered:** Automatically for up to 20 new items per scrape, with a throttle delay between
requests to stay within rate limits. Also runs inline whenever a document is manually
uploaded/added via URL, and in the background chunk-backfill job for older items in the store.

**Process for each new item:**
1. Download document — PDFs fetched as `arraybuffer` (max 20 MB); HTML pages scraped with axios
2. Extract text — PDFs processed with `pdf-parse`; HTML stripped of nav/script/footer then text extracted with cheerio. A lightly-normalised, line-preserving variant of the same text is also captured for Stage 1 reference/repeal regex extraction (table/paragraph structure is destroyed by the fully-collapsed text used for AI/chunking, so this is a separate pass).
3. **Keyword excerpts** — `extractExcerpts()` searches the full untruncated text for each of the user's saved keywords. For each keyword found, it extracts the sentence window around the first match (±200 chars, trimmed to sentence boundaries).
4. **Claude summary** — text sent to `claude-haiku-4-5` with a legal-assistant system prompt, returns a plain English summary as JSON.
5. **Chunking** — text split into 500–800 word chunks with 100-word overlap and indexed for the lexical/IDF-weighted retrieval that powers the AI Assistant and Compliance Check.
6. **Stage 1 reference extraction** — `parseOwnReference()` finds this document's own reference number(s); `extractRepealReferences()` scans for explicit repeal/supersession language and pulls out what it repeals; `resolveReferencesForItem()` then does a bidirectional match against every other item in the store (works regardless of which of the two related documents was ingested first).
7. Result stored in `item.ai = { summary, excerpts, analyzedAt }` plus the `refInfo`/`repeals`/`supersession` fields described above.

**If Claude fails** (network error, rate limit, unparseable response): the item is still stored
and shown on the dashboard, just without a summary or excerpts. A fallback plain-text response is
used rather than throwing when the model doesn't return valid JSON. Failure is logged to console.

**Key limitation:** AI analysis only runs automatically on up to 20 *new* items per scrape cycle;
a background backfill job (`scheduleChunkBackfill`) processes older un-chunked items 25 at a time
until the whole store is covered, self-rescheduling after each batch. A parallel background job
(`scheduleReferenceBackfill`) does the same for Stage 1 reference/repeal extraction on the existing
corpus — items that permanently fail (e.g. an oversized PDF or a blocked external host) are marked
`refExtractionFailed` so the batch loop doesn't retry them forever.

### Dashboard

**Layout:** Sticky header + 260px sidebar + main content area.

**Sidebar:**
- Stat cards: Showing / Total / RBI / SEBI / IBBI counts, plus a "Curated demo corpus" note
  that appears automatically when the total item count is small (≤ 200)
- Source filter buttons: All / RBI / SEBI / IBBI
- Keyword manager: saved keyword tags (click to filter), add/remove keywords, changes persist immediately
- Scrape log: last 5 scrape entries with fetched/new/matched counts

**Main feed:**
- Search bar — filters by free text across item titles (debounced 280ms)
- Active filter indicator — shown when a keyword or search is active, with one-click clear
- Item cards sorted newest-first, paginated at 50 per page
- Auto-refresh every 30 seconds

**Item card contents (top to bottom):**
1. Clickable document title (links to source website)
2. Claude summary (italic, left-bordered — only on AI-analysed items)
3. "📄 Found in document" section — keyword chip + highlighted excerpt from document text (only when keywords were found inside the full document text)
4. Meta row: source badge (RBI amber / SEBI blue / IBBI green), type badge, date, keyword match badges, fetch time

### Email Alerts (per-subscriber)

- Each subscriber (managed in the Email Alerts tab) has their own email, optional keyword list,
  and/or a free-text description of what they care about — there is no single fixed recipient.
- Matching per subscriber per new item: keyword substring match on title/text, **or** a Claude
  semantic match of the item against the subscriber's description (batched per scrape cycle).
- Each matched item carries a `whyMatched: {matchType, detail}` value — the actual matched
  keyword(s), or the one-sentence reason the semantic-match Claude call already returned (no
  second LLM call needed) — rendered as a "💡 Why this matched" line in the digest email.
- Sends HTML email via Nodemailer, one email per matching subscriber, with a branded header and
  a table of matching items (source badge, type, date, clickable title).
- Email footer links to the live app URL (uses `APP_URL` env var — set this explicitly in
  deployment, it isn't auto-detected).
- Subscribers can be added/edited/removed via `/api/subscribers` CRUD endpoints; a "Send Test"
  action per subscriber uses up to 3 real stored items.
- Only fires for items that are both (a) new this scrape and (b) match a given subscriber's
  keywords or description.

### Check Validity

Answers "is this document still in force?" for any indexed document or a freshly uploaded PDF.

- **Stage 1 (deterministic, always runs, instant)** — regex-based extraction of this document's
  own reference number and any reference numbers it explicitly says it repeals/supersedes/rescinds.
  Resolution is **bidirectional**: it doesn't matter whether the repealing document or the repealed
  document was ingested first — `resolveReferencesForItem()` checks both directions every time any
  item's reference fields are freshly computed. Tuned primarily for RBI reference formats
  (e.g. `RBI/2025-26/199`, `DOR.ACC.REC.118/21-02-067/2025-26`); SEBI/IBBI patterns are best-effort.
- **Stage 2 (on-demand, semantic)** — triggered only by clicking "Check for content-based
  supersession". Finds same-source documents dated after the item using the existing lexical/IDF
  chunk-scoring retrieval, then asks Claude to judge whether any of the top-scoring candidates
  restates/supersedes the old document's content — even with no explicit citation — and to cite the
  corresponding old/new section numbers. Result (including "no match found") is cached on the item
  so repeat checks are free until the user forces a re-check.
- Accessible two ways in the "Check Validity" tab: search for an existing indexed document, or
  upload a new PDF (which is also permanently stored in the corpus, exempt from the 1,000-item cap,
  same as any other manual upload).
- Result card shows a status pill (Active / Superseded / Possibly Superseded / Unable to Determine),
  the superseding document's title/date/source/type with a clickable link to its original source,
  a mechanism badge (explicit reference vs. content match), and section citations for content matches.

### Compliance Check

- Upload an internal policy/process PDF; it's compared against the indexed regulatory corpus.
- Findings come back as `compliant` (plain statements, no severity) and `nonCompliant`/`missing`
  findings, each tagged with a severity (`Critical`/`High`/`Medium`), a rationale, and a suggested
  remediation.
- The full report can be exported as a PDF, color-coded and sorted by severity
  (`SEVERITY_PDF_COLOR`, `SEVERITY_ORDER` in `server.js`).

### Ask (AI Assistant)

- RAG-based Q&A over the indexed corpus, citing source documents directly.
- Recency-sensitive questions (matched via `RECENCY_QUERY_RE`) sort candidate documents
  newest-first before retrieval.
- Supersession status is injected into the retrieval context (`supersessionContextLine()`) and
  into the synthesis prompt, so an answer about a superseded document is phrased as uncertain
  rather than stated as current fact.
- A superseding document mentioned in the answer text but not already cited is added to the
  citation list as a deterministic backstop; the final citation list is deduplicated by document ID.
- "Sources cited" render as clickable links whenever the underlying document has a URL, matching
  Check Validity's citation style.

---

## 4. How to Start the Server (Windows)

### Standard start (each new PowerShell session)

```powershell
# If Node.js is not on PATH yet (needed when PATH wasn't set at install time):
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# Set required env vars for this session — see README.md for the full list:
$env:ANTHROPIC_API_KEY = "sk-ant-your-key-here"
$env:DEMO_USER = "your-username"
$env:DEMO_PASSWORD = "your-password"

# Navigate to the cloned repo and start:
cd path\to\regulatory-monitor-100
node server.js
```

Open **http://localhost:3000** in a browser — every route, including the frontend itself, is
gated behind HTTP Basic Auth, so it will prompt for the `DEMO_USER`/`DEMO_PASSWORD` credentials
before loading anything.

### Stop the server

Press `Ctrl+C` in the terminal window running `node server.js`, or:

```powershell
Stop-Process -Name "node" -Force
```

### First-time setup (only once)

```powershell
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
cd path\to\regulatory-monitor-100
npm install
node server.js
```

### Reset all scraped data (fresh start)

```powershell
# Clears all stored items, chunks, and seen IDs — next scrape treats everything as new.
# -Encoding ascii avoids a UTF-8 BOM that would otherwise corrupt the JSON on read.
'{"seenIds":[],"items":[],"chunks":[]}' | Out-File -FilePath "data\store.json" -Encoding ascii
```

---

## 5. Possible Future Enhancements

- [ ] Add SEBI pagination to fetch full history per category
- [ ] Scrape prior-year RBI circulars via year-specific URLs
- [ ] Add date extraction for RBI Press Releases
- [ ] Add PM2 or Windows Task Scheduler for auto-restart on reboot
- [ ] Add more sources: IRDAI, MCA (Ministry of Corporate Affairs), FEMA notifications
- [ ] "Mark as read" or "archive" per item
- [ ] Export filtered results to CSV
- [ ] Re-run Claude analysis on demand for a specific item
- [ ] Retroactive excerpt generation when new keywords are added
- [ ] Extend Stage 1 Check Validity regex coverage for SEBI/IBBI reference formats
- [ ] Scale the deployed instance to the full 1,000+ document corpus (bigger instance and/or a real database, not flat JSON)
