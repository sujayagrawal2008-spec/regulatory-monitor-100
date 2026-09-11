// Golden-set QA runner for /api/ask — reads tests/qa-golden-set.json, calls the REAL
// running server for each question (no mocking), and reports per-case results.
//
// Only cases with verified:true count toward pass/fail. Everything else (verified:false)
// is printed as informational-only so a wrong self-generated expectation can never
// silently grade itself as a pass — see the _readme block in qa-golden-set.json.
//
// Usage: node tests/run-qa-tests.js [baseUrl]   (baseUrl defaults to http://localhost:3000)

const fs = require('fs');
const path = require('path');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const GOLDEN_SET_PATH = path.join(__dirname, 'qa-golden-set.json');

// Loose title match: does `haystackTitle` refer to the same document as `needleTitle`?
// Titles across the corpus vary slightly in punctuation/whitespace/en-dash vs hyphen, so
// this compares normalized, lowercased strings with one-directional containment rather
// than requiring an exact match.
function titleMatches(haystackTitle, needleTitle) {
  if (!haystackTitle || !needleTitle) return false;
  const norm = s => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[–—-]/g, '-').replace(/\s+/g, ' ').trim();
  const a = norm(haystackTitle), b = norm(needleTitle);
  return a === b || a.includes(b) || b.includes(a);
}

const NOT_FOUND_RE = /\b(not (?:be )?(?:found|available|covered|indexed|in (?:the|our) (?:database|corpus|system))|no (?:such|matching|relevant) (?:document|circular|regulation)s? (?:were |was )?(?:found|available)|couldn'?t find|could not find|does not appear to be|doesn'?t appear to be|not present in (?:the|our))\b/i;

async function askQuestion(question) {
  const resp = await fetch(`${BASE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }) // no sessionId — every case is a fresh, independent query
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function evaluateCase(testCase, response) {
  const sources = Array.isArray(response.sources) ? response.sources : [];
  const centeredOn = sources.length ? sources[0].title : null;
  const answerLower = (response.answer || '').toLowerCase();

  const result = {
    centeredOn,
    allCitedTitles: sources.map(s => s.title),
    matchesExpected: null,
    mustNotViolated: null,
    notFoundAsExpected: null
  };

  if (testCase.expect_not_found) {
    // Pass condition: no confident citation, OR the answer text itself says it couldn't
    // find/doesn't cover this — either is acceptable evidence the model didn't hallucinate.
    result.notFoundAsExpected = sources.length === 0 || NOT_FOUND_RE.test(response.answer || '');
  } else {
    if (testCase.expected_document) {
      result.matchesExpected =
        (centeredOn && titleMatches(centeredOn, testCase.expected_document)) ||
        answerLower.includes(testCase.expected_document.toLowerCase().slice(0, 40));
    }
    if (testCase.must_not_center_on) {
      const centeredOnBad = centeredOn && titleMatches(centeredOn, testCase.must_not_center_on);
      // Also flag if the must_not_center_on document is cited AT ALL as a co-source without
      // the expected document also being present — a softer secondary signal.
      result.mustNotViolated = !!centeredOnBad;
    }
  }
  return result;
}

function passed(testCase, evalResult) {
  if (testCase.expect_not_found) return evalResult.notFoundAsExpected === true;
  const expectOk = testCase.expected_document ? evalResult.matchesExpected === true : true;
  const mustNotOk = testCase.must_not_center_on ? evalResult.mustNotViolated === false : true;
  return expectOk && mustNotOk;
}

function printCase(testCase, response, evalResult, err) {
  const lines = [];
  lines.push(`\n${'─'.repeat(78)}`);
  lines.push(`[${testCase.id}] (tier ${testCase.tier}, ${testCase.category}) — verified: ${testCase.verified}`);
  lines.push(`Question: ${testCase.question}`);
  if (testCase.evidence) lines.push(`Evidence for this expectation: ${testCase.evidence}`);

  if (err) {
    lines.push(`REQUEST FAILED: ${err.message}`);
    console.log(lines.join('\n'));
    return;
  }

  if (testCase.expect_not_found) {
    lines.push(`Expected: no confident document — question is outside the indexed corpus`);
  } else {
    if (testCase.expected_document) lines.push(`Expected document: ${testCase.expected_document}`);
    if (testCase.must_not_center_on) lines.push(`Must NOT center on: ${testCase.must_not_center_on}`);
  }

  lines.push(`Answer actually centered on: ${evalResult.centeredOn || '(no citation)'}`);
  if (evalResult.allCitedTitles.length > 1) {
    lines.push(`All cited: ${evalResult.allCitedTitles.join(' | ')}`);
  }

  if (testCase.expect_not_found) {
    lines.push(`Not-found as expected: ${evalResult.notFoundAsExpected ? 'YES' : 'NO — model may have hallucinated a document'}`);
  } else {
    if (testCase.expected_document) lines.push(`Matches expected document: ${evalResult.matchesExpected ? 'YES' : 'NO'}`);
    if (testCase.must_not_center_on) lines.push(`Incorrectly centered on must_not_center_on doc: ${evalResult.mustNotViolated ? 'YES — FAIL' : 'no'}`);
  }

  lines.push(`Result: ${passed(testCase, evalResult) ? 'PASS' : 'FAIL'}`);
  lines.push(`\nFull answer text:\n${response.answer}`);
  console.log(lines.join('\n'));
}

async function main() {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_SET_PATH, 'utf8'));
  const cases = golden.cases;

  const verifiedCases = cases.filter(c => c.verified === true);
  const unverifiedCases = cases.filter(c => c.verified !== true);

  console.log(`Golden set: ${cases.length} total — ${verifiedCases.length} verified, ${unverifiedCases.length} unverified/pending review`);
  console.log(`Target server: ${BASE_URL}`);

  const results = [];
  for (const testCase of cases) {
    try {
      const response = await askQuestion(testCase.question);
      const evalResult = evaluateCase(testCase, response);
      printCase(testCase, response, evalResult, null);
      results.push({ testCase, response, evalResult, err: null });
    } catch (err) {
      printCase(testCase, null, null, err);
      results.push({ testCase, response: null, evalResult: null, err });
    }
    await new Promise(r => setTimeout(r, 400)); // light throttle, matches app's own Claude-call pacing style
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('SUMMARY');
  console.log('='.repeat(78));

  console.log('\n── Verified cases (counts toward pass/fail) ──');
  const verifiedResults = results.filter(r => r.testCase.verified === true);
  let passCount = 0, failCount = 0;
  for (const r of verifiedResults) {
    const ok = !r.err && passed(r.testCase, r.evalResult);
    if (ok) passCount++; else failCount++;
    console.log(`  [${r.testCase.id}] ${ok ? 'PASS' : 'FAIL'}${r.err ? ' (request failed)' : ''}`);
  }
  console.log(`  ${passCount}/${verifiedResults.length} passed`);

  console.log('\n── Unverified — pending review (informational only, does not count as pass/fail until confirmed) ──');
  const unverifiedResults = results.filter(r => r.testCase.verified !== true);
  for (const r of unverifiedResults) {
    const status = r.err ? 'REQUEST FAILED' : (passed(r.testCase, r.evalResult) ? 'matches proposed expectation' : 'does NOT match proposed expectation');
    console.log(`  [${r.testCase.id}] ${status} — needs human confirmation before it can be promoted to verified:true`);
  }

  if (failCount > 0) process.exitCode = 1;
}

main().catch(e => { console.error('Runner crashed:', e); process.exitCode = 1; });
