# Regulatory Monitor — Project Summary

> Last updated: September 2026
> Status: **Fully operational**

---

## 1. What This Project Does

**Regulatory Monitor** is a local web application that automatically tracks new circulars,
notifications, press releases, and other publications from three Indian financial regulators:

| Source | What is scraped |
|---|---|
| **RBI** — Reserve Bank of India | Circulars, Press Releases, Notifications, Master Directions, Master Circulars, Speeches |
| **SEBI** — Securities and Exchange Board of India | Circulars, Press Releases, Consultation Papers, Speeches & Public Notices |
| **IBBI** — Insolvency and Bankruptcy Board of India | All publications from the homepage ticker (Press Releases, Circulars, Orders, Discussion Papers, Notifications, Regulations, Agenda/Minutes) |

Every 2 hours the server fetches all three sources, identifies new items it has not seen before,
stores them, and emails every subscriber whose keywords or saved interest description match.

For each newly discovered document, **Anthropic Claude** (`claude-haiku-4-5`) downloads the full PDF
or HTML text and produces:
- A **plain English summary** of what the document says and what a lawyer needs to know
- **In-document keyword excerpts** — the actual sentence from inside the document where each
  of the user's saved keywords appears
- Indexed chunks for retrieval-augmented search (AI Assistant chat, Document Q&A, Compliance Checker)
- **Stage 1 reference extraction** — what reference number this document has, and what earlier
  reference numbers (if any) it explicitly repeals/supersedes

Beyond scraping and alerting, the app also has an on-demand **Document Validity Checker**: pick
any indexed document (or upload a new PDF) and check whether it's still active, been explicitly
repealed (Stage 1, regex-based, instant), or been superseded in substance by a later document even
without an explicit citation (Stage 2, Claude semantic check, run on demand).

The application runs entirely on `localhost` (or optionally on Render for a public URL).
No database, no Python, no build step — all storage is local JSON files.

**Primary user:** A legal or compliance professional who needs to stay on top of regulatory
publications relevant to their practice areas without manually visiting each regulator's website.

---

## 2. File Structure

```
G:\Legal AI\
│
├── server.js               # Express backend — all scraping, AI, scheduling, API, email
├── package.json            # npm dependencies
├── package-lock.json       # Locked dependency versions
├── .gitignore              # Excludes data/, node_modules/, .env
├── .env.example            # Documents every environment variable required
├── PROJECT_SUMMARY.md      # This file
│
├── public\
│   └── index.html          # Complete frontend — single-file, no framework, no build step
│
└── data\                   # Created automatically on first run; excluded from git
    ├── store.json          # All scraped + manually-uploaded items, chunks, and list of every seen item ID
    └── config.json         # Saved keywords, per-subscriber alert list, and email SMTP sender settings
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
| `parseOwnReference()` / `extractRepealReferences()` / `resolveReferencesForItem()` | Document Validity Checker Stage 1: find this doc's own reference number(s), find what it explicitly repeals, bidirectionally match against every other item in the store |
| `findSupersessionCandidates()` / `checkContentSupersession()` / `runStage2Check()` | Document Validity Checker Stage 2: retrieve same-source later-dated candidates via the existing chunk scoring, ask Claude to judge content supersession and cite matching sections |
| `backfillReferencesBatch()` / `scheduleReferenceBackfill()` | Background job applying Stage 1 to the pre-existing corpus, 7 items per batch, self-rescheduling; permanently-failing items are marked `refExtractionFailed` so they don't retry forever |
| `matchSubscriberKeywords()` / Claude-assisted description matching | Per-subscriber alert matching: keyword substring match or semantic match against a subscriber's free-text description |
| `buildSubscriberEmailHtml()` / `dispatchSubscriberAlerts()` | Constructs and sends one branded HTML email per matching subscriber (source badges, type, date, links) |
| `runScrape()` | Full scrape cycle: fetch all sources → deduplicate → cap via `capStoreItems()` → Claude analysis → Stage 1 reference resolution → `dispatchSubscriberAlerts()` |
| `ingestDocument()` | Shared ingestion path for manual URL/PDF uploads (including Validity Checker uploads) — sets `addedManually: true`, runs Claude analysis, chunking, and Stage 1 inline |
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
| cron | `node-cron` schedule `0 */2 * * *` — fires at the top of every even hour |

---

## 3. Data Schemas

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
  ]
}
```

**`seenIds`** — flat array of every item ID ever fetched. An item in this list will never be
emailed again, even if it is re-fetched. This is the sole deduplication mechanism.

**`ai`** — present only on items that were new during a scrape when `GROQ_API_KEY` was set.
Items scraped without the key have no `ai` field; they show no summary on the dashboard.

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

`addedManually: true` is set on any document added via URL, PDF upload, or the Validity Checker's
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
  "subscribers": [
    {
      "id": "sub_abc123",
      "email": "user@example.com",
      "keywords": ["NBFC", "stamp duty"],
      "description": "Anything relevant to debenture trustee compliance",
      "createdAt": "..."
    }
  ],
  "email": {
    "enabled": true,
    "host":    "smtp.gmail.com",
    "port":    465,
    "user":    "sender@gmail.com",
    "pass":    "app-password-here"
  },
  "lastScraped": "2026-06-06T14:10:56.527Z"
}
```

Email credentials in this file are overridden by `SMTP_*` environment variables when set — this is
the **sender** account only. Alert **recipients** are the `subscribers` array, each with their own
keyword list and/or free-text description; matching is keyword substring match OR a Claude semantic
match against the description, run per newly-scraped item during each scrape cycle. There is no
single fixed recipient anymore (the old `email.to` / `SMTP_TO` field has been removed).

---

## 4. Features — Complete List

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
return empty HTML when fetched server-side).

**IBBI (homepage SPA, 2025+ only):**
- All content lives in `<ul class="activityTicker">` on the homepage
- Link text format: `"DDth Month, YYYY Type: Title (filesize)"`
- Types classified by regex: Press Release, Circular, Order, Discussion Paper, Notification,
  Agenda/Minutes, Regulation, Notice
- Items older than 2025 are excluded to keep the list manageable

**Total items scraped in a typical run: ~981**
(RBI: ~466 · SEBI: ~100 · IBBI: ~415)

### Scheduling

- Cron fires at `0 */2 * * *` — top of every even hour (00:00, 02:00, 04:00…)
- First scrape runs 2 seconds after server start
- "Scrape Now" button in the dashboard header triggers an immediate scrape

### Deduplication

- Each item gets a stable ID: `source_type_base64(url+title).slice(0,100)`
- All seen IDs are written to `store.json → seenIds` permanently
- On each scrape, only items whose ID is not in `seenIds` are treated as new
- New items are stored and eligible for Groq analysis and email alerts
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
5. **Chunking** — text split into 500–800 word chunks with 100-word overlap and indexed for the lexical/IDF-weighted retrieval that powers AI Assistant chat, Document Q&A, and Compliance Checker.
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
- Stat cards: Showing / Total / RBI / SEBI / IBBI counts
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
2. Groq 3-sentence summary (italic, left-bordered — only on AI-analysed items)
3. "📄 Found in document" section — keyword chip + highlighted excerpt from document text (only when keywords were found inside the full document text)
4. Meta row: source badge (RBI amber / SEBI blue / IBBI green), type badge, date, keyword match badges, fetch time

### Email Alerts (per-subscriber)

- Each subscriber (managed in the Email Alerts tab) has their own email, optional keyword list,
  and/or a free-text description of what they care about — there is no single fixed recipient.
- Matching per subscriber per new item: keyword substring match on title/text, **or** a Claude
  semantic match of the item against the subscriber's description (batched per scrape cycle).
- Sends HTML email via Nodemailer, one email per matching subscriber, with a branded header and
  a table of matching items (source badge, type, date, clickable title).
- Email footer links to the live app URL (uses `APP_URL` env var; set this manually on Render).
- Subscribers can be added/edited/removed via `/api/subscribers` CRUD endpoints; a "Send Test"
  action per subscriber uses up to 3 real stored items.
- Only fires for items that are both (a) new this scrape and (b) match a given subscriber's
  keywords or description.

### Document Validity Checker

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

---

## 5. Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | v24.16.0 |
| Web framework | Express | ^4.18.2 |
| HTML scraping | Cheerio | ^1.0.0 |
| HTTP client | Axios | ^1.6.2 |
| PDF text extraction | pdf-parse | ^1.1.1 |
| File uploads | multer | ^2.1.1 |
| AI inference | @anthropic-ai/sdk | ^0.102.0 |
| AI model | claude-haiku-4-5 (Anthropic) | — |
| Scheduling | node-cron | ^3.0.3 |
| Email | Nodemailer | ^6.9.7 |
| CORS | cors | ^2.8.5 |
| Frontend | Plain HTML + Vanilla JS | — |
| Storage | Local JSON files | — |

No database. No build tool. No frontend framework. The entire UI is one `index.html` file.

---

## 6. Environment Variables

All variables are optional for local development (the app falls back to `config.json` values).
On Render or any cloud host, set these in the dashboard.

| Variable | Required? | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes, for AI features** | Anthropic API key starting with `sk-ant-`. Get one at https://console.anthropic.com/settings/keys. Powers summaries, AI Assistant chat, Document Q&A, Compliance Checker, and Validity Checker Stage 2. The user runs their own server with this key set in their own terminal session — it is never pasted into chat. |
| `DEMO_USER` | **Yes, for public deployment** | Username for the HTTP Basic Auth gate that sits in front of every route, including the static frontend. |
| `DEMO_PASSWORD` | **Yes, for public deployment** | Password for the same Basic Auth gate. |
| `SMTP_ENABLED` | Optional | Set to `true` to enable email alerts (overrides config.json) |
| `SMTP_HOST` | Optional | SMTP server hostname, e.g. `smtp.gmail.com` |
| `SMTP_PORT` | Optional | SMTP port, e.g. `465` for SSL |
| `SMTP_USER` | Optional | Sender email address / SMTP username |
| `SMTP_PASS` | Optional | SMTP password or Gmail App Password |
| `DATA_DIR` | Optional | Path to data directory. Set to your Render persistent disk's mount path if you've added one (e.g. `/data`). Defaults to `./data`, which is ephemeral on Render without a disk. |
| `PORT` | Set by Render | Render injects this automatically. Do not set manually on Render. |
| `APP_URL` | Optional | Public URL of the app (used in email footer links). Set this manually to your `https://<service>.onrender.com` URL — Render does not auto-populate an equivalent to Railway's old `RAILWAY_PUBLIC_DOMAIN`, so without it, footer links fall back to `http://localhost:<port>`. |

### Gmail setup

Use a **Gmail App Password** (not your real password):
1. Enable 2-Step Verification on your Google account
2. Go to: Google Account → Security → App Passwords
3. Create a new app password — copy the 16-character code
4. Use `smtp.gmail.com`, port `465`, your Gmail address, and the app password

### Local `.env` file (optional)

Create `G:\Legal AI\.env` (excluded from git via `.gitignore`) and put your variables there.
The app does not load `.env` automatically — you set env vars in your shell or use PowerShell
as shown below. The `.env.example` file documents all available variables.

---

## 7. How to Start the Server (Windows)

### Standard start (each new PowerShell session)

```powershell
# If Node.js is not on PATH yet (needed when PATH wasn't set at install time):
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH

# Set Groq API key for this session:
$env:GROQ_API_KEY = "gsk_your_key_here"

# Navigate and start:
cd "G:\Legal AI"
node server.js
```

Open **http://localhost:3000** in a browser.

### Stop the server

Press `Ctrl+C` in the terminal window running `node server.js`, or:

```powershell
Stop-Process -Name "node" -Force
```

### First-time setup (only once)

```powershell
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
cd "G:\Legal AI"
npm install
node server.js
```

### Reset all scraped data (fresh start)

```powershell
# Clears all stored items and seen IDs — next scrape treats everything as new
'{"seenIds":[],"items":[]}' | Out-File -FilePath "G:\Legal AI\data\store.json" -Encoding utf8
```

---

## 8. Render Deployment

Render is the current deploy target (this repo previously targeted Railway; `railway.json` and
that setup have been removed).

**One-time setup steps:**

1. Push code to GitHub (credentials excluded via `.gitignore`)
2. Create a new **Web Service** on Render → connect the GitHub repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Set environment variables in the Render dashboard (see Section 6) — at minimum
   `ANTHROPIC_API_KEY` and `DEMO_USER`/`DEMO_PASSWORD` (required now that Basic Auth gates every
   route). Set `APP_URL` to the `https://<service>.onrender.com` URL Render assigns once the first
   deploy completes.
6. (Optional) Add a Render **persistent disk** if you want `data/store.json` and `data/config.json`
   to survive redeploys and restarts — without one, Render's filesystem is ephemeral and all
   scraped/uploaded data resets on every deploy. If added, set `DATA_DIR` to the disk's mount path.

Render runs the Node.js process continuously; `node-cron` inside the process fires the scraper
every 2 hours automatically. No separate worker or cron service needed.

Early history (initial commit through the Groq→Claude switch and first AI features) is summarised
above; run `git log --oneline` for the full, current commit history. The repo is connected to
`https://github.com/sujayagrawal2008-spec/regulatory-monitor` on branch `master`.

---

## 9. Known Issues and Limitations

| Issue | Detail |
|---|---|
| **RBI Press Release dates missing** | The RBI press release listing page has no date column. Items show no date on the dashboard. Fetching dates would require one HTTP request per press release (~71 extra requests per scrape). Not implemented. |
| **RBI shows current financial year only** | `BS_CircularIndexDisplay.aspx` shows only the current year's circulars (2026-27). Prior years are on separate pages not currently scraped. |
| **SEBI capped at ~25 items per section** | SEBI's DataTable returns one page of results. Only the most recent ~25 items per category are fetched. Pagination not implemented. |
| **SEBI Orders/Regulations inaccessible** | SEBI's Orders, Regulations, and Informal Guidance pages are JavaScript-rendered and return empty HTML when fetched server-side. Cannot be scraped with Cheerio. |
| **Claude analyses only ~20 new items inline per scrape** | The rest are picked up asynchronously by the background chunk/reference backfill jobs, which self-reschedule until the whole store is covered — so full coverage lags a live scrape rather than being immediate. |
| **Excerpts only for future new items** | Keyword excerpts are generated at scrape time using keywords saved at that moment. If you add a new keyword later, old items will not retroactively get excerpts for it. |
| **No auto-restart on machine reboot** | No process manager (PM2, Windows Task Scheduler, etc.) is configured. If the machine or terminal restarts, you must manually run `node server.js` again (with `ANTHROPIC_API_KEY` set in that session). |
| **Stage 1 reference regex tuned for RBI** | SEBI/IBBI reference-number formats are matched best-effort; explicit repeal detection is most reliable for RBI documents. |
| **`@google/generative-ai` and `groq-sdk` still in dependencies** | Both were used by earlier AI integrations, now fully replaced by `@anthropic-ai/sdk`. They remain in `package.json` but are unused. Safe to remove with `npm uninstall @google/generative-ai groq-sdk`. |

---

## 10. Possible Future Enhancements

- [ ] Remove unused `@google/generative-ai` and `groq-sdk` dependencies
- [ ] Add SEBI pagination to fetch full history per category
- [ ] Scrape prior-year RBI circulars via year-specific URLs
- [ ] Add date extraction for RBI Press Releases
- [ ] Add PM2 or Windows Task Scheduler for auto-restart on reboot
- [ ] Add more sources: IRDAI, MCA (Ministry of Corporate Affairs), FEMA notifications
- [ ] "Mark as read" or "archive" per item
- [ ] Export filtered results to CSV
- [ ] Re-run Claude analysis on demand for a specific item
- [ ] Retroactive excerpt generation when new keywords are added
- [ ] Extend Stage 1 validity-checker regex coverage for SEBI/IBBI reference formats
- [ ] Connect to GitHub and push to a hosting platform for a live public URL

---

## 11. Recent Changes (Sep 10–11, 2026)

- **Email Alerts** — Preview block in the Email Alerts tab is now fully static frontend content with no backend dependency (verifiable with the server stopped); delivery-settings panel is collapsed by default; digest emails now include a "Why this matched" line, combining `matchesSubscriberKeywords()`'s actual matched keyword(s) and/or the one-sentence reason already returned by the semantic-match Claude call — no second LLM call added.
- **Ask feature recency/supersession awareness** — Recency-sensitive queries are detected via keyword pattern; candidate documents are sorted newest-first for those queries; supersession status is injected into the RAG context and into the synthesis prompt so a low-confidence supersession is phrased as uncertain rather than asserted; a deterministic backstop ensures a superseding document mentioned in the answer text is also included in the citation list.
- **Add Document reliability fixes** — Manual URL/PDF ingestion (`ingestDocument()`) now reuses `fetchFullTextForItem()`, the same extraction function the scraper uses, instead of separate fetch logic; this function now also detects SEBI pages that embed the real document as a PDF inside an `iframe[src*="file="]` rather than in the page's own HTML. Three duplicate checks run before ingestion: exact URL match, parsed-reference-number match, and exact normalised-title match (`findDuplicateByTitle()`) — the last one catches the same document added twice via different ingestion paths (e.g. upload vs. URL-paste), which can't collide on URL or reference number alone.
- **Source citation fixes** — "Sources cited" in Ask answers render as clickable links whenever the underlying document has a URL (matching Check Validity's citation style), rather than falling back to plain text based on document type; the citation list is deduplicated by document ID as a defense-in-depth measure against the same document being cited twice.
