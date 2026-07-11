// ================================================================
// Project Expenses → Actual Spend Sync
// Vercel Serverless Function
//
// Routes:
//   POST /api/expenses/sync    (webhook: subitem column change / create)
//   POST /api/expenses/recalc  (status trigger: manual recalculate)
//
// Recalc flow (button chain):
//   1. User clicks "Recalculate Spend" button
//   2. Automation sets "Sync Expenses" status → "Recalculate"
//   3. User-created automation fires this webhook on status change
//   4. Endpoint sums expenses, writes Actual Spend, resets status → blank
//
// Webhook triggers (on parent board 18417272549):
//   - change_subitem_column_value
//   - create_subitem
//
// NOTE: monday.com has no delete_subitem webhook event.
// Zero out Amount before deleting, or hit the Recalculate Spend button.
//
// Boards:
//   Project Expenses parent:  18417272549
//   Projects:                 18415679761
//
// Columns:
//   Expenses → Project relation: board_relation_mm46qsc5
//   Subitem Amount:              numeric_mm4799q6
//   Projects Actual Spend:       numeric_mm3xrd3e
//   Projects Sync Expenses:      color_mm55zfv7
// ================================================================

const MONDAY_API_KEY      = process.env.MONDAY_API_KEY;
const MONDAY_API_URL      = 'https://api.monday.com/v2';
const PROJECTS_BOARD_ID   = '18415679761';
const EXPENSES_BOARD_ID   = '18417272549';
const ACTUAL_SPEND_COL    = 'numeric_mm3xrd3e';
const SYNC_STATUS_COL     = 'color_mm55zfv7';
const AMOUNT_COL          = 'numeric_mm4799q6';
const PROJECT_RELATION    = 'board_relation_mm46qsc5';

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

// ── Shared: sum subitems and write Actual Spend ──────────────────
async function recalcForExpenseItem(expenseItemId) {
  const fetchResult = await mondayQuery(
    `query($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${PROJECT_RELATION}"]) {
          ... on BoardRelationValue { linked_item_ids }
        }
        subitems {
          id
          column_values(ids: ["${AMOUNT_COL}"]) {
            ... on NumbersValue { number }
          }
        }
      }
    }`,
    { itemId: [expenseItemId.toString()] }
  );

  const expenseItem = fetchResult.data?.items?.[0];
  if (!expenseItem) throw new Error(`Expense item ${expenseItemId} not found`);

  const linkedIds = expenseItem.column_values?.[0]?.linked_item_ids || [];
  if (linkedIds.length === 0) return { skipped: true, reason: 'No linked project' };

  const projectId  = linkedIds[0];
  const subitems   = expenseItem.subitems || [];
  const totalSpend = subitems.reduce((sum, s) => {
    const n = s.column_values?.[0]?.number;
    return sum + (typeof n === 'number' ? n : 0);
  }, 0);
  const rounded = Math.round(totalSpend * 100) / 100;

  await mondayQuery(
    `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`,
    {
      boardId: PROJECTS_BOARD_ID,
      itemId:  projectId.toString(),
      values:  JSON.stringify({ [ACTUAL_SPEND_COL]: rounded })
    }
  );

  console.log(`✅ Actual Spend → $${rounded} on project ${projectId} (${subitems.length} lines)`);
  return { projectId, totalSpend: rounded, expenseCount: subitems.length };
}

// ── Reset Sync Expenses status to blank ─────────────────────────
async function resetSyncStatus(projectId) {
  try {
    await mondayQuery(
      `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
      }`,
      {
        boardId: PROJECTS_BOARD_ID,
        itemId:  projectId.toString(),
        values:  JSON.stringify({ [SYNC_STATUS_COL]: { "label": "" } })
      }
    );
    console.log(`🔄 Sync Expenses status reset to blank for project ${projectId}`);
  } catch (e) {
    // Non-fatal — don't fail the whole request if reset fails
    console.warn(`⚠️ Failed to reset sync status: ${e.message}`);
  }
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

  // ── ROUTE: recalc (triggered by Sync Expenses status change) ──
  if (route === 'recalc') {
    const projectId = event.pulseId || event.itemId;
    if (!projectId) {
      return res.status(400).json({ success: false, error: 'Missing project item ID' });
    }
    console.log(`🔄 Manual recalc triggered for project: ${projectId}`);

    try {
      // Find the expense parent item linked to this project
      const searchResult = await mondayQuery(`
        query {
          items_page(
            board_id: ${EXPENSES_BOARD_ID},
            limit: 1,
            query_params: {
              rules: [{
                column_id: "${PROJECT_RELATION}",
                compare_value: ["${projectId}"],
                operator: any_of
              }]
            }
          ) {
            items { id name }
          }
        }
      `);

      const expenseItems = searchResult.data?.items_page?.items || [];

      if (expenseItems.length === 0) {
        console.warn(`⚠️ No expense item found for project ${projectId} — writing $0`);
        await mondayQuery(
          `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
            change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
          }`,
          {
            boardId: PROJECTS_BOARD_ID,
            itemId:  projectId.toString(),
            values:  JSON.stringify({ [ACTUAL_SPEND_COL]: 0 })
          }
        );
        await resetSyncStatus(projectId);
        return res.status(200).json({ success: true, projectId, totalSpend: 0, expenseCount: 0 });
      }

      const result = await recalcForExpenseItem(expenseItems[0].id);
      await resetSyncStatus(projectId);
      return res.status(200).json({ success: true, ...result });

    } catch (err) {
      console.error('❌ Recalc failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── ROUTE: sync (triggered by subitem webhook) ────────────────
  // Skip if changed column is not Amount (Vendor, Category, Notes, etc.)
  if (event.columnId && event.columnId !== AMOUNT_COL) {
    console.log(`⏭️ Skipping — column ${event.columnId} is not Amount`);
    return res.status(200).json({ success: true, skipped: true, reason: 'Non-amount column change' });
  }

  const parentExpenseItemId = event.parentItemId;
  if (!parentExpenseItemId) {
    console.error('❌ No parentItemId in payload:', JSON.stringify(event));
    return res.status(400).json({ success: false, error: 'Missing parentItemId' });
  }

  console.log(`📥 Expense sync triggered — expense item: ${parentExpenseItemId}`);

  try {
    const result = await recalcForExpenseItem(parentExpenseItemId);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Expense sync failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
