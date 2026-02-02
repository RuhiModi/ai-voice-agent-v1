import { STATES } from "../states.js";

/**
 * Converts campaign → conversation responses
 * Safe, predictable, voice-ready
 */
export function mapCampaignToConversation(campaign) {
  return {
    [STATES.INTRO]: {
      text: campaign.suggestedOpening,
      next: STATES.TASK_CHECK
    },

    [STATES.TASK_CHECK]: {
      text: "આ માહિતી તમને સમજાઈ ગઈ છે કે નહીં?",
      next: {
        DONE: STATES.TASK_DONE,
        PENDING: STATES.TASK_PENDING,
        UNKNOWN: STATES.RETRY_TASK_CHECK
      }
    },

    [STATES.TASK_DONE]: {
      text: campaign.suggestedClosing,
      end: true
    },

    [STATES.TASK_PENDING]: {
      text: "જો તમને વધુ માહિતી જોઈએ તો કૃપા કરીને કહો.",
      next: STATES.PROBLEM_RECORDED
    }
  };
}
