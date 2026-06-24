// /api/sync-crew-user-contracts.js
// Thin wrapper — triggers when Tech/Engineer column changes on Crew Contracts board.
// Delegates to sync-crew-user core logic with route=contracts.
import handler from './sync-crew-user.js';

export default function (req, res) {
  req.query = { ...req.query, route: 'contracts' };
  return handler(req, res);
}
