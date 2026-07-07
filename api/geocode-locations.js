// api/geocode-locations.js
// Populates the Location column on the Contacts & Companies board
// by geocoding the Address (long_text) column via Nominatim.
//
// Vercel Hobby has a 60s timeout, so we process in batches of 40 unique addresses.
// Usage:
//   GET /api/geocode-locations?dryRun=true        → preview counts, no writes
//   GET /api/geocode-locations?batch=0            → process addresses 0-39
//   GET /api/geocode-locations?batch=1            → process addresses 40-79
//   ... repeat until response says done: true

export const config = { maxDuration: 60 };

const BOARD_ID = '18415573401';
const ADDRESS_COL = 'long_text_mm3vkzc6';
const LOCATION_COL = 'location_mm50h12r';
const BATCH_SIZE = 40;

// ── Monday.com API ────────────────────────────────────────────────────────────

async function mondayGQL(query, variables = {}) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.MONDAY_API_KEY,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Monday API HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function fetchAllItems() {
  const items = [];
  let cursor = null;

  do {
    let data;
    if (!cursor) {
      data = await mondayGQL(`{
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500) {
            cursor
            items { id column_values(ids: ["${ADDRESS_COL}"]) { id text } }
          }
        }
      }`);
      const page = data.boards?.[0]?.items_page;
      if (page?.items) items.push(...page.items);
      cursor = page?.cursor || null;
    } else {
      data = await mondayGQL(
        `query($cursor: String!) {
          next_items_page(limit: 500, cursor: $cursor) {
            cursor
            items { id column_values(ids: ["${ADDRESS_COL}"]) { id text } }
          }
        }`,
        { cursor }
      );
      const page = data.next_items_page;
      if (page?.items) items.push(...page.items);
      cursor = page?.cursor || null;
    }
  } while (cursor);

  return items;
}

// Update up to 20 items per mutation (GraphQL complexity limit)
async function updateLocationBatch(itemIds, geo) {
  const value = JSON.stringify({
    address: geo.address,
    lat: geo.lat,
    lng: geo.lng,
    countryShortName: geo.country,
  }).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const chunks = [];
  for (let i = 0; i < itemIds.length; i += 20) {
    chunks.push(itemIds.slice(i, i + 20));
  }

  for (const chunk of chunks) {
    const mutations = chunk
      .map((id, i) =>
        `m${i}: change_column_value(board_id: ${BOARD_ID}, item_id: ${id}, column_id: "${LOCATION_COL}", value: "${value}") { id }`
      )
      .join('\n');
    await mondayGQL(`mutation { ${mutations} }`);
  }
}

// ── Nominatim Geocoder ────────────────────────────────────────────────────────

function cleanAddress(raw) {
  let addr = raw.trim();

  // Take only first "line" if there are multiple (e.g. multi-address vendors)
  const lines = addr.split(/\n/);
  if (lines.length > 1) addr = lines[0].trim();

  // Strip parenthetical notes like "(Operated by ...)"
  addr = addr.replace(/\s*\(.*?\)\s*/g, '').trim();

  // Strip labels like "Corporate HQ: " or "Venue: " at start
  addr = addr.replace(/^[A-Za-z /]+:\s*/i, '').trim();

  return addr;
}

async function geocode(rawAddress) {
  const addr = cleanAddress(rawAddress);
  const params = new URLSearchParams({ q: addr, format: 'json', limit: '1', addressdetails: '1' });
  const url = `https://nominatim.openstreetmap.org/search?${params}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'AnticStudios/ShowFlow (matt.james@anticstudios.com)' },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();

  if (!data || data.length === 0) return null;
  const r = data[0];

  return {
    address: r.display_name,
    lat: String(r.lat),
    lng: String(r.lon),
    country: (r.address?.country_code || 'us').toUpperCase(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const batchNum = parseInt(req.query.batch ?? '0', 10);
  const isDryRun = req.query.dryRun === 'true';

  try {
    // 1. Fetch all items with an address
    const allItems = await fetchAllItems();
    const itemsWithAddr = allItems.filter((item) => {
      const col = item.column_values.find((c) => c.id === ADDRESS_COL);
      return col?.text?.trim();
    });

    // 2. Build unique-address → [item IDs] map
    const addrMap = {};
    for (const item of itemsWithAddr) {
      const addr = item.column_values.find((c) => c.id === ADDRESS_COL).text.trim();
      if (!addrMap[addr]) addrMap[addr] = [];
      addrMap[addr].push(item.id);
    }

    const uniqueAddrs = Object.keys(addrMap);
    const totalBatches = Math.ceil(uniqueAddrs.length / BATCH_SIZE);

    // 3. Dry run — just report stats
    if (isDryRun) {
      return res.json({
        ok: true,
        totalItems: allItems.length,
        itemsWithAddress: itemsWithAddr.length,
        uniqueAddresses: uniqueAddrs.length,
        totalBatches,
        batchSize: BATCH_SIZE,
        sampleAddresses: uniqueAddrs.slice(0, 8),
      });
    }

    // 4. Geocode the requested batch
    const start = batchNum * BATCH_SIZE;
    if (start >= uniqueAddrs.length) {
      return res.json({ ok: true, done: true, message: 'Nothing to process — batch offset beyond address list.' });
    }

    const batchAddrs = uniqueAddrs.slice(start, start + BATCH_SIZE);
    const geocoded = [];
    const failed = [];
    let itemsUpdated = 0;

    for (const addr of batchAddrs) {
      const ids = addrMap[addr];
      let geo = null;

      try {
        geo = await geocode(addr);
      } catch (err) {
        console.error(`Geocode error for "${addr}":`, err.message);
      }

      if (geo) {
        try {
          await updateLocationBatch(ids, geo);
          geocoded.push({ address: addr, lat: geo.lat, lng: geo.lng, itemCount: ids.length });
          itemsUpdated += ids.length;
        } catch (err) {
          console.error(`Update error for "${addr}":`, err.message);
          failed.push({ address: addr, reason: 'Monday update failed: ' + err.message });
        }
      } else {
        failed.push({ address: addr, reason: 'No geocode result' });
      }

      await sleep(1100); // Nominatim rate limit
    }

    const nextBatch = start + BATCH_SIZE < uniqueAddrs.length ? batchNum + 1 : null;

    return res.json({
      ok: true,
      batch: batchNum,
      addressesProcessed: batchAddrs.length,
      geocodedOk: geocoded.length,
      geocodedFailed: failed.length,
      itemsUpdated,
      failedAddresses: failed,
      nextBatch,
      totalBatches,
      done: nextBatch === null,
      message: nextBatch !== null
        ? `✅ Batch ${batchNum} done. Call ?batch=${nextBatch} to continue (${totalBatches - batchNum - 1} batch(es) remaining).`
        : '🎉 All batches complete! Location column fully populated.',
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
