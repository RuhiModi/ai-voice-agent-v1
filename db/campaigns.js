// db/campaigns.js
import { pool } from "./index.js";

/**
 * Create a campaign record
 */
export async function createCampaign({
  source_type,
  source_payload,
  campaign_json
}) {
  const query = `
    INSERT INTO campaigns (source_type, source_payload, campaign_json)
    VALUES ($1, $2, $3)
    RETURNING id;
  `;

  const values = [
    source_type,
    source_payload,
    campaign_json
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

//new lines

export async function getCampaignById(campaignId) {
  const result = await pool.query(
    `
    SELECT
      id,
      source_type,
      campaign_json,
      created_at
    FROM campaigns
    WHERE id = $1
    LIMIT 1
    `,
    [campaignId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    sourceType: result.rows[0].source_type,
    campaign: result.rows[0].campaign_json,
    createdAt: result.rows[0].created_at
  };
}
