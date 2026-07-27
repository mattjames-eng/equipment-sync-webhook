// ================================================================
// Fabrication & Repair Projects — Cost Rollup Webhook
// Vercel Serverless Function
//
// Routes:
//   POST /api/fab-cost-rollup         (webhook: subitem column change)
//   POST /api/fab-cost-rollup?route=recalc  (manual recalc from parent item)
//
// Flow:
//   1. A shop tech logs/edits a work session subitem (Expenses, Duration, or Labor Rate)
//   2. Monday automation fires this webhook
//   3. Endpoint sums ALL subitems for the parent project:
//        materials_actual = SUM of subitem Expenses
//        labor_actual     = SUM of (Duration × Labor Rate) per subitem
//        total_actual     = materials_actual + labor_actual
//        total_estimate   = Materials Estimate + Labor Estimate (from parent)
//        variance         = total_estimate - total_actual (negative = over budget)
//   4. Writes Total Actual and Variance back to the parent project item
//
// NOTE: monday.com has no delete_subitem webhook event.
//   Zero out a session's hours/expenses before deleting it, or use
//   the Recalculate button on the parent project to force a full recalc.
//
// Board IDs:
//   FAB_BOARD_ID         = 18422080455   (parent Fabrication & Repair Projects)
//   FAB_SUBITEMS_BOARD_ID = 18422080481  (work session subitems)
//
// Parent columns:
//   Materials Estimate:  numeric_mm59sfsv
//   Labor Estimate:      numeric_mm595fdv
//   Total Actual:        numeric_mm5nwvwx
//   Variance:            numeric_mm5nzdqa
//
// Subitem columns:
//   Duration (hrs):      numeric_mm59ez2z
//   Labor Rate ($/hr):   numeric_mm5n7ms
//   Expenses ($):        numeric_mm5978t7
// ================================================================

const MONDAY_API_KEY            = process.env.MONDAY_API_KEY;
const MONDAY_API_URL            = 'https://api.monday.com/v2';

// Board IDs
const FAB_BOARD_ID              = '18422080455';
const FAB_SUBITEMS_BOARD_ID     = '18422080481';

// Parent item columns
const MATERIALS_ESTIMATE_COL    = 'numeric_mm59sfsv';
const LABOR_ESTIMATE_COL        = 'numeric_mm595fdv';
const TOTAL_ACTUAL_COL          = 'numeric_mm5nwvwx';
const VARIANCE_COL              = 'numeric_mm5nzdqa';

// Subitem columns
const DURATION_COL              = 'numeric_mm59ez2z';
const LABOR_RATE_COL            = 'numeric_mm5n7ms';
const EXPENSES_COL              = 'numeric_mm5978t7';

// Columns that should trigger a recalc when changed on a subitem
const WATCHED_SUBITEM_COLS      = [DURATION_COL, LABOR_RATE_COL, EXPENSES_COL];


// ── monday GraphQL helper ────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': MONDAY_API_KEY,
      'API-Version':   '2024-10'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (!res.ok)     throw new Error(`monday HTTP ${res.status}`);
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  return data;
}


// ── Recalculate and write back costs for a parent project item ───
async function recalcFabProject(parentItemId) {
  // Fetch parent item: estimates + all subitems with cost columns
  const result = await mondayQuery(
    `query($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${MATERIALS_ESTIMATE_COL}", "${LABOR_ESTIMATE_COL}"]) {
          id
          ... on NumbersValue { number }
        }
        subitems {
          id
          column_values(ids: ["${DURATION_COL}", "${LABOR_RATE_COL}", "${EXPENSES_COL}"]) {
            id
            ... on NumbersValue { number }
          }
        }
      }
    }`,
    { itemId: [parentItemId.toString()] }
  );

  const item = result.data?.items?.[0];
  if (!item) throw new Error(`Item ${parentItemId} not found`);

  // ── Read parent estimates ──────────────────────────────────────
  let materialsEstimate = 0;
  let laborEstimate     = 0;
  for (const col of item.column_values || []) {
    if (col.id === MATERIALS_ESTIMATE_COL && typeof col.number === 'number') materialsEstimate = col.number;
    if (col.id === LABOR_ESTIMATE_COL     && typeof col.number === 'number') laborEstimate     = col.number;
  }

  // ── Sum subitems ───────────────────────────────────────────────
  let materialsActual = 0;
  let laborActual     = 0;

  for (const subitem of item.subitems || []) {
    let duration  = 0;
    let laborRate = 0;
    let expenses  = 0;

    for (const col of subitem.column_values || []) {
      if (col.id === DURATION_COL   && typeof col.number === 'number') duration  = col.number;
      if (col.id === LABOR_RATE_COL && typeof col.number === 'number') laborRate = col.number;
      if (col.id === EXPENSES_COL   && typeof col.number === 'number') expenses  = col.number;
    }

    materialsActual += expenses;
    laborActual     += duration * laborRate;
  }

  // ── Calculate totals ───────────────────────────────────────────
  const totalEstimate = Math.round((materialsEstimate + laborEstimate) * 100) / 100;
  const totalActual   = Math.round((materialsActual   + laborActual)   * 100) / 100;
  const variance      = Math.round((totalEstimate     - totalActual)   * 100) / 100;

  console.log(`📊 ${item.name} (${parentItemId})`);
  console.log(`   Estimate  → Materials: $${materialsEstimate} | Labor: $${laborEstimate} | Total: $${totalEstimate}`);
  console.log(`   Actual    → Materials: $${materialsActual.toFixed(2)} | Labor: $${laborActual.toFixed(2)} | Total: $${totalActual}`);
  console.log(`   Variance  → $${variance} (${variance >= 0 ? 'under' : 'OVER'} budget)`);

  // ── Write back to parent ───────────────────────────────────────
  await mondayQuery(
    `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`,
    {
      boardId: FAB_BOARD_ID,
      itemId:  parentItemId.toString(),
      values:  JSON.stringify({
        [TOTAL_ACTUAL_COL]: totalActual,
        [VARIANCE_COL]:     variance
      })
    }
  );

  console.log(`✅ Written → Total Actual: $${totalActual} | Variance: $${variance}`);

  return {
    parentItemId,
    name: item.name,
    sessionCount: item.subitems?.length ?? 0,
    materialsEstimate,
    laborEstimate,
    totalEstimate,
    materialsActual: Math.round(materialsActual * 100) / 100,
    laborActual:     Math.round(laborActual * 100) / 100,
    totalActual,
    variance
  };
}


// ── Main handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (req.body?.challenge)      return res.status(200).json({ challenge: req.body.challenge });

  const route = req.query?.route;
  const event = req.body?.event || req.body || {};

  // ────────────────────────────────────────────────────────────────
  // ROUTE: recalc
  // Triggered manually from the parent project item (button or status).
  // Useful after deleting subitems or bulk-editing sessions.
  // ────────────────────────────────────────────────────────────────
  if (route === 'recalc') {
    const parentItemId = event.pulseId || event.itemId;
    if (!parentItemId) return res.status(400).json({ success: false, error: 'Missing item ID' });

    console.log(`🔄 Manual recalc triggered — project: ${parentItemId}`);
    try {
      const result = await recalcFabProject(parentItemId);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Manual recalc failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // ROUTE: default (subitem column change webhook)
  // Fires when Expenses, Duration, or Labor Rate changes on any
  // work session subitem under a Fab project.
  // Skip unrelated column changes to avoid unnecessary recalcs.
  // ────────────────────────────────────────────────────────────────
  if (event.columnId && !WATCHED_SUBITEM_COLS.includes(event.columnId)) {
    console.log(`⏭️ Skipping — column ${event.columnId} is not a cost column`);
    return res.status(200).json({ success: true, skipped: true, reason: 'Non-cost column change' });
  }

  const parentItemId = event.parentItemId;
  if (!parentItemId) {
    console.error('❌ No parentItemId in payload:', JSON.stringify(event));
    return res.status(400).json({ success: false, error: 'Missing parentItemId' });
  }

  console.log(`📥 Subitem cost change — parent project: ${parentItemId} | column: ${event.columnId || 'subitem created'}`);
  try {
    const result = await recalcFabProject(parentItemId);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Cost rollup failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
