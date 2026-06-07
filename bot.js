[6/7/2026 6:16 PM] Kuwait25: const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.log("ERROR: Missing environment variables.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});
bot.on("polling_error", () => {});
bot.on("error", () => {});

const ASSETS = {
  "FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD",
    "USD/CAD","GBP/JPY","EUR/JPY","EUR/GBP","NZD/USD",
    "AUD/JPY","EUR/AUD","GBP/CHF","EUR/CHF","GBP/AUD"
  ],
  "FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","AUD/CHF OTC",
    "CAD/JPY OTC","NZD/USD OTC","EUR/JPY OTC","USD/JPY OTC"
  ],
  "CRYPTO": ["BTC/USD","ETH/USD","LTC/USD","XRP/USD","BNB/USD"],
  "COMMODITIES": ["GOLD/USD","SILVER/USD","OIL/USD"],
  "INDICES": ["US500","US30","NASDAQ","UK100","GER40"]
};

const EXPIRIES = ["1 min","3 min","5 min","15 min","30 min","1 hour"];
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { step:"idle", asset:null, expiry:null, cat:null };
  return sessions[id];
}

// ── HTTPS POST ────────────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error("Bad response: " + raw.slice(0,80))); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Groq call ─────────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens) {
  const result = await httpsPost(
    "api.groq.com", "/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    { model: "llama-3.3-70b-versatile", temperature: 0.4, max_tokens: maxTokens || 600, messages }
  );
  if (!result.choices || !result.choices[0]) throw new Error("Groq returned no choices");
  return result.choices[0].message.content;
}

// ── All signals via Groq with real market knowledge ───────────────────────────
async function runAnalysis(asset, expiry) {
  const isOTC = asset.includes("OTC");
  const clean = asset.replace(" OTC","");

  const prompt =
    "You are NOXA, a professional binary options analyst for Pocket Option.\n\n" +
    "Analyze " + asset + " for a " + expiry + " binary options trade.\n" +
    (isOTC ? "This is an OTC pair available 24/7.\n" : "") +
    "\nBased on current market knowledge for " + clean + ", provide realistic technical analysis.\n\n" +
    "Rules:\n" +
    "- Signal must be based on real market logic (RSI, MACD, trend, support/resistance)\n" +
    "- Do NOT always give CALL. Give PUT when market is overbought or trending down.\n" +
    "- Confidence between 62 and 88 only\n" +
    "- Price must be realistic for " + clean + "\n\n" +
    "Return ONLY this JSON, no markdown, no extra text:\n" +
    "{" +
    "\"asset\":\"" + asset + "\"," +
    "\"expiry\":\"" + expiry + "\"," +
    "\"price\":\"REALISTIC_PRICE\"," +
    "\"change24h\":\"+X.XX% or -X.XX%\"," +
    "\"rsi\":\"VALUE_1_TO_100\"," +
    "\"macd\":\"BULLISH or BEARISH\"," +
    "\"trend\":\"BULLISH or BEARISH\"," +
    "\"signal\":\"CALL or PUT\"," +
    "\"confidence\":NUMBER_62_TO_88," +
[6/7/2026 6:16 PM] Kuwait25: "\"risk\":\"Low or Medium or High\"," +
    "\"support\":\"REALISTIC_SUPPORT_PRICE\"," +
    "\"resistance\":\"REALISTIC_RESISTANCE_PRICE\"," +
    "\"analysis\":\"2 sentence analysis using RSI MACD trend to explain the signal\"," +
    "\"edge\":\"one specific tactical insight for entering this trade\"" +
    "}";

  const txt = await callGroq([
    { role: "system", content: "You are a professional binary options analyst. Return ONLY valid JSON. No markdown. No explanation. Just the JSON object." },
    { role: "user", content: prompt }
  ], 600);

  // Clean and parse JSON
  let cleaned = txt.trim();
  cleaned = cleaned.replace(/`json/gi,"").replace(/```/g,"").trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No valid JSON in response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) { const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; }
function catKB()     { return { inline_keyboard: chunk(Object.keys(ASSETS),2).map(row=>row.map(c=>({text:c,callback_data:"cat:"+c}))) }; }
function assetKB(c)  { return { inline_keyboard: [...chunk(ASSETS[c]||[],2).map(row=>row.map(a=>({text:a,callback_data:"asset:"+a}))),[{text:"<< Back",callback_data:"back:cat"}]] }; }
function expiryKB()  { return { inline_keyboard: [...chunk(EXPIRIES,3).map(row=>row.map(e=>({text:e,callback_data:"expiry:"+e}))),[{text:"<< Back",callback_data:"back:asset"}]] }; }
function confirmKB() { return { inline_keyboard: [[{text:"RUN NOXA ANALYSIS",callback_data:"confirm:analyze"}],[{text:"Change Pair",callback_data:"back:cat"},{text:"Change Expiry",callback_data:"back:expiry"}]] }; }
function retryKB()   { return { inline_keyboard: [[{text:"Retry",callback_data:"confirm:analyze"}],[{text:"New Pair",callback_data:"back:cat"}]] }; }
function bar(pct)    { const f=Math.round(pct/10); return "[" + "#".repeat(f) + "-".repeat(10-f) + "] " + pct + "%"; }

function formatSignal(d) {
  const isCall = d.signal === "CALL";
  return (
    "*NOXA AI SIGNAL*  " + (isCall?"[BUY]":"[SELL]") + "\n\n" +
    "====================\n" +
    "* " + (isCall?"HIGHER / BUY  ^":"LOWER / SELL  v") + " *\n" +
    "Pair:   *" + d.asset + "*\n" +
    "Expiry: *" + d.expiry + "*\n" +
    "Price:  *" + d.price + "*\n" +
    "====================\n\n" +
    "*INDICATORS*\n" +
    "- 24h Change: " + d.change24h + "\n" +
    "- RSI(14):    " + d.rsi + (parseInt(d.rsi)>70?" [OVERBOUGHT]":parseInt(d.rsi)<30?" [OVERSOLD]":" [NEUTRAL]") + "\n" +
    "- MACD:       " + d.macd + "\n" +
    "- Trend:      " + d.trend + "\n\n" +
    "*KEY LEVELS*\n" +
    "- Support:    " + d.support + "\n" +
    "- Resistance: " + d.resistance + "\n\n" +
    "*CONFIDENCE: " + d.confidence + "%*\n" +
    bar(d.confidence) + "\n" +
    "Risk: " + d.risk + "\n\n" +
    "*ANALYSIS*\n" + d.analysis + "\n\n" +
    "*EDGE*\n" + d.edge + "\n\n" +
    "====================\n" +
    "_NOXA AI - Pocket Option_"
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step:"idle", asset:null, expiry:null, cat:null };
  bot.sendMessage(chatId,
    "Welcome *" + (msg.from.first_name||"Trader") + "*!\n\n" +
    "*NOXA AI* - Pocket Option Signal Bot\n\n" +
    "AI-powered HIGHER/LOWER signals for all pairs.\n\n" +
    "/analyze - Get a signal\n/help - Help",
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"Get Signal Now",callback_data:"start:analyze"}]] } }
  );
});

bot.onText(/\/analyze/, (msg) => {
  getSession(msg.chat.id).step = "select_cat";
  bot.sendMessage(msg.chat.id, "*Select Asset Category:*", { parse_mode:"Markdown", reply_markup:catKB() });
});
[6/7/2026 6:16 PM] Kuwait25: bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "All pairs supported including OTC 24/7\n\n" +
    "Best combo:\n1min candle + 3min or 5min expiry\n\n" +
    "Always use risk management!",
    { parse_mode:"Markdown" }
  );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const sess   = getSession(chatId);
  await bot.answerCallbackQuery(query.id);

  if (data === "start:analyze" || data === "back:cat") {
    sess.step = "select_cat";
    return bot.editMessageText("*Select Asset Category:*", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:catKB() });
  }
  if (data.startsWith("cat:")) {
    sess.cat = data.replace("cat:",""); sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:assetKB(sess.cat) });
  }
  if (data.startsWith("asset:")) {
    sess.asset = data.replace("asset:",""); sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:expiryKB() });
  }
  if (data.startsWith("expiry:")) {
    sess.expiry = data.replace("expiry:",""); sess.step = "confirm";
    return bot.editMessageText("Ready!\n\nPair: *" + sess.asset + "*\nExpiry: *" + sess.expiry + "*\n\nTap to analyze:", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:confirmKB() });
  }
  if (data === "back:asset") {
    sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:assetKB(sess.cat) });
  }
  if (data === "back:expiry") {
    sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", { chat_id:chatId, message_id:msgId, parse_mode:"Markdown", reply_markup:expiryKB() });
  }

  if (data === "confirm:analyze") {
    await bot.editMessageText(
      "Analyzing *" + sess.asset + "*...\n\nNOXA AI is calculating signal\nPlease wait 10-15 seconds...",
      { chat_id:chatId, message_id:msgId, parse_mode:"Markdown" }
    );
    try {
      const result = await runAnalysis(sess.asset, sess.expiry);
      await bot.editMessageText(formatSignal(result), {
        chat_id:chatId, message_id:msgId, parse_mode:"Markdown",
        reply_markup:{ inline_keyboard:[
          [{text:"Analyze Again",callback_data:"confirm:analyze"}],
          [{text:"New Pair",callback_data:"back:cat"},{text:"New Expiry",callback_data:"back:expiry"}]
        ]}
      });
    } catch (err) {
      console.log("Error:", err.message);
      await bot.editMessageText(
        "Something went wrong. Please tap Retry.",
        { chat_id:chatId, message_id:msgId, reply_markup:retryKB() }
      );
    }
  }
});

console.log("NOXA AI Bot running.");
