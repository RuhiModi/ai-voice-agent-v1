import fetch from "node-fetch";
import { JSDOM } from "jsdom";

export async function loadFromUrl(url) {
  if (!url) throw new Error("URL required");

  const res = await fetch(url);
  const html = await res.text();

  const dom = new JSDOM(html);
  const text = dom.window.document.body.textContent || "";

  if (text.trim().length < 50) {
    throw new Error("Not enough readable content");
  }

  return text.replace(/\s+/g, " ").trim();
}
