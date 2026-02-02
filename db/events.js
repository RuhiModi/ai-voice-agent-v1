import { query } from "./index.js";

export async function logEvent({ callId, role, message, state }) {
  await query(
    `
    INSERT INTO call_events (call_id, role, message, state)
    VALUES ($1, $2, $3, $4)
    `,
    [callId, role, message, state]
  );
}
