/**
 * Webhook 1: Instant Trigger
 * Receives button click, returns immediately, triggers background worker
 */

const WORKER_WEBHOOK_URL = 'https://equipment-sync-webhook.vercel.app/api/tasks/process';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.body && req.body.challenge) return res.status(200).json({ challenge: req.body.challenge });

  const event = req.body?.event || req.body || {};
  const projectId = event.pulseId || event.itemId;

  if (!projectId) {
    return res.status(400).json({ success: false, error: 'Missing project ID' });
  }

  console.log(`📥 Trigger received for Project ID: ${projectId}`);

  // ✅ IMMEDIATELY RETURN 200 OK
  res.status(200).json({ 
    success: true, 
    message: 'Task loading triggered',
    projectId: projectId 
  });

  // 🚀 TRIGGER BACKGROUND WORKER (fire and forget)
  console.log(`🔗 Calling worker at: ${WORKER_WEBHOOK_URL}`);
  console.log(`📦 Payload: ${JSON.stringify({ projectId: projectId })}`);
  
  fetch(WORKER_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ projectId: projectId })
  })
  .then(response => {
    console.log(`✅ Worker responded with status: ${response.status}`);
    return response.text();
  })
  .then(text => {
    console.log(`📄 Worker response body: ${text}`);
  })
  .catch(error => {
    console.error('❌ Failed to trigger worker:', error.message);
    console.error('❌ Error stack:', error.stack);
  });

  console.log(`✅ Worker trigger initiated for Project ID: ${projectId}`);
}
