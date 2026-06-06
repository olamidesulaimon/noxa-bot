const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

// ── Config — PASTE YOUR KEYS HERE ────────────────────────────────────────────
const TELEGRAM_TOKEN = "PASTE_YOUR_TELEGRAM_TOKEN_HERE";
const GROQ_API_KEY   = "PASTE_YOUR_GROQ_API_KEY_HERE";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ── Pocket Option Assets ──────────────────────────────────────────────────────
const ASSETS = {
  "📈 FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD",
    "USD/CAD","GBP/JPY","EUR/JPY","EUR/GBP","NZD/USD",
    "AUD/JPY","EUR/AUD","GBP/CHF","EUR/CHF","AUD/CAD",
    "GBP/AUD","EUR/NZD","GBP/NZD","NZD/JPY","USD/SGD"
  ],
  "🌙 FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","AUD/CHF OTC",
    "CAD/JPY OTC","NZD/USD OTC","EUR/JPY OTC","USD/JPY OTC"
  ],
  "₿ CRYPTO": [
    "BTC/USD","ETH/USD","LTC/USD","XRP/USD","BNB/USD"
  ],
  "🥇 COMMODITIES": [
    "GOLD/USD","SILVER/USD","OIL/USD","BRENT/USD","PLATINUM/USD"
  ],
  "📊 INDICES": [
    "US500","US30","NASDAQ","UK100","GER40"
  ]
};

const EXPIRIES = ["30 sec","1 min","2 min","5 min","15 min","30 min","1 hour","4 hour"];

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle", asset: null, expiry: null, cat: null };
  return sessions[chatId];
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

function categoryKeyboard() {
  return { inline_keyboard: chunk(Object.keys(ASSETS), 2).map(row => row.map(c => ({ text: c, callback_data: `cat:${c}` }))) };
}

function assetKeyboard(cat) {
  return {
    inline_keyboard: [
      ...chunk(ASSETS[cat] || [], 2).map(row => row.map(a => ({ text: a, callback_data: `asset:${a}` }))),
      [{ text: "⬅️ Back", callback_data: "back:cat" }]
    ]
  };
}

function expiryKeyboard() {
  return {
    inline_keyboard: [
      ...chunk(EXPIRIES, 4).map(row => row.map(e => ({ text: e, callback_data: `expiry:${e}` }))),
      [{ text: "⬅️ Back", callback_data: "back:asset" }]
    ]
  };
}

function confirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⚡ Run NOXA Analysis", callback_data: "confirm:analyze" }],
      [{ text: "🔄 Change Pair", callback_data: "back:cat" }, { text: "🕒 Change Expiry", callback_data: "back:expiry" }]
    ]
  };
}

// ── Format Signal ─────────────────────────────────────────────────────────────
function bar(pct) {
  const f = Math.round(pct / 10);
  return "█".repeat(f) + "░".repeat(10 - f) + ` ${pct}%`;
}

function formatSignal(d) {
  const isCall = d.signal === "CALL";
  const emoji  = isCall ? "🟢" : "🔴";
  const arrow  = isCall ? "▲" : "▼";
  const risk   = d.risk === "Low" ? "🟢 Low" : d.risk === "High" ? "🔴 High" : "🟡 Medium";

  return `${emoji} *NOXA AI SIGNAL*

━━━━━━━━━━━━━━━━━━━
*${arrow} ${d.signal}* · ${d.asset}
⏱ Expiry: *${d.expiry}*
💰 Price: *${d.price}*
━━━━━━━━━━━━━━━━━━━

📊 *INDICATORS*
• 24h Change: ${d.change24h}
• RSI\\(14\\): ${d.rsi}
• MACD: ${d.macd}
• Trend: ${d.trend}

📍 *KEY LEVELS*
• Support: ${d.support}
• Resistance: ${d.resistance}

🎯 *CONFIDENCE: ${d.confidence}%*
${bar(d.confidence)}

⚠️ Risk: ${risk}

📝 *ANALYSIS*
${d.analysis}

⚡ *EDGE*
${d.edge}

━━━━━━━━━━━━━━━━━━━
_Powered by NOXA AI · Pocket Option_`;
}

// ── Groq AI Analysis ──────────────────────────────────────────────────────────
async function runAnalysis(asset, expiry) {
  const isOTC = asset.includes("OTC");
  const clean = asset.replace(" OTC", "");

  const prompt = `You are NOXA, a professional binary options AI analyst for Pocket Option traders.

Pair: ${asset} | Expiry: ${expiry}
${isOTC ? "This is an OTC pair available 24/7." : ""}

Based on your knowledge of ${clean} price behavior, technical patterns, and current market conditions, generate a realistic binary options signal.

Return ONLY valid JSON, no extra text:
{
  "asset": "${asset}",
  "expiry": "${expiry}",
  "price": "current approximate price",
  "change24h": "+X.XX% or -X.XX%",
  "rsi": "estimated RSI value 1-100",
  "macd": "BULLISH or BEARISH",
  "trend": "BULLISH or BEARISH",
  "signal": "CALL or PUT",
  "confidence": number between 60 and 92,
  "risk": "Low or Medium or High",
  "support": "key support price level",
  "resistance": "key resistance price level",
  "analysis": "2-3 sentence sharp market analysis with specific price context",
  "edge": "one specific tactical insight for this trade"
}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 1000,
      messages: [
        { role: "system", content: "You are a professional binary options analyst. Always respond with valid JSON only, no markdown, no extra text." },
        { role: "user", content: prompt }
      ]
    })
  });

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";

  // Parse JSON
  let parsed = null;
  try {
    // Try direct parse first
    parsed = JSON.parse(text);
  } catch {
    try {
      // Try extracting JSON block
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch {}
  }

  return parsed;
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "Trader";
  sessions[chatId] = { step: "idle", asset: null, expiry: null, cat: null };

  bot.sendMessage(chatId,
    `👋 Welcome, *${name}\\!*\n\n` +
    `🤖 *NOXA AI* — Pocket Option Signal Bot\n\n` +
    `I generate AI\\-powered *CALL/PUT signals* for your Pocket Option trades\\.\n\n` +
    `*Commands:*\n` +
    `/analyze — Get a new signal\n` +
    `/help — How to use\n\n` +
    `Tap below to start 👇`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "⚡ Get Signal Now", callback_data: "start:analyze" }]] }
    }
  );
});

bot.onText(/\/analyze/, (msg) => {
  const chatId = msg.chat.id;
  getSession(chatId).step = "select_cat";
  bot.sendMessage(chatId, "📂 *Select Asset Category:*", {
    parse_mode: "Markdown",
    reply_markup: categoryKeyboard()
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *NOXA AI Help*\n\n` +
    `*How to get a signal:*\n` +
    `1️⃣ /analyze\n` +
    `2️⃣ Choose category\n` +
    `3️⃣ Select pair\n` +
    `4️⃣ Choose expiry\n` +
    `5️⃣ Get CALL or PUT signal\n\n` +
    `*Categories:*\n` +
    `• 📈 Forex — 20 pairs\n` +
    `• 🌙 Forex OTC — 24/7 pairs\n` +
    `• ₿ Crypto — BTC ETH etc\n` +
    `• 🥇 Commodities — Gold Silver Oil\n` +
    `• 📊 Indices — US500 NASDAQ etc\n\n` +
    `⚠️ _Always use risk management\\._`,
    { parse_mode: "Markdown" }
  );
});

// ── Callback Handler ──────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const sess   = getSession(chatId);

  await bot.answerCallbackQuery(query.id);

  if (data === "start:analyze") {
    sess.step = "select_cat";
    return bot.editMessageText("📂 *Select Asset Category:*", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: categoryKeyboard()
    });
  }

  if (data.startsWith("cat:")) {
    sess.cat  = data.replace("cat:", "");
    sess.step = "select_asset";
    return bot.editMessageText(`📂 *${sess.cat}*\n\nSelect your pair:`, {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: assetKeyboard(sess.cat)
    });
  }

  if (data.startsWith("asset:")) {
    sess.asset = data.replace("asset:", "");
    sess.step  = "select_expiry";
    return bot.editMessageText(`✅ Pair: *${sess.asset}*\n\n⏱ Select expiry:`, {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: expiryKeyboard()
    });
  }

  if (data.startsWith("expiry:")) {
    sess.expiry = data.replace("expiry:", "");
    sess.step   = "confirm";
    return bot.editMessageText(
      `🎯 *Ready to Analyze*\n\n• Pair: *${sess.asset}*\n• Expiry: *${sess.expiry}*\n\nTap to run NOXA AI ⚡`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: confirmKeyboard() }
    );
  }

  if (data === "back:cat") {
    sess.step = "select_cat";
    return bot.editMessageText("📂 *Select Asset Category:*", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: categoryKeyboard()
    });
  }

  if (data === "back:asset") {
    sess.step = "select_asset";
    return bot.editMessageText(`📂 *${sess.cat}*\n\nSelect your pair:`, {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: assetKeyboard(sess.cat)
    });
  }

  if (data === "back:expiry") {
    sess.step = "select_expiry";
    return bot.editMessageText(`✅ Pair: *${sess.asset}*\n\n⏱ Select expiry:`, {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: expiryKeyboard()
    });
  }

  if (data === "confirm:analyze") {
    await bot.editMessageText(
      `🔍 *Analyzing ${sess.asset}...*\n\n🧠 NOXA AI is processing\n⏳ Please wait 10\\-15 seconds\\.\\.\\.`,
      { chat_id: chatId, message_id: msgId, parse_mode: "MarkdownV2" }
    );

    try {
      const result = await runAnalysis(sess.asset, sess.expiry);
      if (result) {
        await bot.editMessageText(formatSignal(result), {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Analyze Again", callback_data: "confirm:analyze" }],
              [{ text: "📂 New Pair", callback_data: "back:cat" }, { text: "⏱ New Expiry", callback_data: "back:expiry" }]
            ]
          }
        });
      } else {
        await bot.editMessageText("⚠️ Could not generate signal. Please try again.", {
          chat_id: chatId, message_id: msgId,
          reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "confirm:analyze" }]] }
        });
      }
    } catch (err) {
      await bot.editMessageText(`❌ Error: ${err.message}`, {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "confirm:analyze" }]] }
      });
    }
  }
});

console.log("🤖 NOXA AI Bot is running... (Powered by Groq - FREE)");
