/**
 * One-Shot Address Deduplication Cleanup
 *
 * Scans every contact in the Contacts & Companies board that has a Flex UUID,
 * fetches their address records from Flex, and deletes all duplicates —
 * keeping only the single "best" address per contact.
 *
 * Scoring to pick the best address:
 *   +3  defaultMailing === true
 *   +2  defaultShipping === true
 *   +1  per filled field (line1, city, stateOrProvince, postalCode, country)
 *   Ties broken by lowest ordinal, then earliest createdDate
 *
 * Safe to run multiple times — idempotent. Contacts with 0 or 1 address are skipped.
 * Delete this file after running — the push-to-flex.js fix prevents future dupes.
 *
 * Endpoints:
 *   GET  /api/contacts/cleanup-addresses            — dry run (shows what would be deleted)
 *   POST /api/contacts/cleanup-addresses            — live run (actually deletes)
 *   GET  /api/contacts/cleanup-addresses?page=2     — paginate (batchSize=25 per page)
 *
 * Author: Antic Studios — ShowFlow
 */

const MONDAY_API_URL    = 'https://api.monday.com/v2';
const MONDAY_API_KEY    = process.env.MONDAY_API_KEY;
const FLEX_BASE_URL     = process.env.FLEX_BASE_URL || 'https://anticstudios.flexrentalsolutions.com/f5';
const FLEX_API_KEY      = process.env.FLEX_API_KEY_QUOTES || process.env.FLEX_API_KEY;
const CONTACTS_BOARD_ID = '18415573401';
const FLEX_UUID_COL     = 'text_mm56w1vz';
const BATCH_SIZE        = 25; // Monday items per page
const FLEX_CONCURRENCY  = 5;  // parallel Flex requests per batch

// ================================================================
// Score an address — higher = better candidate to keep
// ================================================================
function scoreAddress(addr) {
  let score = 0;
  if (addr.defaultMailing)  score += 3;
  if (addr.defaultShipping) score += 2;
  const fields = ['line1', 'city', 'stateOrProvince', 'postalCode', 'country'];
  for (const f of fields) {
    if (addr[f] && addr[f].trim()) score += 1;
  }
  return score;
}

// ================================================================
// Pick the single best address from an array
// ================================================================
function pickBestAddress(addresses) {
  if (!addresses.length) return null;
  return addresses.slice().sort((a, b) => {
    const scoreDiff = scoreAddress(b) - scoreAddress(a);
    if (scoreDiff !== 0) return scoreDiff;
    // Tiebreak: lower ordinal first
    if (a.ordinal !== b.ordinal) return (a.ordinal ?? 999) - (b.ordinal ?? 999);
    // Tiebreak: earliest created first
    return new Date(a.createdDate || 0) - new Date(b.createdDate || 0);
  })[0];
}

// ================================================================
// Fetch addresses for a Flex contact
// ================================================================
async function fetchFlexAddresses(flexId) {
  try {
    const res = await fetch(
      `${FLEX_BASE_URL}/api/address/contact-addresses?contactId=${encodeURIComponent(flexId)}`,
      { headers: { 'X-Auth-Token': FLEX_API_KEY, 'Accept': 'application/json' } }
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, addresses: [] };
    const data = await res.json();
    return { ok: true, addresses: Array.isArray(data) ? data : [] };
  } catch (e) {
    return { ok: false, error: e.message, addresses: [] };
  }
}

// ================================================================
// Delete address records by ID array
// DELETE /api/address/contact-addresses/{contactId}  body: [id, ...]
// ================================================================
async function deleteAddresses(flexContactId, idsToDelete, dryRun) {
  if (!idsToDelete.length) return { deleted: 0, error: null };
  if (dryRun) return { deleted: idsToDelete.length, error: null, dryRun: true };

  try {
    const res = await fetch(
      `${FLEX_BASE_URL}/api/address/contact-addresses/${flexContactId}`,
      {
        method: 'DELETE',
        headers: {
          'X-Auth-Token': FLEX_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(idsToDelete),
      }
    );
    if (!res.ok) {
      const txt = await res.text();
      return { deleted: 0, error: `HTTP ${res.status}: ${txt}` };
    }
    return { deleted: idsToDelete.length, error: null };
  } catch (e) {
    return { deleted: 0, error: e.message };
  }
}

// ================================================================
// Process one contact — check addresses, delete dupes, return result
// ================================================================
async function processContact(name, flexId, dryRun) {
  const { ok, error, addresses } = await fetchFlexAddresses(flexId);

  if (!ok) {
    return { name, flexId, status: 'fetch_error', error, addressCount: 0, deleted: 0 };
  }

  if (addresses.length <= 1) {
    return { name, flexId, status: 'ok', addressCount: addresses.length, deleted: 0 };
  }

  // Pick the best one, delete the rest
  const best   = pickBestAddress(addresses);
  const extras = addresses.filter(a => a.id !== best.id).map(a => a.id);

  const { deleted, error: delError } = await deleteAddresses(flexId, extras, dryRun);

  return {
    name,
    flexId,
    status:       delError ? 'delete_error' : (dryRun ? 'would_delete' : 'cleaned'),
    addressCount: addresses.length,
    kept:         { id: best.id, line1: best.line1, city: best.city, score: scoreAddress(best) },
    deleted,
    error:        delError || null,
  };
}

// ================================================================
// Fetch one page of Monday contacts that have a Flex UUID
// ================================================================
async function getMondayContactsWithFlexId(cursor, limit) {
  // Filter: flexContactId is NOT empty
  const paginationClause = cursor
    ? `cursor: "${cursor}"`
    : `query_params: { rules: [{ column_id: "${FLEX_UUID_COL}", compare_value: [], operator: is_not_empty }] }`;

  const query = `
    query {
      boards(ids: [${CONTACTS_BOARD_ID}]) {
        items_page(limit: ${limit} ${paginationClause}) {
          cursor
          items {
            id
            name
            column_values(ids: ["${FLEX_UUID_COL}"]) { id text }
          }
        }
      }
    }
  `;

  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_API_KEY },
    body: JSON.stringify({ query }),
  });
  const result = await res.json();
  const page = result.data?.boards?.[0]?.items_page;
  if (!page) throw new Error(`Monday query failed: ${JSON.stringify(result.errors)}`);
  return {
    items:      page.items || [],
    nextCursor: page.cursor || null,
  };
}

// ================================================================
// Run contacts through Flex in small parallel batches
// ================================================================
async function processInChunks(contacts, dryRun) {
  const results = [];
  for (let i = 0; i < contacts.length; i += FLEX_CONCURRENCY) {
    const chunk = contacts.slice(i, i + FLEX_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(c => {
        const flexId = c.column_values.find(v => v.id === FLEX_UUID_COL)?.text?.trim();
        if (!flexId) return Promise.resolve({ name: c.name, flexId: null, status: 'no_uuid', deleted: 0 });
        return processContact(c.name, flexId, dryRun);
      })
    );
    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : { status: 'exception', error: r.reason?.message });
    }
  }
  return results;
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Use GET (dry run) or POST (live run)' });
  }

  // GET = dry run (shows what would be deleted, no changes made)
  // POST = live run (actually deletes)
  const dryRun = req.method === 'GET';
  const page   = parseInt(req.query?.page || '1');

  console.log(`\n🧹 cleanup-addresses | mode: ${dryRun ? 'DRY RUN' : 'LIVE'} | page: ${page}`);

  try {
    // Page through Monday contacts — use the page param to cursor through
    // (We store cursor in a simple loop since Vercel functions are stateless)
    let cursor = null;
    let pageNum = 0;

    // Advance to the requested page
    do {
      pageNum++;
      const { items, nextCursor } = await getMondayContactsWithFlexId(cursor, BATCH_SIZE);

      if (pageNum === page) {
        // This is the page we want — process it
        console.log(`📋 Page ${page}: ${items.length} contacts with Flex UUID`);

        const results = await processInChunks(items, dryRun);

        // Summarize
        const cleaned     = results.filter(r => r.status === 'cleaned');
        const wouldDelete = results.filter(r => r.status === 'would_delete');
        const clean       = results.filter(r => r.status === 'ok');
        const errors      = results.filter(r => r.status === 'fetch_error' || r.status === 'delete_error');
        const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);

        const hasMore = items.length === BATCH_SIZE && !!nextCursor;

        console.log(`✅ Page ${page} done | cleaned: ${cleaned.length + wouldDelete.length} | dupes removed: ${totalDeleted} | errors: ${errors.length} | hasMore: ${hasMore}`);

        return res.status(200).json({
          mode:         dryRun ? 'dry_run' : 'live',
          page,
          hasMore,
          nextPage:     hasMore ? page + 1 : null,
          summary: {
            contactsProcessed: results.length,
            alreadyClean:      clean.length,
            deduplicated:      cleaned.length + wouldDelete.length,
            addressesRemoved:  totalDeleted,
            errors:            errors.length,
          },
          detail: results,
        });
      }

      if (!nextCursor || items.length < BATCH_SIZE) {
        // Ran out of pages before reaching the requested one
        return res.status(200).json({
          mode: dryRun ? 'dry_run' : 'live',
          page,
          hasMore: false,
          nextPage: null,
          summary: { contactsProcessed: 0, alreadyClean: 0, deduplicated: 0, addressesRemoved: 0, errors: 0 },
          detail: [],
          message: `Only ${pageNum - 1} page(s) of data available`,
        });
      }

      cursor = nextCursor;
    } while (true);

  } catch (err) {
    console.error('❌ cleanup-addresses error:', err);
    return res.status(500).json({ error: err.message });
  }
}
