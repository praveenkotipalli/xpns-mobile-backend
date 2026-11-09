/**
 * Permanently remove a user and everything that is theirs alone. Run it inside
 * a transaction: `client` is whatever withTransaction hands over.
 *
 * What goes, via the cascades from users:
 *   - their personal money (income, savings pots)
 *   - every space they own, with its members, expenses and history. The money
 *     in a space sits in the owner's account, so its books mean nothing once
 *     the owner is gone
 *   - every event they organised
 *
 * What stays: their rows in other people's spaces and events. The member or
 * participant row is unlinked (user_id -> NULL) and remains as a plain name,
 * the same as someone who never had an account, so everyone else's books still
 * add up.
 *
 * The first delete is not redundant with the cascade. expense_shares.member_id
 * is ON DELETE RESTRICT, which Postgres checks as soon as the cascade removes a
 * member - before it gets round to that space's expenses. Without clearing them
 * first, deleting anyone whose space holds a split expense fails.
 */
export async function deleteAccount(client, userId) {
  await client.query(
    'DELETE FROM expenses WHERE space_id IN (SELECT id FROM spaces WHERE owner_id = $1)',
    [userId]
  );
  await client.query('DELETE FROM users WHERE id = $1', [userId]);
}
