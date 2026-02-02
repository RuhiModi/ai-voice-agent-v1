export async function loadFromText(text) {
  if (!text || text.trim().length < 10) {
    throw new Error("Text too short");
  }

  return text.trim();
}
