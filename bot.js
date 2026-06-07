const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const yahooFinance = require("yahoo-finance2").default;

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

// ── Yahoo Finance Ticker Mapping ─────────────────────────────────────────────
// Maps Pocket Option names to Yahoo Finance ticker symbols
const TICKER_MAP = {
  // Forex
  "EUR/USD": "EURUSD=X", "GBP/USD": "GBPUSD=X", "USD/JPY": "JPY=X", 
  "USD/CHF": "CHF=X", "AUD/USD": "AUDUSD=X", "USD/CAD": "CAD=X",
  "GBP/JPY": "GBPJPY=X", "EUR/JPY": "EURJPY=X", "EUR/GBP": "EURGBP=X",
  "NZD/USD": "NZDUSD=X", "AUD/JPY": "AUDJPY=X", "EUR/AUD": "EURAUD=X",
  "GBP/CHF": "GBPCHF=X", "EUR/CHF": "EURCHF=X", "AUD/CAD": "AUDCAD=X",
  "GBP/AUD": "GBPAUD=X", "EUR/NZD": "EURNZD=X", "GBP/NZD": "GBPNZD=X",
  "NZD/JPY": "NZDJPY=X", "USD/SGD": "SGD=X",
  // OTC (use same tickers as regular, just flagged differently)
  "EUR/USD OTC": "EURUSD=X", "GBP/USD OTC": "GBPUSD=X", "AUD/CHF OTC": "AUDCHF=X",
  "CAD/JPY OTC": "CADJPY=X", "NZD/USD OTC": "NZDUSD=X", "EUR/JPY OTC": "EURJPY=X",
  "USD/JPY OTC": "JPY=X",
  // Crypto (Yahoo uses -USD suffix)
  "BTC/USD": "BTC-USD", "ETH/USD": "ETH-USD", "LTC/USD": "LTC-USD",
  "XRP/USD": "XRP-USD", "BNB/USD": "BNB-USD",
  // Commodities
  "GOLD/USD": "GC=F", "SILVER/USD": "SI=F", "OIL/USD": "CL=F",
  "BRENT/USD": "BZ=F", "PLATINUM/USD": "PL=F",
  // Indices
  "US500": "^GSPC", "US30": "^DJI", "NASDAQ": "^IXIC",
  "UK100": "^FTSE", "GER40": "^GDAXI"
};

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
      row.map(c => ({ text: c, callback_data: cat:${c} }))
    )
  };
}

function assetKeyboard(cat) {
  const list = ASSETS[cat] || [];
  return {
    inline_keyboard: [
      ...chunkArray(list, 2).map(row =>
        row.map(a => ({ text: a, callback_data: asset:${a} }))
      ),
      [{ text: "⬅️ Back", callback_data: "back:cat" }]
    ]
  };
}

function expiryKeyboard() {
  return {
    inline_keyboard: [
      ...chunkArray(EXPIRIES, 4).map(row =>
        row.map(e => ({ text: e, callback_data: expiry:${e} }))
      ),
      [{ text: "⬅️ Back", callback_data: "back:asset" }]
    ]
  };
}

function confirmKeyboard(asset, expiry) {
  return {
    inline_keyboard: [
      [{ text: ⚡ Analyze ${asset} · ${expiry}, callback_data: "confirm:analyze" }],
      [{ text: "🔄 Change Asset", callback_data: "back:cat" }, { text: "🕒 Change Expiry", callback_data: "back:expiry" }]
    ]
  };
}
// ── Technical Indicators ───────────────────────────────────────────────────────
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(closes) {
  if (closes.length < 26) return { signal: "NEUTRAL", value: 0 };
  
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  };
  
  const ema12 = ema(closes.slice(-12), 12);
  const ema26 = ema(closes.slice(-26), 26);
  const macdLine = ema12 - ema26;
  
  // Simple signal line (9-period EMA of MACD)
  const signalLine = macdLine * 0.2; // Simplified
  
  return {
    signal: macdLine > signalLine ? "BULLISH" : macdLine < signalLine ? "BEARISH" : "NEUTRAL",
    value: macdLine.toFixed(4)
  };
}

function findSupportResistance(highs, lows, closes) {
  const recent = 20;
  const recentHighs = highs.slice(-recent);
  const recentLows = lows.slice(-recent);
  
  const resistance = Math.max(...recentHighs);
  const support = Math.min(...recentLows);
  const current = closes[closes.length - 1];
  
  return {
    support: support.toFixed(Math.max(2, current < 1 ? 4 : 2)),
    resistance: resistance.toFixed(Math.max(2, current < 1 ? 4 : 2))
  };
}

function calculateTrend(closes) {
  const short = closes.slice(-5);
  const long = closes.slice(-20);
  const shortAvg = short.reduce((a,b) => a+b, 0) / short.length;
  const longAvg = long.reduce((a,b) => a+b, 0) / long.length;
  
  if (shortAvg > longAvg * 1.001) return "BULLISH";
  if (shortAvg < longAvg * 0.999) return "BEARISH";
  return "NEUTRAL";
}

// ── Format AI result as Telegram message ─────────────────────────────────────
function formatSignal(data) {
  const isCall = data.signal === "CALL";
  const arrow  = isCall ? "▲" : "▼";
  const dir    = isCall ? "CALL" : "PUT";
  const emoji  = isCall ? "🟢" : "🔴";
  const risk   = data.risk === "Low" ? "🟢 Low" : data.risk === "High" ? "🔴 High" : "🟡 Medium";

  return ${emoji} *NOXA AI SIGNAL*

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
_Powered by NOXA AI · Pocket Option_;
}

function generateBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) +  ${pct}%;
}

// ── Live Market Data Fetcher ──────────────────────────────────────────────────
async function fetchLiveData(asset) {
  const ticker = TICKER_MAP[asset];
  if (!ticker) throw new Error(No ticker mapping for ${asset});
  
  try {
    // Fetch real-time quote and historical data for indicators
    const [quote, history] = await Promise.all([
      yahooFinance.quote(ticker),
      yahooFinance.chart(ticker, { 
        period: "1mo", 
        interval: "1h" 
      })
    ]);
    
    const closes = history.quotes.map(q => q.close).filter(c => c !== null);
    const highs = history.quotes.map(q => q.high).filter(h => h !== null);
    const lows = history.quotes.map(q => q.low).filter(l => l !== null);
    if (closes.length < 20) throw new Error("Insufficient historical data");
    
    const currentPrice = quote.regularMarketPrice || closes[closes.length - 1];
    const prevClose = quote.regularMarketPreviousClose  closes[closes.length - 2]  currentPrice;
    const change24h = ((currentPrice - prevClose) / prevClose * 100).toFixed(2);
    
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const trend = calculateTrend(closes);
    const levels = findSupportResistance(highs, lows, closes);
    
    // Determine signal based on technicals
    let signal = "CALL";
    let confidence = 50;
    let risk = "Medium";
    
    if (rsi !== null) {
      if (rsi < 30 && macd.signal === "BULLISH") {
        signal = "CALL";
        confidence = Math.min(85, 70 + (30 - rsi));
        risk = rsi < 20 ? "Low" : "Medium";
      } else if (rsi > 70 && macd.signal === "BEARISH") {
        signal = "PUT";
        confidence = Math.min(85, 70 + (rsi - 70));
        risk = rsi > 80 ? "Low" : "Medium";
      } else if (macd.signal === "BULLISH" && trend === "BULLISH") {
        signal = "CALL";
        confidence = 65;
        risk = "Medium";
      } else if (macd.signal === "BEARISH" && trend === "BEARISH") {
        signal = "PUT";
        confidence = 65;
        risk = "Medium";
      } else {
        signal = trend === "BULLISH" ? "CALL" : "PUT";
        confidence = 55;
        risk = "High";
      }
    }
    
    // Adjust confidence based on price position relative to S/R
    const distToSupport = (currentPrice - parseFloat(levels.support)) / currentPrice * 100;
    const distToResistance = (parseFloat(levels.resistance) - currentPrice) / currentPrice * 100;
    
    if (signal === "CALL" && distToSupport < 1) confidence = Math.min(95, confidence + 10);
    if (signal === "PUT" && distToResistance < 1) confidence = Math.min(95, confidence + 10);
    
    return {
      asset: asset,
      price: currentPrice.toFixed(currentPrice < 1 ? 5 : currentPrice < 10 ? 4 : 2),
      change24h: (change24h > 0 ? "+" : "") + change24h + "%",
      rsi: rsi ? rsi.toFixed(1) : "N/A",
      macd: macd.signal,
      trend: trend,
      signal: signal,
      confidence: Math.round(confidence),
      risk: risk,
      support: levels.support,
      resistance: levels.resistance,
      rawData: { quote, history } // Pass to AI for analysis text
    };
    
  } catch (error) {
    console.error(Error fetching data for ${asset}:, error.message);
    throw error;
  }
}

// ── AI Analysis (now uses live data for narrative) ───────────────────────────
async function runAnalysis(chatId, asset, expiry) {
  const isOTC = asset.includes("OTC");
  
  try {
    // Step 1: Fetch live market data (fast, ~1-2 seconds)
    const marketData = await fetchLiveData(asset);
    
    // Step 2: Generate AI narrative using the live data
    const prompt = You are NOXA, a professional binary options analyst. 
    
LIVE MARKET DATA for ${asset}:
- Current Price: ${marketData.price}
- 24h Change: ${marketData.change24h}
- RSI(14): ${marketData.rsi}
- MACD: ${marketData.macd}
- Trend: ${marketData.trend}
- Support: ${marketData.support}
- Resistance: ${marketData.resistance}
- Signal: ${marketData.signal}
- Confidence: ${marketData.confidence}%
- Risk: ${marketData.risk}

Expiry requested: ${expiry}
${isOTC ? "This is an OTC pair (24/7 trading)." : ""}

Based on this live data, write:
1. A sharp 2-3 sentence market analysis explaining WHY this signal is generated
2. One specific tactical insight for trading this pair with ${expiry} expiry

Return ONLY this JSON:
\\\json
{
  "analysis": "your market analysis here",
  "edge": "your tactical insight here"
}
\\\``;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }]
    });

    const fullText = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
    // Parse AI narrative
    let aiResult = { analysis: "Technical indicators align with momentum.", edge: "Watch for breakout confirmation before entry." };
    try {
      const match = fullText.match(/`json\s*([\s\S]*?)```/);
      if (match) aiResult = JSON.parse(match[1]);
      else {
        const obj = fullText.match(/\{[\s\S]*\}/);
        if (obj) aiResult = JSON.parse(obj[0]);
      }
    } catch (e) {
      console.log("AI parse failed, using defaults");
    }

    // Combine live data + AI narrative
    return {
      ...marketData,
      expiry: expiry,
      analysis: aiResult.analysis,
      edge: aiResult.edge
    };

  } catch (error) {
    console.error("Analysis error:", error);
    throw error;
  }
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
      🎯 *Ready to Analyze*\n\n +
      • Pair: *${sess.asset}*\n +
      • Expiry: *${sess.expiry}*\n\n +
      Tap below to run NOXA AI ⚡,
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
    bot.editMessageText(📂 *${sess.cat}*\n\nSelect your trading pair:, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: assetKeyboard(sess.cat)
    });
    return;
  }

  // Back: expiry
  if (data === "back:expiry") {
    sess.step = "select_expiry";
    bot.editMessageText(✅ Asset: *${sess.asset}*\n\n⏱ Select expiry time:, {
      chat_id: chatId, message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: expiryKeyboard()
    });
    return;
  }

  // Confirm: run analysis
  if (data === "confirm:analyze") {
    bot.editMessageText(
      🔍 *Fetching live ${sess.asset} data...*\n\n +
      🧠 AI is analyzing the market\n +
      ⏳ This takes about 3-5 seconds...,
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
      bot.editMessageText(❌ Error: ${err.message}\n\nPlease try again., {
        chat_id: chatId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: "🔄 Retry", callback_data: "confirm:analyze" }]] }
      });
    }
    return;
  }
});

console.log("🤖 NOXA AI Bot is running with LIVE market data...");
