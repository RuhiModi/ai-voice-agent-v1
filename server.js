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

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

/* ======================
   SESSION MEMORY
====================== */
const sessions = new Map();

/* ======================
   AUDIO CACHE
====================== */
async function generateAudio(text, file) {
  const filePath = path.join(AUDIO_DIR, file);
  if (fs.existsSync(filePath)) return;

  const [res] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: "gu-IN", name: "gu-IN-Standard-A" },
    audioConfig: { audioEncoding: "MP3" }
  });

  fs.writeFileSync(filePath, res.audioContent);
}

async function preloadAll() {
  for (const key in RESPONSES) {
    await generateAudio(RESPONSES[key].text, `${key}.mp3`);
  }
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
    const { to, campaignText } = req.body;

    if (!to) {
      return res.status(400).json({ error: "Phone number required" });
    }

    // Build campaign if provided
    let campaign = null;
    let dynamicResponses = null;

    if (campaignText) {
      campaign = await buildCampaignFromText(campaignText);
      if (campaign) {
        dynamicResponses = mapCampaignToConversation(campaign);
      }
    }

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
      userPhone: to,
      startTime: Date.now(),
      endTime: null,
      callbackTime: null,
      state: STATES.INTRO,
      campaign: campaign,
      dynamicResponses: dynamicResponses,
      agentTexts: [],
      userTexts: [],
      userBuffer: [],
      liveBuffer: "",
      unclearCount: 0,
      confidenceScore: 0,
      conversationFlow: [],
      hasLogged: false,
      result: ""
    });

    res.json({ 
      status: "calling", 
      callSid: call.sid,
      hasCampaign: !!campaign 
    });
  } catch (error) {
    console.error("Error initiating call:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ======================
   BULK CALL
====================== */
app.post("/bulk-call", async (req, res) => {
  try {
    const { phones = [], batchId, campaignText } = req.body;

    if (!phones.length) {
      return res.status(400).json({ error: "No phone numbers provided" });
    }

    if (!batchId) {
      return res.status(400).json({ error: "Batch ID required" });
    }

    // Build campaign if provided
    let campaign = null;
    let dynamicResponses = null;

    if (campaignText) {
      campaign = await buildCampaignFromText(campaignText);
      if (campaign) {
        dynamicResponses = mapCampaignToConversation(campaign);
      }
    }

    phones.forEach((phone, index) => {
      setTimeout(async () => {
        try {
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
            userPhone: phone,
            batchId,
            startTime: Date.now(),
            endTime: null,
            callbackTime: null,
            state: STATES.INTRO,
            campaign: campaign,
            dynamicResponses: dynamicResponses,
            agentTexts: [],
            userTexts: [],
            userBuffer: [],
            liveBuffer: "",
            unclearCount: 0,
            confidenceScore: 0,
            conversationFlow: [],
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
      batchId: batchId,
      hasCampaign: !!campaign
    });
  } catch (error) {
    console.error("Error initiating bulk calls:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ======================
   ANSWER
====================== */
app.post("/answer", (req, res) => {
  try {
    const s = sessions.get(req.body.CallSid);
    
    if (!s) {
      return res.type("text/xml").send(`<Response><Hangup/></Response>`);
    }

    const responseText = s.dynamicResponses?.[STATES.INTRO]?.text || RESPONSES[STATES.INTRO].text;
    
    s.agentTexts.push(responseText);
    s.conversationFlow.push(`AI: ${responseText}`);

    res.type("text/xml").send(`
<Response>
  <Play>${BASE_URL}/audio/${STATES.INTRO}.mp3</Play>
  <Gather input="speech" language="gu-IN"
    timeout="15" speechTimeout="auto"
    partialResultCallback="${BASE_URL}/partial"
    action="${BASE_URL}/listen"/>
</Response>`);
  } catch (error) {
    console.error("Error in /answer:", error.message);
    res.type("text/xml").send(`<Response><Hangup/></Response>`);
  }
});

/* ======================
   PARTIAL BUFFER
====================== */
app.post("/partial", (req, res) => {
  const s = sessions.get(req.body.CallSid);
  if (!s) return res.sendStatus(200);

  const partial = (req.body.UnstableSpeechResult || "").trim();
  if (partial) {
    s.lastPartialAt = Date.now();
  }

  res.sendStatus(200);
});

/* ======================
   LISTEN (FINAL, STABLE)
====================== */
app.post("/listen", async (req, res) => {
  try {
    const s = sessions.get(req.body.CallSid);

    if (!s) {
      return res.type("text/xml").send(`<Response><Hangup/></Response>`);
    }

    const raw = normalizeUserText(req.body.SpeechResult || "");
    s.liveBuffer = "";

    /* ======================
       PRIORITY 1: BUSY INTENT
    ====================== */
    if (s.state === STATES.INTRO && isBusyIntent(raw)) {
      const lastUser = s.userTexts[s.userTexts.length - 1];
      if (raw && raw !== lastUser) {
        s.userTexts.push(raw);
      }

      s.conversationFlow.push(`User: ${raw}`);
      
      const next = STATES.CALLBACK_TIME;
      s.state = next;
      s.unclearCount = 0;
      s.userBuffer = [];
      
      const responseText = s.dynamicResponses?.[next]?.text || RESPONSES[next].text;
      s.agentTexts.push(responseText);
      s.conversationFlow.push(`AI: ${responseText}`);

      return res.type("text/xml").send(
        `<Response>
          <Play>${BASE_URL}/audio/${next}.mp3</Play>
          <Gather input="speech"
            language="gu-IN"
            timeout="15"
            speechTimeout="auto"
            partialResultCallback="${BASE_URL}/partial"
            action="${BASE_URL}/listen"/>
        </Response>`
      );
    }

    /* ======================
       PRIORITY 2: INVALID INPUT
    ====================== */
    if (!raw || raw.length < 3) {
      const next = RULES.nextOnUnclear(++s.unclearCount);
      const responseText = s.dynamicResponses?.[next]?.text || RESPONSES[next].text;
      s.agentTexts.push(responseText);
      s.conversationFlow.push(`AI: ${responseText}`);

      return res.type("text/xml").send(
        `<Response>
          <Play>${BASE_URL}/audio/${next}.mp3</Play>
          <Gather input="speech"
            language="gu-IN"
            timeout="15"
            speechTimeout="auto"
            partialResultCallback="${BASE_URL}/partial"
            action="${BASE_URL}/listen"/>
        </Response>`
      );
    }

    s.conversationFlow.push(`User: ${raw}`);
    s.userBuffer.push(raw);

    /* ======================
       STATE TRANSITION LOGIC
    ====================== */
    let next;

    if (s.state === STATES.INTRO) {
      next = STATES.TASK_CHECK;

    } else if (s.state === STATES.CALLBACK_TIME) {
      s.callbackTime = raw;
      next = STATES.CALLBACK_CONFIRM;

    } else if (s.state === STATES.TASK_PENDING) {
      next = STATES.PROBLEM_RECORDED;

    } else {
      const { status, confidence } = detectTaskStatus(raw);
      s.confidenceScore = confidence;

      if (status === "DONE") {
        next = STATES.TASK_DONE;
      } else if (status === "PENDING") {
        next = STATES.TASK_PENDING;
      } else {
        s.unclearCount++;

        if (s.unclearCount === 1) {
          next = STATES.RETRY_TASK_CHECK;
        } else if (s.unclearCount === 2) {
          next = STATES.CONFIRM_TASK;
        } else {
          next = STATES.ESCALATE;
        }
      }
    }

    /* ======================
       FINAL USER TEXT FLUSH
    ====================== */
    if (s.userBuffer.length) {
      const combined = s.userBuffer.join(" ");
      const last = s.userTexts[s.userTexts.length - 1];

      if (combined && combined !== last) {
        s.userTexts.push(combined);
      }
      s.userBuffer = [];
    }

    const responseText = s.dynamicResponses?.[next]?.text || RESPONSES[next].text;
    s.agentTexts.push(responseText);
    s.conversationFlow.push(`AI: ${responseText}`);

    /* ======================
       END STATE
    ====================== */
    if (RESPONSES[next].end) {
      s.result = next;
      s.endTime = Date.now();

      await logToSheet(s);
      s.hasLogged = true;

      if (s.batchId) {
        await updateBulkRowByPhone(s.userPhone, s.batchId, "Completed", s.sid);
      }

      sessions.delete(s.sid);

      return res.type("text/xml").send(
        `<Response>
          <Play>${BASE_URL}/audio/${next}.mp3</Play>
          <Hangup/>
        </Response>`
      );
    }

    /* ======================
       CONTINUE CONVERSATION
    ====================== */
    s.state = next;
    return res.type("text/xml").send(
      `<Response>
        <Play>${BASE_URL}/audio/${next}.mp3</Play>
        <Gather input="speech"
          language="gu-IN"
          timeout="15"
          speechTimeout="auto"
          partialResultCallback="${BASE_URL}/partial"
          action="${BASE_URL}/listen"/>
      </Response>`
    );
  } catch (error) {
    console.error("Error in /listen:", error.message);
    return res.type("text/xml").send(`<Response><Hangup/></Response>`);
  }
});

/* ======================
   CALL STATUS
====================== */
app.post("/call-status", async (req, res) => {
  try {
    const s = sessions.get(req.body.CallSid);

    if (s && !s.hasLogged) {
      s.result = s.result || "abandoned";
      s.endTime = Date.now();
      await logToSheet(s);
      s.hasLogged = true;
    }

    if (s && s.batchId) {
      await updateBulkByCallSid(req.body.CallSid, "Completed");
    }

    if (s) {
      sessions.delete(s.sid);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error in /call-status:", error.message);
    res.sendStatus(200);
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

    // 🧠 Build campaign
    const campaign = await planFromText(text);

    // 💾 SAVE TO DB (THIS WAS MISSING)
    const saved = await createCampaign({
      source_type: type,
      source_payload: payload,
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
   START
====================== */
app.listen(PORT, async () => {
  try {
    await preloadAll();
    console.log("✅ Gujarati AI Voice Agent – RUNNING");
    console.log(`✅ Port: ${PORT}`);
    console.log(`✅ Base URL: ${BASE_URL}`);
    console.log(`✅ Audio files preloaded`);
  } catch (error) {
    console.error("❌ Error starting server:", error.message);
    process.exit(1);
  }
});
