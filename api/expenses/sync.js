// ================================================================
// Project Expenses + Work Order Sessions → Actual Spend Sync
// Vercel Serverless Function
//
// Routes:
//   POST /api/expenses/sync      (webhook: expense subitem column change / create)
//   POST /api/expenses/recalc    (status trigger: manual recalculate from project)
//   POST /api/expenses/wo-sync   (webhook: WO session subitem column change / create)
//   POST /api/expenses/wo-recalc (webhook: WO parent item — manual recalc from work order)
//
// Actual Spend = Project Expense Line Items + Work Order Session Expenses (combined)
//
// Recalc flow (button chain on Projects board):
//   1. User clicks "Recalculate Spend" button on a project
//   2. Automation sets "Sync Expenses" status → "Recalculate"
//   3. Automation fires this webhook (?route=recalc) on status change
//   4. Endpoint sums ALL sources, writes Actual Spend, resets status → blank
//
// WO Session flow:
//   1. Shop crew logs a session subitem on a Work Order (Hours + Expenses)
//   2. Automation fires this webhook (?route=wo-sync) on subitem create/change
//   3. Endpoint sums all sessions → updates WO Actual Hours + Total Session Expenses
//   4. Looks up linked Project → recalculates full Actual Spend for that project
//
// NOTE: monday.com has no delete_subitem webhook event.
// Zero out amount/hours before deleting, or use the Recalculate Spend button.
//
// Boards:
//   Project Expenses parent:       18417272549
//   Projects:                      18415679761
//   Work Orders:                   18415824268
//
// Columns — Project Expenses:
//   Expense → Project relation:    board_relation_mm46qsc5
//   Subitem Amount:                numeric_mm4799q6
//
// Columns — Work Orders:
//   WO → Project relation:         board_relation_mm3xdc15
//   WO Actual Hours:               numeric_mm3ypet2
//   WO Total Session Expenses:     numeric_mm5a3zhg
//
// Columns — WO Session Subitems:
//   Hours Worked:                  numeric_mm5awwer
//   Expenses ($):                  numeric_mm5ag36d
//
// Columns — Projects:
//   Actual Spend:                  numeric_mm3xrd3e
//   Sync Expenses status:          color_mm55zfv7
// ================================================================

const MONDAY_API_KEY           = process.env.MONDAY_API_KEY;
const MONDAY_API_URL           = 'https://api.monday.com/v2';

// Board IDs
const PROJECTS_BOARD_ID        = '18415679761';
const EXPENSES_BOARD_ID        = '18417272549';
const WORK_ORDERS_BOARD_ID     = '18415824268';

// Project Expenses columns
const EXPENSE_AMOUNT_COL       = 'numeric_mm4799q6';
const EXPENSE_PROJECT_RELATION = 'board_relation_mm46qsc5';

// Work Orders columns
const WO_PROJECT_RELATION      = 'board_relation_mm3xdc15';
const WO_ACTUAL_HOURS_COL      = 'numeric_mm3ypet2';
const WO_TOTAL_EXPENSES_COL    = 'numeric_mm5a3zhg';

// Work Order session subitem columns
const WO_SESSION_HOURS_COL     = 'numeric_mm5awwer';
const WO_SESSION_EXPENSES_COL  = 'numeric_mm5ag36d';

// Projects columns
const ACTUAL_SPEND_COL         = 'numeric_mm3xrd3e';
const SYNC_STATUS_COL          = 'color_mm55zfv7';


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


// ── SOURCE 1: Sum project expense line items for a project ───────
// Returns the total dollar amount from all expense subitems on the
// Project Expenses board that are linked to the given projectId.
async function getProjectExpensesTotal(projectId) {
  const result = await mondayQuery(`
    query {
      items_page(
        board_id: ${EXPENSES_BOARD_ID},
        limit: 1,
        query_params: {
          rules: [{
            column_id: "${EXPENSE_PROJECT_RELATION}",
            compare_value: ["${projectId}"],
            operator: any_of
          }]
        }
      ) {
        items {
          id
          subitems {
            column_values(ids: ["${EXPENSE_AMOUNT_COL}"]) {
              ... on NumbersValue { number }
            }
          }
        }
      }
    }
  `);

  const expenseItems = result.data?.items_page?.items || [];
  if (expenseItems.length === 0) {
    console.log(`ℹ️  No Project Expenses item found for project ${projectId} — contributing $0`);
    return 0;
  }

  const subitems = expenseItems[0].subitems || [];
  const total = subitems.reduce((sum, s) => {
    const n = s.column_values?.[0]?.number;
    return sum + (typeof n === 'number' ? n : 0);
  }, 0);

  console.log(`💰 Project Expenses total for project ${projectId}: $${total} (${subitems.length} lines)`);
  return total;
}


// ── SOURCE 2: Sum Work Order session expenses for a project ──────
// Finds all Work Orders linked to projectId, returns the sum of
// their Total Session Expenses columns.
async function getWorkOrderExpensesTotal(projectId) {
  const result = await mondayQuery(`
    query {
      items_page(
        board_id: ${WORK_ORDERS_BOARD_ID},
        limit: 100,
        query_params: {
          rules: [{
            column_id: "${WO_PROJECT_RELATION}",
            compare_value: ["${projectId}"],
            operator: any_of
          }]
        }
      ) {
        items {
          id
          name
          column_values(ids: ["${WO_TOTAL_EXPENSES_COL}"]) {
            ... on NumbersValue { number }
          }
        }
      }
    }
  `);

  const workOrders = result.data?.items_page?.items || [];
  if (workOrders.length === 0) {
    console.log(`ℹ️  No Work Orders found for project ${projectId} — contributing $0`);
    return 0;
  }

  const total = workOrders.reduce((sum, wo) => {
    const n = wo.column_values?.[0]?.number;
    return sum + (typeof n === 'number' ? n : 0);
  }, 0);

  console.log(`🔧 Work Order expenses total for project ${projectId}: $${total} (${workOrders.length} WOs)`);
  return total;
}


// ── MASTER: Recalculate full Actual Spend for a project ──────────
// Sums both sources and writes the combined total to Actual Spend.
// This is the single source of truth for project spend.
async function recalcProjectActualSpend(projectId) {
  const [expensesTotal, woExpensesTotal] = await Promise.all([
    getProjectExpensesTotal(projectId),
    getWorkOrderExpensesTotal(projectId)
  ]);

  const combined = Math.round((expensesTotal + woExpensesTotal) * 100) / 100;

  await mondayQuery(
    `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`,
    {
      boardId: PROJECTS_BOARD_ID,
      itemId:  projectId.toString(),
      values:  JSON.stringify({ [ACTUAL_SPEND_COL]: combined })
    }
  );

  console.log(`✅ Actual Spend updated → $${combined} for project ${projectId} (expenses: $${expensesTotal} + WO sessions: $${woExpensesTotal})`);
  return { projectId, totalSpend: combined, expensesTotal, woExpensesTotal };
}


// ── WO: Recalculate session totals on a Work Order ───────────────
// Sums all session subitems on a single Work Order and writes back
// Actual Hours and Total Session Expenses to the parent WO item.
// Returns { projectId } so the caller can then update Actual Spend.
async function recalcWorkOrderSessions(workOrderItemId) {
  const result = await mondayQuery(
    `query($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
        column_values(ids: ["${WO_PROJECT_RELATION}"]) {
          ... on BoardRelationValue { linked_item_ids }
        }
        subitems {
          id
          column_values(ids: ["${WO_SESSION_HOURS_COL}", "${WO_SESSION_EXPENSES_COL}"]) {
            id
            ... on NumbersValue { number }
          }
        }
      }
    }`,
    { itemId: [workOrderItemId.toString()] }
  );

  const wo = result.data?.items?.[0];
  if (!wo) throw new Error(`Work Order item ${workOrderItemId} not found`);

  const linkedIds = wo.column_values?.[0]?.linked_item_ids || [];
  const projectId = linkedIds.length > 0 ? linkedIds[0] : null;

  const subitems = wo.subitems || [];
  let totalHours    = 0;
  let totalExpenses = 0;

  for (const subitem of subitems) {
    for (const col of subitem.column_values) {
      if (col.id === WO_SESSION_HOURS_COL    && typeof col.number === 'number') totalHours    += col.number;
      if (col.id === WO_SESSION_EXPENSES_COL && typeof col.number === 'number') totalExpenses += col.number;
    }
  }

  // Round hours to nearest quarter hour
  totalHours    = Math.round(totalHours * 4) / 4;
  totalExpenses = Math.round(totalExpenses * 100) / 100;

  // Write both rollup columns back to the Work Order parent
  await mondayQuery(
    `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`,
    {
      boardId: WORK_ORDERS_BOARD_ID,
      itemId:  workOrderItemId.toString(),
      values:  JSON.stringify({
        [WO_ACTUAL_HOURS_COL]:    totalHours,
        [WO_TOTAL_EXPENSES_COL]:  totalExpenses
      })
    }
  );

  console.log(`🔧 WO ${wo.name} (${workOrderItemId}): ${totalHours}hrs | $${totalExpenses} across ${subitems.length} sessions`);
  return { workOrderItemId, totalHours, totalExpenses, sessionCount: subitems.length, projectId };
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
        values:  JSON.stringify({ [SYNC_STATUS_COL]: { label: '' } })
      }
    );
    console.log(`🔄 Sync Expenses status reset to blank for project ${projectId}`);
  } catch (e) {
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

  // ────────────────────────────────────────────────────────────────
  // ROUTE: recalc
  // Triggered by "Sync Expenses" status change on the Projects board
  // (button → automation → webhook). Recalculates ALL spend sources
  // for the project and resets the status trigger.
  // ────────────────────────────────────────────────────────────────
  if (route === 'recalc') {
    const projectId = event.pulseId || event.itemId;
    if (!projectId) return res.status(400).json({ success: false, error: 'Missing project item ID' });

    console.log(`🔄 Manual recalc triggered for project: ${projectId}`);
    try {
      const result = await recalcProjectActualSpend(projectId);
      await resetSyncStatus(projectId);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Project recalc failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // ROUTE: sync
  // Triggered by a subitem create or column change on the Project
  // Expenses board. Recalculates full project Actual Spend (both
  // expense lines AND work order sessions).
  // Skip if changed column is not the Amount column.
  // ────────────────────────────────────────────────────────────────
  if (!route || route === 'sync') {
    if (event.columnId && event.columnId !== EXPENSE_AMOUNT_COL) {
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
      // Find which project this expense item is linked to
      const fetchResult = await mondayQuery(
        `query($itemId: [ID!]) {
          items(ids: $itemId) {
            column_values(ids: ["${EXPENSE_PROJECT_RELATION}"]) {
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }`,
        { itemId: [parentExpenseItemId.toString()] }
      );

      const linkedIds = fetchResult.data?.items?.[0]?.column_values?.[0]?.linked_item_ids || [];
      if (linkedIds.length === 0) {
        console.warn(`⚠️ Expense item ${parentExpenseItemId} has no linked project — skipping`);
        return res.status(200).json({ success: true, skipped: true, reason: 'No linked project' });
      }

      const result = await recalcProjectActualSpend(linkedIds[0]);
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('❌ Expense sync failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // ROUTE: wo-sync
  // Triggered by a session subitem create or column change on the
  // Work Orders subitems board. Only fires if the changed column is
  // Hours Worked or Expenses ($) — ignore everything else.
  // Flow: sum sessions → update WO parent → recalc project spend
  // ────────────────────────────────────────────────────────────────
  if (route === 'wo-sync') {
    const relevantCols = [WO_SESSION_HOURS_COL, WO_SESSION_EXPENSES_COL];

    // Skip non-financial column changes (notes, photos, docs, etc.)
    if (event.columnId && !relevantCols.includes(event.columnId)) {
      console.log(`⏭️ WO sync — skipping non-financial column: ${event.columnId}`);
      return res.status(200).json({ success: true, skipped: true, reason: 'Non-financial column change' });
    }

    const workOrderItemId = event.parentItemId;
    if (!workOrderItemId) {
      console.error('❌ wo-sync: No parentItemId in payload:', JSON.stringify(event));
      return res.status(400).json({ success: false, error: 'Missing parentItemId (Work Order ID)' });
    }

    console.log(`🔧 WO session sync triggered — Work Order: ${workOrderItemId}`);
    try {
      const woResult = await recalcWorkOrderSessions(workOrderItemId);

      if (!woResult.projectId) {
        console.warn(`⚠️ Work Order ${workOrderItemId} has no linked project — WO totals updated, project skipped`);
        return res.status(200).json({ success: true, ...woResult, projectSkipped: true });
      }

      const projectResult = await recalcProjectActualSpend(woResult.projectId);
      return res.status(200).json({ success: true, workOrder: woResult, project: projectResult });
    } catch (err) {
      console.error('❌ WO session sync failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // ROUTE: wo-recalc
  // Manual recalc triggered directly from a Work Order item
  // (e.g. a button or status automation on the Work Orders board).
  // Useful if someone deletes a session or bulk-edits hours.
  // Flow: sum sessions → update WO parent → recalc project spend
  // ────────────────────────────────────────────────────────────────
  if (route === 'wo-recalc') {
    const workOrderItemId = event.pulseId || event.itemId;
    if (!workOrderItemId) {
      return res.status(400).json({ success: false, error: 'Missing Work Order item ID' });
    }

    console.log(`🔄 Manual WO recalc triggered for Work Order: ${workOrderItemId}`);
    try {
      const woResult = await recalcWorkOrderSessions(workOrderItemId);

      if (!woResult.projectId) {
        console.warn(`⚠️ Work Order ${workOrderItemId} has no linked project — WO totals updated, project skipped`);
        return res.status(200).json({ success: true, ...woResult, projectSkipped: true });
      }

      const projectResult = await recalcProjectActualSpend(woResult.projectId);
      return res.status(200).json({ success: true, workOrder: woResult, project: projectResult });
    } catch (err) {
      console.error('❌ WO manual recalc failed:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Unknown route fallback
  // ────────────────────────────────────────────────────────────────
  console.warn(`⚠️ Unknown route: ${route}`);
  return res.status(400).json({ success: false, error: `Unknown route: ${route}` });
}
