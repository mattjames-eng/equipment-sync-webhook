// ================================================================
// Project Expenses → Actual Spend Sync
// Vercel Serverless Function
//
// Trigger: monday.com automation fires when any expense subitem
//          Amount column changes (create, update, delete).
//
// Flow:
//   1. Receive subitem event → extract parentItemId (expense item)
//   2. Fetch expense item → get linked Project ID + all subitem Amounts
//   3. Sum all Amounts
//   4. Write total to Actual Spend (numeric_mm3xrd3e) on Projects board
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

const MONDAY_API_KEY      = process.env.MONDAY_API_KEY;
const MONDAY_API_URL      = 'https://api.monday.com/v2';
const PROJECTS_BOARD_ID   = '18415679761';
const EXPENSES_BOARD_ID   = '18417272549';
const ACTUAL_SPEND_COL    = 'numeric_mm3xrd3e';
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

  // monday sends parentItemId for subitem events
  const parentExpenseItemId = event.parentItemId || event.pulseId;

  if (!parentExpenseItemId) {
    console.error('❌ No parentItemId in payload:', JSON.stringify(event));
    return res.status(400).json({ success: false, error: 'Missing parentItemId' });
  }

  console.log(`📥 Expense sync triggered — expense item: ${parentExpenseItemId}`);

  try {
    // ── STEP 1: Fetch the expense parent item ───────────────────
    // Get the linked project ID and all subitem amounts in one query
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

    // ── STEP 2: Extract linked project ID ───────────────────────
    const relationCol = expenseItem.column_values?.[0];
    const linkedIds   = relationCol?.linked_item_ids || [];

    if (linkedIds.length === 0) {
      console.warn(`⚠️ Expense item ${parentExpenseItemId} has no linked project — skipping`);
      return res.status(200).json({ success: true, skipped: true, reason: 'No linked project' });
    }

    const projectId = linkedIds[0];
    console.log(`🔗 Linked project: ${projectId}`);

    // ── STEP 3: Sum all subitem amounts ─────────────────────────
    const subitems  = expenseItem.subitems || [];
    const totalSpend = subitems.reduce((sum, subitem) => {
      const amountVal = subitem.column_values?.[0]?.number;
      return sum + (typeof amountVal === 'number' ? amountVal : 0);
    }, 0);

    const rounded = Math.round(totalSpend * 100) / 100;
    console.log(`💰 ${subitems.length} expense lines totalling $${rounded}`);

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

    console.log(`✅ Actual Spend updated → $${rounded} on project ${projectId}`);
    return res.status(200).json({ success: true, projectId, totalSpend: rounded, expenseCount: subitems.length });

  } catch (err) {
    console.error('❌ Expense sync failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
