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
