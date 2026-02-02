export const RULES = {
  MAX_UNCLEAR: 3,
  CONFIRM_AFTER: 2,
  MIN_CONFIDENCE: 70,

  shouldConfirm(confidence) {
    return confidence < this.MIN_CONFIDENCE;
  },

  nextOnUnclear(unclearCount) {
    if (unclearCount === 1) return "retry_task_check";
    if (unclearCount === 2) return "confirm_task";
    return "escalate";
  }
};
