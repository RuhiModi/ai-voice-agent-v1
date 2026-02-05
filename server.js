/*************************************************
 * GUJARATI AI VOICE AGENT – HUMANATIC + ROBUST
 * State-based | Rule-driven | Scriptless
 * SINGLE + BULK CALL ENABLED
 *************************************************/

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import textToSpeech from "@google-cloud/text-to-speech";
import { google } from "googleapis";

import { STATES } from "./conversation/states.js";
import { RESPONSES } from "./conversation/responses.js";
import { RULES } from "./conversation/rules.js";
import { planFromText } from "./planner/planner.js";
import { buildCampaign } from "./planner/campaignBuilder.js"; 
import { loadFromText } from "./knowledge/textSource.js";
import { loadFromUrl } from "./knowledge/urlSource.js";
import { loadFromFile } from "./knowledge/fileSource.js";
import { mapCampaignToConversation } from "./conversation/mapper/campaignToConversation.js";
import { createCampaign } from "./db/campaigns.js";
import { getCampaignById } from "./db/campaigns.js";
import { isValidTransition } from "./conversation/stateGuards.js";

dotenv.config();

/* ======================
   BASIC SETUP
====================== */
const googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL;

const TERMINAL_STATES = new Set([
  STATES.TASK_DONE,
  STATES.ESCALATE,
  STATES.PROBLEM_RECORDED
]);


/* ======================
   TWILIO
====================== */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* ======================
   GOOGLE TTS
====================== */
const ttsClient = new textToSpeech.TextToSpeechClient({
  credentials: googleCredentials,
  projectId: googleCredentials.project_id
});

/* ======================
   GOOGLE SHEETS
====================== */
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  projectId: googleCredentials.project_id,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/* ======================
   FILE SYSTEM
====================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_DIR = path.join(__dirname, "audio");

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

app.use("/audio", express.static(AUDIO_DIR));


/* ======================
   SESSION MEMORY
====================== */
const sessions = new Map();

/* ======================
   AUDIO CACHE (KEEP THIS)
====================== */
async function generateAudio(text, filename) {
  const filePath = path.join(AUDIO_DIR, filename);

  const [res] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: "gu-IN", name: "gu-IN-Standard-A" },
    audioConfig: { audioEncoding: "MP3" }
  });

  fs.writeFileSync(filePath, res.audioContent);
}
async function ensureAudio(campaignKey, state, text) {
  if (!state) {
    console.warn("⚠️ Missing state, forcing hangup audio");
    return "fallback.mp3";
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    console.warn(`⚠️ Empty text for ${campaignKey}:${state}`);
    return "fallback.mp3";
  }

  const filename = `${campaignKey}_${state}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);

  if (!fs.existsSync(filePath)) {
    await generateAudio(text, filename);
  }

  return filename;
}

/* ======================
   TIME HELPERS
====================== */
function formatIST(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true
  });
}

/* ======================
   HELPERS
====================== */
function hasGujarati(text) {
  return /[\u0A80-\u0AFF]/.test(text);
}

function normalizeMixedGujarati(text) {
  const dict = {
    aadhar: "આધાર",
    aadhaar: "આધાર",
    card: "કાર્ડ",
    data: "ડેટા",
    entry: "એન્ટ્રી",
    update: "સુધારો",
    correction: "સુધારો",
    name: "નામ",
    address: "સરનામું",
    mobile: "મોબાઇલ",
    number: "નંબર",
    change: "ફેરફાર"
  };

  let out = text;
  for (const k in dict) {
    out = out.replace(new RegExp(`\\b${k}\\b`, "gi"), dict[k]);
  }
  return out;
}

function normalizeUserText(text) {
  if (!text) return "";
  let out = text.toLowerCase();
  out = normalizeMixedGujarati(out);
  out = out.replace(/\b(umm|uh|hmm|ok|okay)\b/gi, "");
  return out.trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.toString().replace(/\D/g, "").replace(/^91/, "");
}

/* ======================
   INTENT DETECTION
====================== */
function detectTaskStatus(text) {
  const pending = ["નથી", "બાકી", "હજુ", "પૂર્ણ નથી", "ચાલુ છે", "pending"];
  const done = ["પૂર્ણ થયું", "થઈ ગયું", "થયું છે", "મળી ગયું", "done"];

  const p = pending.some(w => text.includes(w));
  const d = done.some(w => text.includes(w));

  if (p && !d) return { status: "PENDING", confidence: 90 };
  if (d && !p) return { status: "DONE", confidence: 90 };
  if (p && d) return { status: "UNCLEAR", confidence: 40 };
  return { status: "UNCLEAR", confidence: 30 };
}

/* ======================
   BUSY INTENT
====================== */
function isBusyIntent(text) {
  if (!text) return false;

  const busySignals = [
    "સમય",
    "નથી",
    "પછી",
    "બાદમાં",
    "હવે નહીં",
    "હવે નથી",
    "પછી વાત",
    "later",
    "busy",
    "not now"
  ];

  let score = 0;
  for (const w of busySignals) {
    if (text.includes(w)) score++;
  }

  return score >= 2;
}

/* ======================
   GROQ CLASSIFY (OPTIONAL)
====================== */
async function groqClassify(text) {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Classify the user's intent."
          },
          {
            role: "user",
            content: `User said: "${text}"
Choose one: DONE, PENDING, BUSY, UNKNOWN`
          }
        ]
      })
    });

    const data = await response.json();
    return data.choices[0].message.content.trim().toUpperCase();
  } catch (error) {
    console.error("Groq classify error:", error.message);
    return "UNKNOWN";
  }
}

/* ======================
   BULK HELPERS
====================== */
async function updateBulkRowByPhone(phone, batchId, status, callSid = "") {
  try {
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Bulk_Calls!A:D"
    });

    const rows = sheet.data.values || [];
    const cleanPhone = normalizePhone(phone);

    for (let i = 1; i < rows.length; i++) {
      if (
        normalizePhone(rows[i][0]) === cleanPhone &&
        rows[i][1] === batchId
      ) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Bulk_Calls!C${i + 1}:D${i + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[status, callSid || rows[i][3] || ""]]
          }
        });
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error updating bulk row:", error.message);
    return false;
  }
}

async function updateBulkByCallSid(callSid, status) {
  try {
    const sheet = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Bulk_Calls!A:D"
    });

    const rows = sheet.data.values || [];

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][3] === callSid) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Bulk_Calls!C${i + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[status]] }
        });
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error updating bulk by call SID:", error.message);
    return false;
  }
}

/* ======================
   GOOGLE SHEET LOG
====================== */
async function logToSheet(s) {
  try {
    const duration = s.endTime && s.startTime
      ? Math.floor((s.endTime - s.startTime) / 1000)
      : 0;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Call_Logs!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          formatIST(s.startTime),
          formatIST(s.endTime),
          s.sid,
          s.userPhone,
          s.agentTexts.join(" | "),
          s.userTexts.join(" | "),
          s.result || "unknown",
          duration,
          s.confidenceScore ?? 0,
          s.callbackTime ?? "",
          s.conversationFlow.join("\n") 
        ]]
      }
    });
  } catch (error) {
    console.error("Error logging to sheet:", error.message);
  }
}

/* ======================
   CAMPAIGN BUILDER
====================== */
async function buildCampaignFromText(text) {
  try {
    const campaign = await planFromText(text);
    return campaign;
  } catch (error) {
    console.error("Error building campaign:", error.message);
    return null;
  }
}

/* ======================
   SINGLE CALL
====================== */
app.post("/call", async (req, res) => {
  try {
    const { to, campaignId } = req.body;
    if (!to) return res.status(400).json({ error: "Phone number required" });

    let campaign = null;
    let dynamicResponses = null;

    if (campaignId) {
      const record = await getCampaignById(campaignId);
      if (!record) {
        return res.status(404).json({ error: "campaign_not_found" });
      }
      campaign = record.campaign;
      dynamicResponses = mapCampaignToConversation(campaign);
    }
    const campaignKey = campaignId ? `cmp_${campaignId}` : "default";
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `${BASE_URL}/answer`,
      statusCallback: `${BASE_URL}/call-status`,
      statusCallbackEvent: ["completed"],
      method: "POST"
    });

    sessions.set(call.sid, {
      sid: call.sid,
      campaignKey,  
      userPhone: to,
      startTime: Date.now(),
      endTime: null,
      callbackTime: null,
      state: STATES.INTRO,
      campaign,
      dynamicResponses,
      agentTexts: [],
      userTexts: [],
      userBuffer: [],
      conversationFlow: [],
      unclearCount: 0,
      confidenceScore: 0,
      hasLogged: false,
      result: ""
    });

    res.json({ status: "calling", callSid: call.sid, hasCampaign: !!campaign });
  } catch (err) {
    console.error("call error:", err);
    res.status(500).json({ error: "call_failed" });
  }
});

/* ======================
   BULK CALL
====================== */
app.post("/bulk-call", async (req, res) => {
  try {
    const { phones = [], batchId, campaignId } = req.body;

    if (!phones.length) {
      return res.status(400).json({ error: "No phone numbers provided" });
    }
    if (!batchId) {
      return res.status(400).json({ error: "Batch ID required" });
    }

    let campaign = null;
    let dynamicResponses = null;

    if (campaignId) {
      const record = await getCampaignById(campaignId);
      if (!record) {
        return res.status(404).json({ error: "campaign_not_found", campaignId });
      }
      campaign = record.campaign;
      dynamicResponses = mapCampaignToConversation(campaign);
    }

    phones.forEach((phone, index) => {
      setTimeout(async () => {
        try {
          const campaignKey = campaignId ? `cmp_${campaignId}` : "default";
          const call = await twilioClient.calls.create({
            to: phone,
            from: process.env.TWILIO_FROM_NUMBER,
            url: `${BASE_URL}/answer`,
            statusCallback: `${BASE_URL}/call-status`,
            statusCallbackEvent: ["completed"],
            method: "POST"
          });

          await updateBulkRowByPhone(phone, batchId, "Calling", call.sid);

          sessions.set(call.sid, {
            sid: call.sid,
            campaignKey,
            userPhone: phone,
            batchId,
            startTime: Date.now(),
            endTime: null,
            callbackTime: null,
            state: STATES.INTRO,
            campaign,
            dynamicResponses,
            agentTexts: [],
            userTexts: [],
            userBuffer: [],
            conversationFlow: [],
            unclearCount: 0,
            confidenceScore: 0,
            hasLogged: false,
            result: ""
          });
        } catch (e) {
          console.error("Bulk call failed:", phone, e.message);
          await updateBulkRowByPhone(phone, batchId, "Failed");
        }
      }, index * 1500);
    });

    res.json({
      status: "bulk calling started",
      total: phones.length,
      batchId,
      hasCampaign: !!campaign
    });
  } catch (err) {
    console.error("Bulk call error:", err.message);
    res.status(500).json({ error: "bulk_call_failed" });
  }
});

/* ======================
   ANSWER (Twilio Webhook)
====================== */
app.post("/answer", async (req, res) => {
  try {
    const s = sessions.get(req.body.CallSid);
    if (!s) {
      return res.type("text/xml").send("<Response><Hangup/></Response>");
    }
     if (!s.campaignKey) {
       s.campaignKey = "default";
     }


    s.state = STATES.INTRO;

    const text =
      s.dynamicResponses?.[STATES.INTRO]?.text ||
      RESPONSES[STATES.INTRO]?.text ||
      "નમસ્કાર, હું આપને માહિતી આપવા માટે કોલ કરી રહ્યો છું.";

    const audioFile = await ensureAudio(
     s.campaignKey || "default",
     STATES.INTRO,
     text
   );


    s.agentTexts.push(text);
    s.conversationFlow.push(`AI: ${text}`);

    return res.type("text/xml").send(`
<Response>
  <Play>${BASE_URL}/audio/${audioFile}</Play>
  <Gather
    input="speech"
    language="gu-IN"
    timeout="15"
    speechTimeout="auto"
    action="${BASE_URL}/listen"
  />
</Response>`);
  } catch (err) {
    console.error("Error in /answer:", err);
    return res.type("text/xml").send("<Response><Hangup/></Response>");
  }
});

/* ======================
   PARTIAL BUFFER
====================== */
app.post("/partial", (req, res) => {
  const s = sessions.get(req.body.CallSid);
  if (!s) return res.sendStatus(200);

  const partial = (req.body.UnstableSpeechResult || "").trim();
  if (partial) s.lastPartialAt = Date.now();

  res.sendStatus(200);
});

/* ======================
   LISTEN (FINAL – STABLE)
====================== */
app.post("/listen", async (req, res) => {
  try {
    const s = sessions.get(req.body.CallSid);
    if (!s) {
      return res.type("text/xml").send("<Response><Hangup/></Response>");
    }

    // Ensure state always exists
    if (!s.state) {
      s.state = STATES.INTRO;
    }

    const raw = normalizeUserText(req.body.SpeechResult || "");

    /* ======================
   PRIORITY 1: BUSY INTENT
====================== */
if (s.state === STATES.INTRO && isBusyIntent(raw)) {
  if (raw) {
    s.conversationFlow.push(`User: ${raw}`);
    s.userTexts.push(raw);
  }

  let next = STATES.CALLBACK_TIME;

  if (!isValidTransition(s.state, next)) {
    console.warn(`⚠️ Invalid transition ${s.state} → ${next}`);
    next = STATES.ESCALATE;
  }

  s.state = next;
  s.unclearCount = 0;

  const text = getResponseText(s, next);

  s.agentTexts.push(text);
  s.conversationFlow.push(`AI: ${text}`);

  const audioFile = await ensureAudio(
    s.campaignKey,
    next,
    text
  );

  return res.type("text/xml").send(`
<Response>
  <Play>${BASE_URL}/audio/${audioFile}</Play>
  <Gather
    input="speech"
    language="gu-IN"
    timeout="15"
    speechTimeout="auto"
    action="${BASE_URL}/listen"
  />
</Response>`);
}

    /* ======================
   PRIORITY 2: INVALID INPUT
====================== */
if (!raw || raw.length < 3) {
  s.unclearCount++;

  let next = RULES.nextOnUnclear(s.unclearCount);

  if (!isValidTransition(s.state, next)) {
    console.warn(`⚠️ Invalid transition ${s.state} → ${next}`);
    next = STATES.ESCALATE;
  }

  s.state = next;

  let text;

  // ✅ Phase 6.3: progressive retry messages
  if (
    RESPONSES.retry_messages &&
    s.unclearCount <= RESPONSES.retry_messages.length
  ) {
    text =
      RESPONSES.retry_messages[
        Math.min(
          s.unclearCount - 1,
          RESPONSES.retry_messages.length - 1
        )
      ];
  } else {
    // fallback to normal response logic
    text = getResponseText(s, next);
  }

  s.agentTexts.push(text);
  s.conversationFlow.push(`AI: ${text}`);

  const audioFile = await ensureAudio(
    s.campaignKey,
    next,
    text
  );

  return res.type("text/xml").send(`
<Response>
  <Play>${BASE_URL}/audio/${audioFile}</Play>
  <Gather
    input="speech"
    language="gu-IN"
    timeout="15"
    speechTimeout="auto"
    action="${BASE_URL}/listen"
  />
</Response>`);
}


   /* ======================
   NORMAL FLOW
====================== */
if (raw) {
  s.conversationFlow.push(`User: ${raw}`);
  s.userTexts.push(raw);
}

let next;

// Step 1: Decide next state
if (s.state === STATES.INTRO) {
  next = STATES.TASK_CHECK;
} else {
  const { status, confidence } = detectTaskStatus(raw);
  s.confidenceScore = confidence;

  if (status === "DONE") {
    next = STATES.TASK_DONE;
  } else if (status === "PENDING") {
    next = STATES.TASK_PENDING;
  } else {
    next = STATES.ESCALATE;
  }
}

// Step 2: Validate transition
if (!isValidTransition(s.state, next)) {
  console.warn(`⚠️ Invalid transition ${s.state} → ${next}`);
  next = STATES.ESCALATE;
}

// Step 3: Commit state
s.state = next;

// Step 4: Get response text (campaign-safe)
const text = getResponseText(s, next);

// Step 5: Log agent output
s.agentTexts.push(text);
s.conversationFlow.push(`AI: ${text}`);

// Step 6: Generate / fetch audio
const audioFile = await ensureAudio(
  s.campaignKey,
  next,
  text
);


    /* ======================
       END STATE
    ====================== */
    // 🔐 Phase 6: DO NOT END IMMEDIATELY
   if (TERMINAL_STATES.has(next)) {
     s.pendingEndState = next;
     s.state = STATES.CONFIRM_END;
   
     const text =
       s.dynamicResponses?.[STATES.CONFIRM_END]?.text ||
       RESPONSES[STATES.CONFIRM_END].text;
   
     const audioFile = await ensureAudio(
       s.campaignKey || "default",
       next,
       text
     );
   
     return res.type("text/xml").send(`
   <Response>
     <Play>${BASE_URL}/audio/${audioFile}</Play>
     <Gather
       input="speech"
       language="gu-IN"
       timeout="15"
       speechTimeout="auto"
       action="${BASE_URL}/listen"
     />
   </Response>`);
   }

    /* ======================
       CONTINUE
    ====================== */
    return res.type("text/xml").send(`
<Response>
  <Play>${BASE_URL}/audio/${audioFile}</Play>
  <Gather
    input="speech"
    language="gu-IN"
    timeout="15"
    speechTimeout="auto"
    action="${BASE_URL}/listen"
  />
</Response>`);

  } catch (err) {
    console.error("Error in /listen:", err);
    return res.type("text/xml").send("<Response><Hangup/></Response>");
  }
});

/* ======================
   HEALTH CHECK
====================== */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "ai-voice-agent-v1",
    time: new Date().toISOString(),
    activeSessions: sessions.size
  });
});

/* ======================
   CAMPAIGN FETCH
====================== */
app.get("/internal/campaign/:id", async (req, res) => {
  try {
    const campaign = await getCampaignById(req.params.id);

    if (!campaign) {
      return res.status(404).json({ error: "campaign_not_found" });
    }

    res.json({
      success: true,
      campaign
    });
  } catch (err) {
    console.error("Get campaign error:", err.message);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ======================
   CAMPAIGN PREVIEW
====================== */
app.post("/internal/campaign/preview", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const plan = await planFromText(text);

    res.json({
      success: true,
      campaign: plan
    });
  } catch (err) {
    console.error("Campaign preview error:", err.message);
    res.status(500).json({ error: "planner_failed", message: err.message });
  }
});

/* ======================
   CAMPAIGN FROM SOURCE
====================== */
app.post("/internal/campaign/from-source", async (req, res) => {
  try {
    const { type, payload } = req.body;

    if (!type || !payload) {
      return res.status(400).json({ error: "type and payload required" });
    }

    let text;

    if (type === "text") {
      text = await loadFromText(payload.text);
    } else if (type === "url") {
      text = await loadFromUrl(payload.url);
    } else if (type === "file") {
      text = await loadFromFile(payload);
    } else {
      return res.status(400).json({ error: "invalid source type" });
    }

    if (!text) {
      return res.status(400).json({ error: "failed to extract text" });
    }

    // Build campaign
    const campaign = await planFromText(text);

    // Save to database
    const saved = await createCampaign({
      source_type: type,
      source_payload: JSON.stringify(payload),
      campaign_json: campaign
    });

    res.json({
      success: true,
      campaignId: saved.id,
      sourceType: type,
      campaign
    });

  } catch (err) {
    console.error("from-source error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ======================
   ERROR HANDLER
====================== */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});
/* ======================
   DEBUG AUDIO FILES
====================== */
app.get("/debug/audio", (req, res) => {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ======================
   START
====================== */
app.listen(PORT, async () => {
  try {
    console.log("✅ Gujarati AI Voice Agent – RUNNING");
    console.log(`✅ Port: ${PORT}`);
    console.log(`✅ Base URL: ${BASE_URL}`);
    console.log(`✅ Audio files preloaded`);
    console.log(`✅ Audio generation: dynamic (on-demand)`);
    console.log(`✅ Active sessions: ${sessions.size}`);
  } catch (error) {
    console.error("❌ Error starting server:", error.message);
    process.exit(1);
  }
});
