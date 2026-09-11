# Regulatory Monitor

An AI-powered regulatory intelligence platform that aggregates, indexes, and cross-checks circulars, notifications, and directions from RBI, SEBI, and IBBI in one place.

Built as a proof of concept by two lawyers who needed it themselves.

---

## The Problem

A lot of legal work cuts across more than one regulator at once — commercial paper is governed by both RBI and SEBI; a restructuring can touch RBI, SEBI, and IBBI together. Each regulator only publishes on its own site, so there's no easy way to track or verify updates across all three, especially where subject matter overlaps. A research task that would ordinarily mean checking three separate portals by hand can be done in one search here.

There's a second, sharper problem underneath that: once you're looking at an old circular or direction, it's genuinely hard to know whether it's still valid. Regulators don't always flag supersession clearly — sometimes a newer document explicitly repeals the old one, but often it just restates the same substance without ever naming what it replaces. No lawyer can be fully certain a circular hasn't been quietly superseded without manually cross-checking every later notification on the same subject — and that manual check is exactly what most practitioners don't have time for.

---

## What It Does

- **Cross-regulator search** — scrapes and indexes RBI, SEBI, and IBBI documents into one searchable corpus, with full-text search across document content (not just titles) and the ability to filter by regulator or search across all three at once.

- **Check Validity** — a two-stage supersession checker for any circular, notification, or direction. Stage 1 does deterministic reference matching: it extracts a document's own reference number and any references it explicitly repeals, and resolves that bidirectionally against the rest of the corpus regardless of which document was added first. Stage 2 is an on-demand semantic check, using Claude to catch documents that were superseded in substance without ever being named — it flags the likely superseding document, a confidence level, and the matching section/clause correspondence.

- **Email Alerts** — personalized digests, not one fixed mailing list. Each subscriber sets their own keywords and/or a plain-English description of what they care about. Matching runs on both a keyword substring match and a Claude-assisted semantic match against newly scraped documents, and every alert shows exactly *why* it matched — the specific keyword that hit, or a one-sentence reason for a semantic match.

- **AI Assistant** — ask plain-English regulatory questions and get answers with citations linked directly to the source document (RAG-based, grounded in indexed content). Recency-sensitive questions are detected and answered from the newest relevant documents first, and supersession status is factored into the answer — if the most relevant document has been superseded, the assistant says so rather than presenting it as current.

- **Compliance Check** — upload an internal policy or process document and check it against the indexed regulatory corpus. Findings come back tagged by severity (Critical / High / Medium) with a rationale and suggested remediation language for each, and the full report can be exported as a PDF.

- **Add Document** — grow the corpus directly: paste a regulator URL or upload a PDF, and it's fetched, parsed, chunked, and indexed the same way a scraped document is. Duplicate documents are caught before ingestion (by URL, parsed reference number, or exact title match), and manually-added documents persist permanently rather than aging out.

---

## Tech Stack

- **Backend:** Node.js + Express, in a single `server.js` file — no framework beyond Express, no build step
- **Storage:** Flat JSON files (`data/store.json`, `data/config.json`) — no database
- **AI:** Anthropic Claude API — powers semantic subscriber matching, the RAG-based AI Assistant, Compliance Check analysis, and Check Validity's Stage 2 semantic supersession check
- **Retrieval:** Custom lexical/IDF-weighted chunk scoring — no embeddings
- **Scraping:** Cheerio for HTML parsing, pdf-parse for PDF text extraction
- **Email:** Nodemailer, per-subscriber SMTP delivery
- **Frontend:** Plain HTML, CSS, and JavaScript — no framework

---

## Current Limitations

This is a proof of concept, not production software:

- **Not production-ready** — built by two lawyers, not engineers, for their own use first.
- **The public demo deployment runs a curated ~100-document sample**, sized to fit free-tier hosting memory limits. The full pipeline has been built and tested locally against 1,000+ real documents — scaling the deployed instance to the full dataset is an infrastructure step (a bigger instance, a persistent disk, or a real database), not a redesign.
- **No persistent disk on the free-tier deployment** — production use at real scale would need an actual database, not flat JSON files.
- **Compliance Check needs further validation against expert review** before any lawyer should rely on its output as-is.
- **Flat-file storage means no multi-user support** in its current form — it's built around a single shared corpus and configuration file, not per-user accounts or permissions.

---

## Running Locally

```bash
git clone https://github.com/sujayagrawal2008-spec/regulatory-monitor-100.git
cd regulatory-monitor-100
npm install
```

Set environment variables (see the table below for the full list — at minimum, you need `ANTHROPIC_API_KEY` for AI features):

```bash
export ANTHROPIC_API_KEY="your-key-here"
```

Start the server:

```bash
npm start
```

Open `http://localhost:3000` in your browser. Every route — including the frontend itself — is gated behind HTTP Basic Auth, so you'll also need `DEMO_USER`/`DEMO_PASSWORD` set before anything loads.

### Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes, for AI features | Powers summaries, the AI Assistant, Compliance Check, and Check Validity's Stage 2 semantic check |
| `DEMO_USER` / `DEMO_PASSWORD` | Yes | HTTP Basic Auth credentials gating every route, including the static frontend |
| `SMTP_ENABLED` | For email alerts | Set to `true` to enable sending |
| `SMTP_HOST` / `SMTP_PORT` | Optional | Defaults to `smtp.gmail.com` / `465` |
| `SMTP_USER` / `SMTP_PASS` | For email alerts | Sender Gmail address and Gmail App Password (not your real password) |
| `DATA_DIR` | Optional | Path to a persistent disk mount, if one is attached. Defaults to `./data`, which is ephemeral without one |
| `APP_URL` | Optional | Public URL used in email footer links — set this explicitly in production, it isn't auto-detected |
| `SKIP_STARTUP_SCRAPE` | Optional | Set to `true` on memory-constrained deployments to skip the startup scrape, the periodic scrape, and background backfill jobs, and just serve the existing store as-is |

---

## Built By

Sujay Agrawal and Neharika Modgil - two Banking & Finance lawyers who built this because we needed it. Neither of us are engineers.
