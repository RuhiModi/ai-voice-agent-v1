export function mapCampaignToConversation(campaignJson) {
  const mapped = {};

  for (const [key, value] of Object.entries(campaignJson)) {
    // Skip metadata
    if (key === "campaign_code") continue;

    // 🔑 Normalize DB keys → match STATES
    const normalizedKey = key.toLowerCase();

    mapped[normalizedKey] = {
      text: value?.text || "",
      end: Boolean(value?.end)
    };
  }

  return mapped;
}
