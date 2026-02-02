export function planFromText(inputText) {
  return {
    campaignType: "informational",
    language: "gu-IN",
    goal: "inform user",
    extractedData: {
      summary: inputText
    },
    suggestedOpening:
      "નમસ્કાર, હું આપને એક મહત્વની માહિતી આપવા માટે કોલ કરી રહ્યો છું.",
    suggestedClosing:
      "આભાર, શુભ દિવસ."
  };
}
