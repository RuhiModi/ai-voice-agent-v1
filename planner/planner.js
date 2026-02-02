// planner/planner.js

/**
 * This function will take any normal text
 * and convert it into a very simple call plan.
 * 
 * For now, this is a DUMMY planner.
 * Later, we will connect AI (LLM) here.
 */

export function createCallPlan(inputText) {
  return {
    campaignName: "Sample Campaign",
    language: "gu-IN",

    script: {
      INTRO: "નમસ્તે, હું ઓફિસમાંથી બોલું છું.",
      MESSAGE: "આ એક માહિતી માટેનો કોલ છે.",
      CONFIRM: "શું તમને માહિતી સમજી ગઈ છે?",
      END: "આભાર. શુભ દિવસ."
    },

    meta: {
      sourceTextPreview: inputText.slice(0, 200)
    }
  };
}

