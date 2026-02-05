export function mapCampaignToConversation(campaignJson) {
  const mapped = {};

  for (const [key, value] of Object.entries(campaignJson)) {
    if (key === "campaign_code") continue;

    const normalizedKey = key.toLowerCase(); // 🔑 CRITICAL

    mapped[normalizedKey] = {
      text: value.text,
      end: Boolean(value.end)
    };
  }

  return mapped;
}
