# Regulatory Monitor

An AI-powered regulatory intelligence platform that aggregates circulars and notifications from RBI, SEBI, and IBBI into a single searchable interface.

Built as a proof of concept by two lawyers who needed it themselves.

---

## The Problem

RBI, SEBI, and IBBI publish hundreds of circulars every year across three separate portals. Official websites only allow search by document title - so a circular on debenture trustee compliance may never appear in a search for NCD compliance, even if the content is directly relevant. A research task that would ordinarily take 45–60 minutes across three portals can be completed in under 5 minutes with full-text search.

---

## What It Does

- **Full-text search** across all indexed documents - searches inside the content of every circular, not just titles
- **AI Intelligence Search** - ask plain English questions and get cited answers linked to the source document (RAG-based, no hallucination)
- **Document Q&A mode** - select a specific regulation and ask questions answered strictly from that document
- **Document Validity Checker** - for any circular/notification/direction (existing or freshly uploaded), checks whether it has been repealed or superseded. Stage 1 does deterministic regex matching against explicit repeal references (bidirectional - works regardless of which document arrives first); Stage 2 is an on-demand Claude semantic check that catches supersession by content overlap even when there's no explicit citation, and returns the matching section/clause correspondence
- **Compliance Checker** - upload a policy/process document and check it against the indexed regulatory corpus
- **Per-subscriber email alerts** - each subscriber sets their own keywords and/or a plain-English description of what they care about; matching is keyword-based and Claude-assisted semantic matching, run against every newly scraped document
- **Cross-regulator filtering** - search across all three regulators simultaneously or filter by source
- **Source verification** - every AI answer links directly to the official regulator webpage and source PDF
- **Manual document uploads persist permanently** - the auto-scraped corpus is capped at 1,000 items (oldest scraped items age out first), but any document you manually upload is exempt from that cap and survives restarts indefinitely

---

## Tech Stack

- **Backend:** Node.js, Express
- **Scraping:** Cheerio (HTML parsing), pdf-parse (PDF text extraction)
- **AI Layer:** Anthropic Claude API (claude-haiku-4-5) with custom RAG pipeline - powers summaries, AI Assistant chat, Document Q&A, Compliance Checker, and Validity Checker Stage 2
- **Chunking:** Custom - 500–800 words per chunk, 100-word overlap, lexical/IDF-weighted retrieval (no embeddings)
- **Reference extraction:** Custom regex patterns for RBI/SEBI/IBBI reference-number formats, with bidirectional repeal-reference resolution across the store
- **Concurrency:** In-process async mutex around store.json read-modify-write cycles to prevent lost updates between concurrent scrapes, uploads, and background backfill jobs
- **Scheduling:** node-cron (scrape every 2 hours), plus self-rescheduling background backfill jobs for chunking and reference extraction on the existing corpus
- **Alerts:** Nodemailer with Gmail SMTP, per-subscriber recipient list (not a single fixed address)
- **Frontend:** HTML, CSS, JavaScript

---

## Current Limitations

This is a proof of concept. Known limitations:

- Dataset is a curated sample (~1000 auto-scraped documents across RBI, SEBI, IBBI, plus any manually uploaded documents) - not a full scrape
- Document Validity Checker's Stage 1 regex patterns are tuned primarily for RBI reference formats; SEBI/IBBI matching is best-effort
- Email alert delivery not fully automated
- No mobile-optimised interface
- AI search accuracy depends on chunk retrieval quality - not production-ready

---

## Running Locally

```bash
git clone https://github.com/sujayagrawal2008-spec/regulatory-monitor.git
cd regulatory-monitor
npm install
```

Set environment variables:

```bash
export ANTHROPIC_API_KEY="your-key-here"
```

Start the server:

```bash
npm start
```

Open `http://localhost:3000` in your browser.

---

## Recent Changes (Sep 10–11, 2026)

- **Email Alerts** — Preview block is now fully static (no backend dependency, renders even with the server stopped), the delivery-settings panel is collapsed by default, and digest emails now include a "Why this matched" line showing the actual matched keyword or Claude's one-sentence semantic-match reason.
- **Ask feature** — Recency-sensitive questions (e.g. "latest," "current") are now detected and candidate documents are sorted newest-first; supersession status is injected into the retrieval context so answers about a superseded circular are phrased as uncertain rather than stated as current fact.
- **Check Validity** — Two-stage supersession checking: Stage 1 runs deterministic regex extraction of a document's own reference number and any references it explicitly repeals, matched bidirectionally against the rest of the corpus regardless of ingestion order; Stage 2 is an on-demand Claude semantic check for supersession by content overlap when there's no explicit citation.
- **Compliance Check** — Findings are now tagged with a severity tier (Critical / High / Medium) with a rationale and suggested remediation, and the exported PDF report is color-coded and sorted by severity.
- **Add Document reliability** — Manual URL/PDF ingestion now reuses the same fetch/extraction logic as the scraper (including detection of SEBI pages that embed the actual document as a PDF inside an iframe rather than in the page HTML), and duplicate documents are now caught before ingestion by URL, parsed reference number, or exact title match.
- **Source citations** — "Sources cited" in Ask answers now render as clickable links consistently (matching Check Validity's citation style); citation lists are deduplicated by document ID.

---

## Built By

Sujay Agrawal and Neharika Modgil - two Banking & Finance lawyers who built this because we needed it. Neither of us are engineers.
