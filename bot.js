const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

const bot      = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

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

// ── User session state ────────────────────────────────────────────────────────
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { step: "idle", asset: null, expiry: null };
  }
  return sessions[chatId];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function categoryKeyboard() {
  const cats = Object.keys(ASSETS);
  return {
    inline_keyboard: chunkArray(cats, 2).map(row =>
      row.map(c => ({ text: c, callback_data: `cat:${c}` }))
    )
  };
}

function assetKeyboard(cat) {
  const list = ASSETS[cat] || [];
  return {
    inline_keyboard: [
      ...chunkArray(list, 2).map(row =>
        row.map(a => ({ text: a, callback_data: `asset:${a}` }))
      ),
      [{ text: "⬅️ Back", callback_data: "back:cat" }]
    ]
  };
}

function expiryKeyboard() {
  return {
    inline_keyboard: [
      ...chunkArray(EXPIRIES, 4).map(row =>
        row.map(e => ({ text: e, callback_data: `expiry:${e}` }))
      ),
      [{ text: "⬅️ Back", callback_data: "back:asset" }]
    ]
  };
}

function confirmKeyboard(asset, expiry) {
  return {
    inline_keyboard: [
      [{ text: `⚡ Analyze ${asset} · ${expiry}`, callback_data: "confirm:analyze" }],
      [{ text: "🔄 Change Asset", callback_data: "back:cat" }, { text: "🕒 Change Expiry", callback_data: "back:expiry" }]
    ]
  };
}

// ── Format AI result as Telegram message ─────────────────────────────────────
function formatSignal(data) {
  const isCall = data.signal === "CALL";
  const arrow  = isCall ? "▲" : "▼";
  const dir    = isCall ? "CALL" : "PUT";
  const emoji  = isCall ? "🟢" : "🔴";
  const risk   = data.risk === "Low" ? "🟢 Low" : data.risk === "High" ? "🔴 High" : "🟡 Medium";

  return `${emoji} *NOXA AI SIGNAL*

━━━━━━━━━━━━━━━━━━━
*${arrow} ${dir}* · ${data.asset}
⏱ Expiry: *${data.expiry}*
💰 Price: *${data.price}*
━━━━━━━━━━━━━━━━━━━

📊 *INDICATORS*
• 24h Change: ${data.change24h}
• RSI(14): ${data.rsi}
• MACD: ${data.macd}
• Trend: ${data.trend}

📍 *KEY LEVELS*
• Support: ${data.support}
• Resistance: ${data.resistance}

🎯 *CONFIDENCE: ${data.confidence}%*
${generateBar(data.confidence)}

⚠️ Risk: ${risk}

📝 *ANALYSIS*
${data.analysis}

⚡ *EDGE*
${data.edge}

━━━━━━━━━━━━━━━━━━━
_Powered by NOXA AI · Pocket Option_`;
}

function generateBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${pct}%`;
}

// ── Run AI Analysis ───────────────────────────────────────────────────────────
async function runAnalysis(chatId, asset, expiry) {
  const isOTC    = asset.includes("OTC");
  const clean    = asset.replace(" OTC", "");

  const prompt = `You are NOXA, a professional binary options AI analyst for Pocket Option traders.

Trader wants to trade: ${asset} on Pocket Option with ${expiry} expiry.
${isOTC ? "NOTE: This is an OTC pair — available 24/7 including weekends." : ""}

Use web_search to find:
1. Current live price for ${clean}
2. RSI and technical analysis for ${clean} today

Return ONLY this JSON, nothing else:
\`\`\`json
{
  "asset": "${asset}",
  "expiry": "${expiry}",
  "price": "CURRENT_PRICE",
  "change24h": "+X.XX% or -X.XX%",
  "rsi": "RSI_VALUE",
  "macd": "BULLISH or BEARISH",
  "trend": "BULLISH or BEARISH",
  "signal": "CALL or PUT",
  "confidence": NUMBER_50_TO_95,
  "risk": "Low or Medium or High",
  "support": "SUPPORT_PRICE",
  "resistance": "RESISTANCE_PRICE",
  "analysis": "2-3 sentence sharp market analysis with real context",
  "edge": "One specific tactical insight for this trade"
}
\`\`\``;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: prompt }]
  });

  const fullText = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  // Parse JSON
  let parsed = null;
  try {
    const match = fullText.match(/```json\s*([\s\S]*?)```/);
    if (match) parsed = JSON.parse(match[1]);
    else {
      const obj = fullText.match(/\{[\s\S]*\}/);
      if (obj) parsed = JSON.parse(obj[0]);
    }
  } catch {}

  return parsed;
}

// ── /start command ────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name   = msg.from.first_name || "Trader";
  sessions[chatId] = { step: "idle", asset: null, expiry: null };

  bot.sendMessage(chatId,
    `👋 Welcome back, *${name}!*\n\n` +
    `🤖 *NOXA AI* — Pocket Option Signal Bot\n\n` +
    `I fetch *live market data* and generate *AI-powered CALL/PUT signals* tailored for your Pocket Option trades.\n\n` +
    `*Commands:*\n` +
    `/analyze — Get a new signal\n` +
    `/help — How to use NOXA\n\n` +
    `Tap below to start 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "⚡ Get Signal Now", callback_data: "start:analyze" }]]
      }
    }
  );
});

// ── /analyze command ──────────────────────────────────────────────────────────
bot.onText(/\/analyze/, (msg) => {
  const chatId = msg.chat.id;
  getSession(chatId).step = "select_cat";
  bot.sendMessage(chatId, "📂 *Select Asset Category:*", {
    parse_mode: "Markdown",
    reply_markup: categoryKeyboard()
  });
});

// ── /help command ─────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *NOXA AI — Help*\n\n` +
    `*How to get a signal:*\n` +
    `1️⃣ Tap /analyze\n` +
    `2️⃣ Choose asset category (Forex, Crypto, etc.)\n` +
    `3️⃣ Select your trading pair\n` +
    `4️⃣ Choose expiry time\n` +
    `5️⃣ Confirm — NOXA fetches live data & gives you CALL or PUT\n\n` +
    `*Asset Categories:*\n` +
    `• 📈 Forex — 20 major/minor pairs\n` +
    `• 🌙 Forex OTC — Weekend 24/7 pairs\n` +
    `• ₿ Crypto — BTC, ETH, LTC, XRP, BNB\n` +
    `• 🥇 Commodities — Gold, Silver, Oil\n` +
    `• 📊 Indices — US500, NASDAQ, UK100\n\n` +
    `*Expiry options:* 30s · 1m · 2m · 5m · 15m · 30m · 1h · 4h\n\n` +
    `⚠️ _Signals are AI-generated. Always use risk management._`,
    { parse_mode: "Markdown" }
  );
});

// ── Callback handler ──────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const sess   = getSession(chatId);

  await bot.answerCallbackQuery(query.id);

  // Start analyze
  if (data === "start:analyze") {
    sess.step = "select_cat";
    bot.editMessageText("📂 *Select Asset Category:*", {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: categoryKeyboard()
    });
    return;
  }

  // Category selected
  if (data.startsWith("cat:")) {
    const cat = data.replace("cat:", "");
    sess.cat  = cat;
    sess.step = "select_asset";
    bot.editMessageText(`📂 *${cat}*\n\nSelect your trading pair:`, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: assetKeyboard(cat)
    });
    return;
  }

  // Asset selected
  if (data.startsWith("asset:")) {
    sess.asset = data.replace("asset:", "");
    sess.step  = "select_expiry";
    bot.editMessageText(`✅ Asset: *${sess.asset}*\n\n⏱ Select expiry time:`, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: expiryKeyboard()
    });
    return;
  }

  // Expiry selected
  if (data.startsWith("expiry:")) {
    sess.expiry = data.replace("expiry:", "");
    sess.step   = "confirm";
    bot.editMessageText(
      `🎯 *Ready to Analyze*\n\n` +
      `• Pair: *${sess.asset}*\n` +
      `• Expiry: *${sess.expiry}*\n\n` +
      `Tap below to run NOXA AI ⚡`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: confirmKeyboard(sess.asset, sess.expiry)
      }
    );
    return;
  }

  // Back: category
  if (data === "back:cat") {
    sess.step = "select_cat";
    bot.editMessageText("📂 *Select Asset Category:*", {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: categoryKeyboard()
    });
    return;
  }

  // Back: asset
  if (data === "back:asset") {
    sess.step = "select_asset";
    bot.editMessageText(`📂 *${sess.cat}*\n\nSelect your trading pair:`, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: assetKeyboard(sess.cat)
    });
    return;
  }

  // Back: expiry
  if (data === "back:expiry") {
    sess.step = "select_expiry";
    bot.editMessageText(`✅ Asset: *${sess.asset}*\n\n⏱ Select expiry time:`, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: expiryKeyboard()
    });
    return;
  }

  // Confirm: run analysis
  if (data === "confirm:analyze") {
    bot.editMessageText(
      `🔍 *Fetching live ${sess.asset} data...*\n\n` +
      `🧠 AI is analyzing the market\n` +
      `⏳ This takes about 15-20 seconds...`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );

    try {
      const result = await runAnalysis(chatId, sess.asset, sess.expiry);
      if (result) {
        const text = formatSignal(result);
        bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Analyze Again", callback_data: "confirm:analyze" }],
              [{ text: "📂 New Pair", callback_data: "back:cat" }, { text: "⏱ New Expiry", callback_data: "back:expiry" }]
            ]
          }
        });
      } else {
        bot.editMessageText("⚠️ Could not parse signal. Please try again.", {
          chat_id: chatId, message_id: msgId,
          reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "confirm:analyze" }]] }
        });
      }
    } catch (err) {
      bot.editMessageText(`❌ Error: ${err.message}\n\nPlease try again.`, {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "confirm:analyze" }]] }
      });
    }
    return;
  }
});

console.log("🤖 NOXA AI Bot is running...");
