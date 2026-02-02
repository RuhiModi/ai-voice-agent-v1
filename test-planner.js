// test-planner.js

import { createCallPlan } from "./planner/planner.js";

// Example text a non-technical user might upload
const userInputText = `
આજે બસ નંબર GJ01AB1234
રૂટ અમદાવાદ થી વડોદરા
સમય સવારે 7:30
ડ્રાઈવર નામ રamesh
`;

// Call the planner
const plan = createCallPlan(userInputText);

// Print the result
console.log("✅ Generated Call Plan:");
console.log(JSON.stringify(plan, null, 2));
