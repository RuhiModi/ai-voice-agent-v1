export function getResponseText(s, state) {
  return (
    s.dynamicResponses?.[state]?.text ||
    RESPONSES[state]?.text ||
    "માફ કરશો, કૃપા કરીને ફરીથી કહો."
  );
}
