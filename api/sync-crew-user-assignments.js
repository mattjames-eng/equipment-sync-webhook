// /api/sync-crew-user-assignments.js
// Thin wrapper — triggers when Crew Member column changes on Crew Assignments board.
// Delegates to sync-crew-user core logic with route=assignments.
import handler from './sync-crew-user.js';

export default function (req, res) {
  req.query = { ...req.query, route: 'assignments' };
  return handler(req, res);
}
