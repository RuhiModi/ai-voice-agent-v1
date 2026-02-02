import { query } from "./index.js";

export async function insertCall({ callSid, phone, campaignId }) {
  const res = await query(
    `
    INSERT INTO calls (call_sid, phone, campaign_id, status, started_at)
    VALUES ($1, $2, $3, 'initiated', now())
    RETURNING id
    `,
    [callSid, phone, campaignId]
  );

  return res.rows[0].id;
}

export async function completeCall(callSid) {
  await query(
    `
    UPDATE calls
    SET status='completed', ended_at=now()
    WHERE call_sid=$1
    `,
    [callSid]
  );
}
