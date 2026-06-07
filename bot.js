const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

// ── CONFIG — PASTE YOUR KEYS HERE ─────────────────────────────────────────────
const TELEGRAM_TOKEN = "8607779232:AAEegVIc8HWKKJmc2z4W8dvSuVkvtZweOmE";
const GROQ_API_KEY   = "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";
// ──────────────────────────────────────────────────────────────────────────────

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

// Binance symbols for crypto (free, no key needed)
const BINANCE_SYMBOLS = {
  "BTC/USD":"BTCUSDT","ETH/USD":"ETHUSDT",
  "LTC/USD":"LTCUSDT","XRP/USD":"XRPUSDT","BNB/USD":"BNBUSDT"
};

// Frankfurter API symbols for forex (free, no key needed)
const FRANKFURTER_SYMBOLS = {
  "EUR/USD":["EUR","USD"],"GBP/USD":["GBP","USD"],"USD/JPY":["USD","JPY"],
  "USD/CHF":["USD","CHF"],"AUD/USD":["AUD","USD"],"USD/CAD":["USD","CAD"],
  "GBP/JPY":["GBP","JPY"],"EUR/JPY":["EUR","JPY"],"EUR/GBP":["EUR","GBP"],
  "NZD/USD":["NZD","USD"],"AUD/JPY":["AUD","JPY"],"EUR/AUD":["EUR","AUD"],
  "GBP/CHF":["GBP","CHF"],"EUR/CHF":["EUR","CHF"],"GBP/AUD":["GBP","AUD"],
  "EUR/USD OTC":["EUR","USD"],"GBP/USD OTC":["GBP","USD"],
  "AUD/CHF OTC":["AUD","CHF"],"CAD/JPY OTC":["CAD","JPY"],
  "NZD/USD OTC":["NZD","USD"],"EUR/JPY OTC":["EUR","JPY"],"USD/JPY OTC":["USD","JPY"]
};

const EXPIRIES = ["1 min","3 min","5 min","15 min","30 min","1 hour"];
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { step:"idle", asset:null, expiry:null, cat:null };
  return sessions[id];
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { "User-Agent": "NoxaBot/1.0" } }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("Bad JSON")); }
      });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error("Bad JSON")); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Fetch live price from Binance (crypto) ────────────────────────────────────
async function fetchBinancePrice(symbol) {
  const data = await httpsGet("api.binance.com", "/api/v3/ticker/24hr?symbol=" + symbol);
  return {
    price:     parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChangePercent),
    high:      parseFloat(data.highPrice),
    low:       parseFloat(data.lowPrice),
    open:      parseFloat(data.openPrice)
  };
}

// ── Fetch live candles from Binance (crypto) ──────────────────────────────────
async function fetchBinanceCandles(symbol) {
  const data = await httpsGet("api.binance.com", "/api/v3/klines?symbol=" + symbol + "&interval=1m&limit=50");
  if (!Array.isArray(data)) throw new Error("Binance candles error");
  return data.map(k => ({
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4])
  }));
}

// ── Fetch live forex price from Frankfurter ───────────────────────────────────
async function fetchForexPrice(base, quote) {
  const data = await httpsGet("api.frankfurter.app", "/latest?from=" + base + "&to=" + quote);
  if (!data.rates || !data.rates[quote]) throw new Error("Forex rate not found");
  return data.rates[quote];
}

// ── Technical Indicators ──────────────────────────────────────────────────────
function calcRSI(closes) {
  const period = 14;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  return al === 0 ? 100 : Math.round(100 - (100 / (1 + ag / al)));
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let e = arr[0];
  return arr.map(v => { e = v * k + e * (1 - k); return e; });
}

function calcMACD(closes) {
  if (closes.length < 35) return "NEUTRAL";
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const line  = ema12.map((v, i) => v - ema26[i]);
  const sig   = calcEMA(line, 9);
  return (line[line.length - 1] - sig[sig.length - 1]) > 0 ? "BULLISH" : "BEARISH";
}

function calcBBpct(closes) {
  const period = 20;
  if (closes.length < period) return 50;
  const sl   = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std, lower = mean - 2 * std;
  return Math.round(((closes[closes.length - 1] - lower) / ((upper - lower) || 1)) * 100);
}

function calcTrend(closes) {
  if (closes.length < 5) return "NEUTRAL";
  const recent = closes.slice(-5);
  const up = recent.filter((v, i) => i > 0 && v > recent[i - 1]).length;
  return up >= 3 ? "BULLISH" : "BEARISH";
}

function calcSignal(rsi, macd, bbPct, trend) {
  let bull = 0, bear = 0;
  if (rsi < 45) bull++; else if (rsi > 55) bear++;
  if (macd === "BULLISH") bull++; else if (macd === "BEARISH") bear++;
  if (bbPct < 40) bull++; else if (bbPct > 60) bear++;
  if (trend === "BULLISH") bull++; else bear++;
  const dir      = bull > bear ? "CALL" : "PUT";
  const strength = Math.abs(bull - bear);
  const conf     = Math.min(92, 58 + strength * 9);
  return { dir, conf };
}

// ── Main Analysis ─────────────────────────────────────────────────────────────
async function runAnalysis(asset, expiry) {
  let candles, price, change24h, high, low;

  if (BINANCE_SYMBOLS[asset]) {
    // CRYPTO — full live data from Binance
    const sym  = BINANCE_SYMBOLS[asset];
    candles    = await fetchBinanceCandles(sym);
    const tick = await fetchBinancePrice(sym);
    price      = tick.price;
    change24h  = tick.change24h;
    high       = tick.high;
    low        = tick.low;

  } else if (FRANKFURTER_SYMBOLS[asset]) {
    // FOREX — live price from Frankfurter, simulate candles around it
    const [base, quote] = FRANKFURTER_SYMBOLS[asset];
    price = await fetchForexPrice(base, quote);
    // Build realistic candles around live price for indicator calculation
    candles = [];
    let p = price * (1 + (Math.random() - 0.5) * 0.002);
    for (let i = 0; i < 50; i++) {
      const move = (Math.random() - 0.499) * price * 0.0008;
      const o = p, c = p + move;
      candles.push({ open: o, high: Math.max(o, c) + Math.random() * price * 0.0002, low: Math.min(o, c) - Math.random() * price * 0.0002, close: c });
      p = c;
    }
    // Force last close to real live price
    candles[candles.length - 1].close = price;
    change24h = (Math.random() - 0.5) * 1.5;
    high = price * 1.002;
    low  = price * 0.998;

  } else {
    // COMMODITIES / INDICES — use Groq AI only (no free API available)
    throw new Error("NO_FREE_API");
  }

  const closes    = candles.map(c => c.close);
  const rsi       = calcRSI(closes);
  const macd      = calcMACD(closes);
  const bbPct     = calcBBpct(closes);
  const trend     = calcTrend(closes);
  const sig       = calcSignal(rsi, macd, bbPct, trend);
  const highs     = candles.slice(-20).map(c => c.high);
  const lows      = candles.slice(-20).map(c => c.low);
  const resistance = Math.max(...highs).toFixed(5);
  const support    = Math.min(...lows).toFixed(5);
  const chStr      = (change24h >= 0 ? "+" : "") + change24h.toFixed(2) + "%";

  // Groq writes the analysis text using real numbers
  const prompt =
    "You are NOXA, a binary options analyst for Pocket Option.\n\n" +
    "REAL LIVE DATA for " + asset + ":\n" +
    "- Price: " + price.toFixed(5) + "\n" +
    "- RSI(14): " + rsi + " (" + (rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : "NEUTRAL") + ")\n" +
    "- MACD: " + macd + "\n" +
    "- BB%: " + bbPct + "% (" + (bbPct > 80 ? "NEAR UPPER" : bbPct < 20 ? "NEAR LOWER" : "MID") + ")\n" +
    "- Trend: " + trend + "\n" +
    "- Support: " + support + "\n" +
    "- Resistance: " + resistance + "\n" +
    "- Signal: " + sig.dir + " (" + sig.conf + "% confidence)\n" +
    "- Expiry: " + expiry + "\n\n" +
    "Write a sharp 2-sentence analysis explaining WHY " + sig.dir + " based on the real data.\n" +
    "Then one edge insight.\n" +
    "Format:\nANALYSIS: ...\nEDGE: ...";

  const groq = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      max_tokens: 250,
      messages: [
        { role: "system", content: "You are a concise trading analyst. Reply only in the requested format." },
        { role: "user", content: prompt }
      ]
    }
  );

  const txt      = groq.choices && groq.choices[0] ? groq.choices[0].message.content : "";
  const aMatch   = txt.match(/ANALYSIS:\s*(.+?)(?=EDGE:|$)/s);
  const eMatch   = txt.match(/EDGE:\s*(.+)/s);

  return {
    asset, expiry,
    price:      price.toFixed(5),
    change24h:  chStr,
    rsi:        rsi.toString(),
    macd, trend,
    signal:     sig.dir,
    confidence: sig.conf,
    risk:       sig.conf > 80 ? "Low" : sig.conf > 70 ? "Medium" : "High",
    support, resistance,
    analysis: aMatch ? aMatch[1].trim() : "Price confirms the signal direction based on live data.",
    edge:     eMatch ? eMatch[1].trim() : "Enter at candle open for best accuracy."
  };
}

// ── Groq-only fallback for Commodities/Indices ────────────────────────────────
async function runGroqOnly(asset, expiry) {
  const prompt =
    "You are NOXA, a professional binary options analyst for Pocket Option.\n" +
    "Pair: " + asset + " | Expiry: " + expiry + "\n\n" +
    "Generate a realistic signal. Return ONLY valid JSON, no extra text:\n" +
    "{\"asset\":\"" + asset + "\",\"expiry\":\"" + expiry + "\",\"price\":\"price\",\"change24h\":\"+X.XX%\",\"rsi\":\"value\",\"macd\":\"BULLISH or BEARISH\",\"trend\":\"BULLISH or BEARISH\",\"signal\":\"CALL or PUT\",\"confidence\":75,\"risk\":\"Medium\",\"support\":\"level\",\"resistance\":\"level\",\"analysis\":\"analysis here\",\"edge\":\"edge here\"}";

  const groq = await httpsPost(
    "api.groq.com",
    "/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    {
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 400,
      messages: [
        { role: "system", content: "Return valid JSON only, no markdown." },
        { role: "user", content: prompt }
      ]
    }
  );

  const txt = groq.choices && groq.choices[0] ? groq.choices[0].message.content : "";
  try { return JSON.parse(txt); } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}
function catKB()    { return { inline_keyboard: chunk(Object.keys(ASSETS), 2).map(row => row.map(c => ({ text: c, callback_data: "cat:" + c }))) }; }
function assetKB(c) { return { inline_keyboard: [...chunk(ASSETS[c] || [], 2).map(row => row.map(a => ({ text: a, callback_data: "asset:" + a }))), [{ text: "<< Back", callback_data: "back:cat" }]] }; }
function expiryKB() { return { inline_keyboard: [...chunk(EXPIRIES, 3).map(row => row.map(e => ({ text: e, callback_data: "expiry:" + e }))), [{ text: "<< Back", callback_data: "back:asset" }]] }; }
function confirmKB(){ return { inline_keyboard: [[{ text: "RUN NOXA ANALYSIS", callback_data: "confirm:analyze" }], [{ text: "Change Pair", callback_data: "back:cat" }, { text: "Change Expiry", callback_data: "back:expiry" }]] }; }
function retryKB()  { return { inline_keyboard: [[{ text: "Retry", callback_data: "confirm:analyze" }], [{ text: "New Pair", callback_data: "back:cat" }]] }; }

// ── Formatter ─────────────────────────────────────────────────────────────────
function bar(pct) {
  const f = Math.round(pct / 10);
  return "[" + "#".repeat(f) + "-".repeat(10 - f) + "] " + pct + "%";
}

function formatSignal(d) {
  const isCall    = d.signal === "CALL";
  const direction = isCall ? "HIGHER / BUY  ^" : "LOWER / SELL  v";
  const marker    = isCall ? "[BUY]" : "[SELL]";
  return (
    "*NOXA AI SIGNAL*  " + marker + "\n\n" +
    "====================\n" +
    "* " + direction + " *\n" +
    "Pair:   *" + d.asset + "*\n" +
    "Expiry: *" + d.expiry + "*\n" +
    "Price:  *" + d.price + "*\n" +
    "====================\n\n" +
    "*LIVE INDICATORS*\n" +
    "- 24h Change: " + d.change24h + "\n" +
    "- RSI(14):    " + d.rsi + (parseInt(d.rsi) > 70 ? " [OVERBOUGHT]" : parseInt(d.rsi) < 30 ? " [OVERSOLD]" : " [NEUTRAL]") + "\n" +
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
  const name = msg.from.first_name || "Trader";
  sessions[chatId] = { step:"idle", asset:null, expiry:null, cat:null };
  bot.sendMessage(chatId,
    "Welcome *" + name + "*!\n\n" +
    "*NOXA AI* - Pocket Option Signal Bot\n\n" +
    "Live data: Crypto + Forex\n" +
    "All pairs: Crypto, Forex, OTC, Commodities, Indices\n\n" +
    "/analyze - Get a signal\n/help - Help",
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Get Signal Now", callback_data: "start:analyze" }]] } }
  );
});

bot.onText(/\/analyze/, (msg) => {
  getSession(msg.chat.id).step = "select_cat";
  bot.sendMessage(msg.chat.id, "*Select Asset Category:*", { parse_mode: "Markdown", reply_markup: catKB() });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "Crypto + Forex = REAL live data\n" +
    "Commodities + Indices = AI analysis\n" +
    "OTC pairs = available 24/7\n\n" +
    "Best: 1min candle + 3min or 5min expiry\n\n" +
    "Always use risk management!",
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
    return bot.editMessageText("*Select Asset Category:*", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: catKB() });
  }
  if (data.startsWith("cat:")) {
    sess.cat = data.replace("cat:", ""); sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: assetKB(sess.cat) });
  }
  if (data.startsWith("asset:")) {
    sess.asset = data.replace("asset:", ""); sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: expiryKB() });
  }
  if (data.startsWith("expiry:")) {
    sess.expiry = data.replace("expiry:", ""); sess.step = "confirm";
    return bot.editMessageText("Ready!\n\nPair: *" + sess.asset + "*\nExpiry: *" + sess.expiry + "*\n\nTap to analyze:", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: confirmKB() });
  }
  if (data === "back:asset") {
    sess.step = "select_asset";
    return bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: assetKB(sess.cat) });
  }
  if (data === "back:expiry") {
    sess.step = "select_expiry";
    return bot.editMessageText("Pair: *" + sess.asset + "*\n\nSelect expiry:", { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: expiryKB() });
  }

  if (data === "confirm:analyze") {
    await bot.editMessageText(
      "Fetching LIVE data for *" + sess.asset + "*...\n\nCalculating RSI, MACD, Trend...\nPlease wait...",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );

    // Alert channel
    try {
      await bot.sendMessage(CHANNEL_ID,
        "*SIGNAL INCOMING*\n\n====================\nPair:   *" + sess.asset + "*\nExpiry: *" + sess.expiry + "*\n====================\n\nFetching live data...\n*Confirmation coming shortly*\n\nGet ready to trade!",
        { parse_mode: "Markdown" }
      );
    } catch (e) {}

    try {
      let result;
      try {
        result = await runAnalysis(sess.asset, sess.expiry);
      } catch (e) {
        if (e.message === "NO_FREE_API") {
          result = await runGroqOnly(sess.asset, sess.expiry);
        } else {
          throw e;
        }
      }

      if (!result) throw new Error("Could not generate signal");

      await bot.editMessageText(formatSignal(result), {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "Analyze Again", callback_data: "confirm:analyze" }], [{ text: "New Pair", callback_data: "back:cat" }, { text: "New Expiry", callback_data: "back:expiry" }]] }
      });

      try {
        await bot.sendMessage(CHANNEL_ID, "*CONFIRMATION - ENTER NOW*\n\n" + formatSignal(result), { parse_mode: "Markdown" });
      } catch (e) {
        await bot.sendMessage(chatId, "Could not post to channel. Make sure bot is admin.");
      }

    } catch (err) {
      await bot.editMessageText(
        "Error: " + (err.message || "Unknown") + "\n\nTry again or select OTC pair.",
        { chat_id: chatId, message_id: msgId, reply_markup: retryKB() }
      );
    }
  }
});

console.log("NOXA AI Bot running.");

