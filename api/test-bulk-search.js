/**
 * Flex Bulk Search — Diagnostic Test Endpoint
 *
 * Tests whether GET /api/search with a broad prefix can pull all
 * upcoming events from Flex, and reports the shape of what comes back.
 * No data is written to monday.com — read-only Flex call only.
 * 
 * Hit via: GET /api/test-bulk-search
 * Optional query params:
 *   ?prefix=26-        (default: "26-")
 *   ?maxResults=100    (default: 100)
 *   ?includeClosed=false (default: false — only open/upcoming)
 * 
 * Returns a structured report of what Flex has available.
 */

const FLEX_BASE_URL = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY  = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;

// Domain classification — matches your existing create-project-from-quote logic
function classifyDomain(result) {
  const domain = (result.domainId || result.domain || result.type || '').toLowerCase();
  if (['equipment-list', 'pull-sheet', 'pullsheet'].includes(domain))         return 'equipment-list';
  if (['project', 'event-folder', 'event_folder', 'folder'].includes(domain)) return 'event-folder';
  if (['quote', 'financial-document', 'financial_document', 'financialdocument'].includes(domain)) return 'quote';
  return domain || 'unknown';
}

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const prefix       = req.query.prefix       || '26-';
  const maxResults   = parseInt(req.query.maxResults || '100', 10);
  const includeClosed = req.query.includeClosed === 'true'; // default false = upcoming only

  console.log(`[test-bulk-search] Searching Flex for prefix="${prefix}", maxResults=${maxResults}, includeClosed=${includeClosed}`);

  if (!FLEX_API_KEY) {
    return res.status(500).json({ error: 'FLEX_API_KEY not set in environment' });
  }

  try {
    const searchUrl = `${FLEX_BASE_URL}/api/search?` + new URLSearchParams({
      searchText:      prefix,
      searchTypes:     'all',
      maxResults:      String(maxResults),
      includeDeleted:  'false',
      includeClosed:   String(includeClosed)
    });

    console.log(`[test-bulk-search] Flex URL: ${searchUrl}`);

    const searchRes = await fetch(searchUrl, {
      headers: {
        'X-Auth-Token':   FLEX_API_KEY,
        'Accept':         'application/json',
        'Content-Type':   'application/json'
      }
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      return res.status(searchRes.status).json({
        error:   'Flex API returned an error',
        status:  searchRes.status,
        details: errText
      });
    }

    const raw = await searchRes.json();

    // Flex sometimes wraps results in .content or returns a bare array
    const results = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.content)
        ? raw.content
        : Array.isArray(raw?.results)
          ? raw.results
          : [];

    // ── Classify results ──────────────────────────────────────────
    const classified = {
      quotes:          [],
      eventFolders:    [],
      equipmentLists:  [],
      unknown:         []
    };

    for (const r of results) {
      const type = classifyDomain(r);
      const entry = {
        id:          r.id || r.elementId || r.uuid || null,
        name:        r.name || r.displayName || '(no name)',
        domain:      r.domainId || r.domain || r.type || null,
        classifiedAs: type
      };

      if (type === 'quote')          classified.quotes.push(entry);
      else if (type === 'event-folder') classified.eventFolders.push(entry);
      else if (type === 'equipment-list') classified.equipmentLists.push(entry);
      else classified.unknown.push(entry);
    }

    // ── Summary ───────────────────────────────────────────────────
    const summary = {
      searchPrefix:       prefix,
      includeClosed:      includeClosed,
      maxResultsRequested: maxResults,
      totalRawResults:    results.length,
      hitLimit:           results.length >= maxResults, // true = there are more — need pagination
      breakdown: {
        quotes:         classified.quotes.length,
        eventFolders:   classified.eventFolders.length,
        equipmentLists: classified.equipmentLists.length,
        unknown:        classified.unknown.length
      },
      classified, // full detail for inspection
      rawSample: results.slice(0, 3) // first 3 raw results so you can see the exact shape
    };

    console.log(`[test-bulk-search] ✅ Done — ${results.length} results: ${classified.quotes.length} quotes, ${classified.eventFolders.length} folders, ${classified.equipmentLists.length} eqlists, ${classified.unknown.length} unknown`);

    return res.status(200).json(summary);

  } catch (error) {
    console.error('[test-bulk-search] Error:', error);
    return res.status(500).json({ error: 'Test failed', details: error.message });
  }
}
