// ================================================================
// Project Expenses → Actual Spend Sync
// Vercel Serverless Function
//
// Triggers (all on parent board 18417272549):
//   - change_subitem_column_value  (amount edited)
//   - create_subitem               (new expense line added)
//
// NOTE: monday.com has no delete_subitem webhook event. If a crew
// member deletes an expense line, set Amount to $0 first, then
// delete — or use the recalc button (if added) to force a refresh.
//
// Flow:
//   1. Receive event → extract parentItemId (the expense parent item)
//   2. For column-change events, skip if changed column ≠ Amount
//   3. Fetch expense parent → get linked Project + all subitem Amounts
//   4. Sum amounts → write to Actual Spend on Projects board
//
// Boards:
//   Project Expenses parent:  18417272549
//   Expense subitems:         18417275867
//   Projects:                 18415679761
//
// Columns:
//   Expenses → Project relation: board_relation_mm46qsc5
//   Subitem Amount:              numeric_mm4799q6
//   Projects Actual Spend:       numeric_mm3xrd3e
// ================================================================

const MONDAY_API_KEY    = process.env.MONDAY_API_KEY;
const MONDAY_API_URL    = 'https://api.monday.com/v2';
const PROJECTS_BOARD_ID = '18415679761';
const ACTUAL_SPEND_COL  = 'numeric_mm3xrd3e';
const AMOUNT_COL        = 'numeric_mm4799q6';
const PROJECT_RELATION  = 'board_relation_mm46qsc5';

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

// ── Main handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // monday webhook challenge handshake
  if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body?.event || req.body || {};

  // ── Early exit: column changed but it wasn't Amount ────────────
  // monday fires change_subitem_column_value for ALL subitem column
  // edits (vendor, category, notes, etc.). Skip non-Amount changes.
  if (event.columnId && event.columnId !== AMOUNT_COL) {
    console.log(`⏭️ Skipping — column ${event.columnId} is not Amount`);
    return res.status(200).json({ success: true, skipped: true, reason: 'Non-amount column change' });
  }

  // parentItemId is the expense parent item on board 18417272549
  const parentExpenseItemId = event.parentItemId;

  if (!parentExpenseItemId) {
    console.error('❌ No parentItemId in payload:', JSON.stringify(event));
    return res.status(400).json({ success: false, error: 'Missing parentItemId' });
  }

  console.log(`📥 Expense sync triggered — expense item: ${parentExpenseItemId}`);

  try {
    // ── STEP 1: Fetch expense parent + all subitem amounts ───────
    const fetchResult = await mondayQuery(
      `query($itemId: [ID!]) {
        items(ids: $itemId) {
          id
          name
          column_values(ids: ["${PROJECT_RELATION}"]) {
            ... on BoardRelationValue {
              linked_item_ids
            }
          }
          subitems {
            id
            column_values(ids: ["${AMOUNT_COL}"]) {
              ... on NumbersValue {
                number
              }
            }
          }
        }
      }`,
      { itemId: [parentExpenseItemId.toString()] }
    );

    const expenseItem = fetchResult.data?.items?.[0];
    if (!expenseItem) {
      console.error(`❌ Expense item ${parentExpenseItemId} not found`);
      return res.status(404).json({ success: false, error: 'Expense item not found' });
    }

    // ── STEP 2: Get linked project ───────────────────────────────
    const relationCol = expenseItem.column_values?.[0];
    const linkedIds   = relationCol?.linked_item_ids || [];

    if (linkedIds.length === 0) {
      console.warn(`⚠️ Expense item ${parentExpenseItemId} has no linked project — skipping`);
      return res.status(200).json({ success: true, skipped: true, reason: 'No linked project' });
    }

    const projectId = linkedIds[0];
    console.log(`🔗 Linked project: ${projectId}`);

    // ── STEP 3: Sum all subitem amounts ──────────────────────────
    const subitems   = expenseItem.subitems || [];
    const totalSpend = subitems.reduce((sum, subitem) => {
      const amount = subitem.column_values?.[0]?.number;
      return sum + (typeof amount === 'number' ? amount : 0);
    }, 0);

    const rounded = Math.round(totalSpend * 100) / 100;
    console.log(`💰 ${subitems.length} expense line(s) → $${rounded}`);

    // ── STEP 4: Write Actual Spend to Projects board ─────────────
    await mondayQuery(
      `mutation($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id:  $itemId,
          column_values: $values
        ) { id }
      }`,
      {
        boardId: PROJECTS_BOARD_ID,
        itemId:  projectId.toString(),
        values:  JSON.stringify({ [ACTUAL_SPEND_COL]: rounded })
      }
    );

    console.log(`✅ Actual Spend → $${rounded} on project ${projectId}`);
    return res.status(200).json({
      success: true,
      projectId,
      totalSpend: rounded,
      expenseCount: subitems.length
    });

  } catch (err) {
    console.error('❌ Expense sync failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
