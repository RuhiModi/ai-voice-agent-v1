export function buildCampaign(plan) {
  return {
    intro: plan.suggestedOpening,

    taskCheck: `આ માહિતી તમને સમજાઈ ગઈ છે કે નહીં?`,

    doneResponse: plan.suggestedClosing,

    pendingResponse:
      "જો તમને વધુ માહિતી જોઈએ તો અમે ફરીથી સંપર્ક કરીશું.",

    language: plan.language,
    goal: plan.goal
  };
}
