const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = "8607779232:AAEegVIc8HWKKJmc2z4W8dvSuVkvtZweOmE";
const GROQ_API_KEY   = "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";
const CHANNEL_ID     = "-1003700445826";
// ─────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});

bot.on("polling_error", () => {});
bot.on("error", () => {});

// ── Assets ────────────────────────────────────────────────────────────────────
const ASSETS = {
  "FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD",
    "USD/CAD","GBP/JPY","EUR/JPY","EUR/GBP","NZD/USD",
    "AUD/JPY","EUR/AUD","GBP/CHF","EUR/CHF","AUD/CAD",
    "GBP/AUD","EUR/NZD","GBP/NZD","NZD/JPY","USD/SGD"
  ],
  "FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","AUD/CHF OTC",
    "CAD/JPY OTC","NZD/USD OTC","EUR/JPY OTC","USD/JPY OTC"
  ],
  "CRYPTO": ["BTC/USD","ETH/USD","LTC/USD","XRP/USD","BNB/USD"],
  "COMMODITIES": ["GOLD/USD","SILVER/USD","OIL/USD","BRENT/USD","PLATINUM/USD"],
  "INDICES": ["US500","US30","NASDAQ","UK100","GER40"]
};

const EXPIRIES = ["30 sec","1 min","2 min","5 min","15 min","30 min","1 hour","4 hour"];

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { step:"idle", asset:null, expiry:null, cat:null };
  return sessions[id];
}

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", chunk => raw += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("Bad JSON response")); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Groq AI ───────────────────────────────────────────────────────────────────
async function runAnalysis(asset, expiry) {
  const prompt = You are NOXA, a professional binary options analyst for Pocket Option.
Pair: ${asset} | Expiry: ${expiry}
${asset.includes("OTC") ? "OTC pair available 24/7." : ""}

Generate a realistic binary options signal for ${asset}.
Return ONLY valid JSON, no extra text, no markdown:
{
  "asset": "${asset}",
  "expiry": "${expiry}",
  "price": "current approximate price",
  "change24h": "+X.XX% or -X.XX%",
  "rsi": "RSI value 1-100",
  "macd": "BULLISH or BEARISH",
  "trend": "BULLISH or BEARISH",
  "signal": "CALL or PUT",
  "confidence": 60,
  "risk": "Low or Medium or High",
  "support": "support price level",
  "resistance": "resistance price level",
  "analysis": "2-3 sentence market analysis",
  "edge": "one tactical insight"
};

  const result = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 800,
      messages: [
        { role: "system", content: "You are a binary options analyst. Return valid JSON only, no markdown, no extra text." },
        { role: "user", content: prompt }
      ]
    }
  );

  const text = result.choices && result.choices[0] ? result.choices[0].message.content : "";
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}
function catKB() {
  return { inline_keyboard: chunk(Object.keys(ASSETS), 2).map(row => row.map(c => ({ text: c, callback_data: "cat:" + c }))) };
}

function assetKB(cat) {
  return {
    inline_keyboard: [
      ...chunk(ASSETS[cat] || [], 2).map(row => row.map(a => ({ text: a, callback_data: "asset:" + a }))),
      [{ text: "<< Back", callback_data: "back:cat" }]
    ]
  };
}

function expiryKB() {
  return {
    inline_keyboard: [
      ...chunk(EXPIRIES, 4).map(row => row.map(e => ({ text: e, callback_data: "expiry:" + e }))),
      [{ text: "<< Back", callback_data: "back:asset" }]
    ]
  };
}

function confirmKB() {
  return {
    inline_keyboard: [
      [{ text: "RUN NOXA ANALYSIS", callback_data: "confirm:analyze" }],
      [{ text: "Change Pair", callback_data: "back:cat" }, { text: "Change Expiry", callback_data: "back:expiry" }]
    ]
  };
}

function retryKB() {
  return { inline_keyboard: [[{ text: "Retry", callback_data: "confirm:analyze" }], [{ text: "New Pair", callback_data: "back:cat" }]] };
}

// ── Signal Formatter ──────────────────────────────────────────────────────────
function bar(pct) {
  const f = Math.round(pct / 10);
  return "[" + "#".repeat(f) + "-".repeat(10 - f) + "] " + pct + "%";
}

function formatSignal(d) {
  const isCall = d.signal === "CALL";
  const direction = isCall ? "HIGHER / BUY" : "LOWER / SELL";
  const arrow = isCall ? "^" : "v";
  const risk = d.risk === "Low" ? "Low" : d.risk === "High" ? "High" : "Medium";

  return (
    "*NOXA AI SIGNAL*\n\n" +
    "===================\n" +
    "*" + arrow + " " + direction + "*\n" +
    "Pair: *" + d.asset + "*\n" +
    "Expiry: *" + d.expiry + "*\n" +
    "Price: *" + d.price + "*\n" +
    "===================\n\n" +
    "*INDICATORS*\n" +
    "- 24h: " + d.change24h + "\n" +
    "- RSI: " + d.rsi + "\n" +
    "- MACD: " + d.macd + "\n" +
    "- Trend: " + d.trend + "\n\n" +
    "*KEY LEVELS*\n" +
    "- Support: " + d.support + "\n" +
    "- Resistance: " + d.resistance + "\n\n" +
    "*CONFIDENCE: " + d.confidence + "%*\n" +
    bar(d.confidence) + "\n\n" +
    "Risk: " + risk + "\n\n" +
    "*ANALYSIS*\n" + d.analysis + "\n\n" +
    "*EDGE*\n" + d.edge + "\n\n" +
    "===================\n" +
    "_NOXA AI - Pocket Option_"
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "Trader";
  sessions[chatId] = { step:"idle", asset:null, expiry:null, cat:null };
  bot.sendMessage(chatId,
    "Welcome, *" + name + "*!\n\n" +
    "*NOXA AI* - Pocket Option Signal Bot\n\n" +
    "Get AI-powered HIGHER/LOWER signals for Pocket Option.\n\n" +
    "Commands:\n/analyze - Get a signal\n/help - Help",
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Get Signal Now", callback_data: "start:analyze" }]] } }
  );
});

bot.onText(/\/analyze/, (msg) => {
  const chatId = msg.chat.id;
  getSession(chatId).step = "select_cat";
  bot.sendMessage(chatId, "*Select Asset Category:*", { parse_mode: "Markdown", reply_markup: catKB() });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "1. /analyze\n2. Choose category\n3. Select pair\n4. Choose expiry\n5. Get HIGHER or LOWER signal\n\n" +
    "Categories: Forex, OTC, Crypto, Commodities, Indices\n\n" +
    "Always use risk management.",
    { parse_mode: "Markdown" }
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
    return bot.editMessageText("*Select Asset Category:*", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: catKB()
    });
  }
  if (data.startsWith("cat:")) {
    sess.cat = data.replace("cat:", "");
    sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: assetKB(sess.cat)
    });
  }

  if (data.startsWith("asset:")) {
    sess.asset = data.replace("asset:", "");
    sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: expiryKB()
    });
  }

  if (data.startsWith("expiry:")) {
    sess.expiry = data.replace("expiry:", "");
    sess.step = "confirm";
    return bot.editMessageText(
      "Ready!\n\nPair: *" + sess.asset + "*\nExpiry: *" + sess.expiry + "*\n\nTap to run NOXA AI",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: confirmKB() }
    );
  }

  if (data === "back:asset") {
    sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: assetKB(sess.cat)
    });
  }

  if (data === "back:expiry") {
    sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: expiryKB()
    });
  }

  if (data === "confirm:analyze") {
    await bot.editMessageText(
      "Analyzing *" + sess.asset + "*...\n\nNOXA AI is processing\nPlease wait 10-15 seconds...",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );

    // Step 1 - Alert channel
    try {
      await bot.sendMessage(CHANNEL_ID,
        "*SIGNAL INCOMING*\n\n" +
        "===================\n" +
        "Pair: *" + sess.asset + "*\n" +
        "Expiry: *" + sess.expiry + "*\n" +
        "===================\n\n" +
        "NOXA AI is analyzing the market...\n" +
        "*Confirmation signal coming in 15 seconds*\n\n" +
        "Get ready to trade!",
        { parse_mode: "Markdown" }
      );
    } catch (e) {}

    try {
      const result = await runAnalysis(sess.asset, sess.expiry);
      if (result) {
        // Send to user
        await bot.editMessageText(formatSignal(result), {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Analyze Again", callback_data: "confirm:analyze" }],
              [{ text: "New Pair", callback_data: "back:cat" }, { text: "New Expiry", callback_data: "back:expiry" }]
            ]
          }
        });
        // Step 2 - Confirmation to channel
        try {
          await bot.sendMessage(CHANNEL_ID,
            "*CONFIRMATION - ENTER NOW*\n\n" + formatSignal(result),
            { parse_mode: "Markdown" }
          );
        } catch (e) {
          await bot.sendMessage(chatId, "Could not post to channel. Make sure bot is admin.");
        }
      } else {
        await bot.editMessageText("Could not generate signal. Please retry.", {
          chat_id: chatId, message_id: msgId, reply_markup: retryKB()
        });
      }
    } catch (err) {
      await bot.editMessageText("Error: " + err.message + "\n\nPlease retry.", {
        chat_id: chatId, message_id: msgId, reply_markup: retryKB()
      });
    }
  }
});

console.log("NOXA AI Bot running.");
