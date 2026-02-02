import { query } from "./index.js";

export async function insertCampaign({ sourceType, sourcePayload, campaign }) {
  const res = await query(
    `
    INSERT INTO campaigns (source_type, source_payload, campaign_json, language, goal)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [
      sourceType,
      sourcePayload,
      campaign,
      campaign.language,
      campaign.goal
    ]
  );

  return res.rows[0].id;
}
