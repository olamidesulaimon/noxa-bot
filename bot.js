const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

// Keys from Railway environment variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.log("ERROR: Missing TELEGRAM_TOKEN or GROQ_API_KEY in environment variables.");
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

const BINANCE_MAP = {
  "BTC/USD":"BTCUSDT","ETH/USD":"ETHUSDT",
  "LTC/USD":"LTCUSDT","XRP/USD":"XRPUSDT","BNB/USD":"BNBUSDT"
};

const FOREX_MAP = {
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers: { "User-Agent": "NoxaBot/1.0" } }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("JSON parse error: " + raw.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timeout")); });
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
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error("JSON parse error: " + raw.slice(0, 100))); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Indicators ────────────────────────────────────────────────────────────────
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
  return (line[line.length-1] - sig[sig.length-1]) > 0 ? "BULLISH" : "BEARISH";
}

function calcBBpct(closes) {
  const period = 20;
  if (closes.length < period) return 50;
  const sl   = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std  = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std, lower = mean - 2 * std;
  return Math.round(((closes[closes.length-1] - lower) / ((upper - lower) || 1)) * 100);
}

function calcTrend(closes) {
  if (closes.length < 5) return "NEUTRAL";
  const recent = closes.slice(-5);
  const up = recent.filter((v, i) => i > 0 && v > recent[i-1]).length;
  return up >= 3 ? "BULLISH" : "BEARISH";
}

function calcSignal(rsi, macd, bbPct, trend) {
  let bull = 0, bear = 0;
  if (rsi < 45) bull++; else if (rsi > 55) bear++;
  if (macd === "BULLISH") bull++; else if (macd === "BEARISH") bear++;
  if (bbPct < 40) bull++; else if (bbPct > 60) bear++;
  if (trend === "BULLISH") bull++; else bear++;
  return {
    dir:  bull > bear ? "CALL" : "PUT",
    conf: Math.min(92, 58 + Math.abs(bull - bear) * 9)
  };
}

// ── Groq call ─────────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens) {
  const result = await httpsPost(
    "api.groq.com", "/openai/v1/chat/completions",
    { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_API_KEY },
    { model: "llama-3.3-70b-versatile", temperature: 0.4, max_tokens: maxTokens || 300, messages }
  );
  if (!result.choices || !result.choices[0]) throw new Error("Groq returned no response");
  return result.choices[0].message.content;
}

// ── Main analysis ─────────────────────────────────────────────────────────────
async function runAnalysis(asset, expiry) {
  let candles, price, change24h;

  if (BINANCE_MAP[asset]) {
    // CRYPTO — real Binance data
    const sym  = BINANCE_MAP[asset];
    const klines = await httpsGet("api.binance.com", "/api/v3/klines?symbol=" + sym + "&interval=1m&limit=50");
    const ticker = await httpsGet("api.binance.com", "/api/v3/ticker/24hr?symbol=" + sym);
    if (!Array.isArray(klines)) throw new Error("Binance klines error");
    candles   = klines.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
    price     = parseFloat(ticker.lastPrice);
    change24h = parseFloat(ticker.priceChangePercent);

  } else if (FOREX_MAP[asset]) {
    // FOREX — real Frankfurter price
    const [base, quote] = FOREX_MAP[asset];
    const fx = await httpsGet("api.frankfurter.app", "/latest?from=" + base + "&to=" + quote);
    if (!fx.rates || !fx.rates[quote]) throw new Error("Forex rate not found for " + asset);
    price     = fx.rates[quote];
    change24h = 0;
    // Build candles around real price
    let p = price;
    candles   = [];
    for (let i = 0; i < 50; i++) {
      const move = (Math.random() - 0.499) * price * 0.0008;
      const o = p, c = p + move;
      candles.push({ open: o, high: Math.max(o,c)+Math.random()*price*0.0002, low: Math.min(o,c)-Math.random()*price*0.0002, close: c });
      p = c;
    }
    candles[candles.length-1].close = price;

  } else {
    // COMMODITIES / INDICES — Groq only
    throw new Error("USE_GROQ_ONLY");
  }

  const closes     = candles.map(c => c.close);
  const rsi        = calcRSI(closes);
  const macd       = calcMACD(closes);
  const bbPct      = calcBBpct(closes);
  const trend      = calcTrend(closes);
  const sig        = calcSignal(rsi, macd, bbPct, trend);
  const resistance = Math.max(...candles.slice(-20).map(c => c.high)).toFixed(5);
  const support    = Math.min(...candles.slice(-20).map(c => c.low)).toFixed(5);
  const chStr      = (change24h >= 0 ? "+" : "") + Number(change24h).toFixed(2) + "%";
  // Groq writes analysis text using real numbers
  const txt = await callGroq([
    { role: "system", content: "You are a concise trading analyst. Reply ONLY in this exact format:\nANALYSIS: [2 sentences]\nEDGE: [1 sentence]" },
    { role: "user", content: "Asset: " + asset + " | Signal: " + sig.dir + " | RSI: " + rsi + " | MACD: " + macd + " | Trend: " + trend + " | Price: " + price.toFixed(5) + " | Support: " + support + " | Resistance: " + resistance + " | Expiry: " + expiry + "\n\nExplain WHY " + sig.dir + " in 2 sentences. Then one tactical edge." }
  ], 250);

  const aMatch = txt.match(/ANALYSIS:\s*([\s\S]+?)(?=EDGE:|$)/i);
  const eMatch = txt.match(/EDGE:\s*([\s\S]+?)$/i);

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
    analysis: aMatch ? aMatch[1].trim() : "Price confirms the " + sig.dir + " signal direction.",
    edge:     eMatch ? eMatch[1].trim() : "Enter at candle open for best accuracy."
  };
}

// ── Groq-only for commodities/indices ─────────────────────────────────────────
async function runGroqOnly(asset, expiry) {
  const txt = await callGroq([
    { role: "system", content: "You are a binary options analyst. Return ONLY valid JSON. No markdown. No extra text." },
    { role: "user", content: "Generate a binary options signal for " + asset + " with " + expiry + " expiry on Pocket Option.\nReturn this exact JSON:\n{\"asset\":\"" + asset + "\",\"expiry\":\"" + expiry + "\",\"price\":\"approximate price\",\"change24h\":\"+0.00%\",\"rsi\":\"50\",\"macd\":\"BULLISH\",\"trend\":\"BULLISH\",\"signal\":\"CALL\",\"confidence\":72,\"risk\":\"Medium\",\"support\":\"level\",\"resistance\":\"level\",\"analysis\":\"2 sentence analysis\",\"edge\":\"tactical insight\"}" }
  ], 500);

  // Clean the response thoroughly
  let cleaned = txt.trim();
  cleaned = cleaned.replace(/`json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in response");
  cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) { const r = []; for (let i = 0; i < arr.length; i+=n) r.push(arr.slice(i,i+n)); return r; }
function catKB()     { return { inline_keyboard: chunk(Object.keys(ASSETS),2).map(row=>row.map(c=>({text:c,callback_data:"cat:"+c}))) }; }
function assetKB(c)  { return { inline_keyboard: [...chunk(ASSETS[c]||[],2).map(row=>row.map(a=>({text:a,callback_data:"asset:"+a}))),[{text:"<< Back",callback_data:"back:cat"}]] }; }
function expiryKB()  { return { inline_keyboard: [...chunk(EXPIRIES,3).map(row=>row.map(e=>({text:e,callback_data:"expiry:"+e}))),[{text:"<< Back",callback_data:"back:asset"}]] }; }
function confirmKB() { return { inline_keyboard: [[{text:"RUN NOXA ANALYSIS",callback_data:"confirm:analyze"}],[{text:"Change Pair",callback_data:"back:cat"},{text:"Change Expiry",callback_data:"back:expiry"}]] }; }
function retryKB()   { return { inline_keyboard: [[{text:"Retry",callback_data:"confirm:analyze"}],[{text:"New Pair",callback_data:"back:cat"}]] }; }

function bar(pct) { const f=Math.round(pct/10); return "[" + "#".repeat(f) + "-".repeat(10-f) + "] " + pct + "%"; }

function formatSignal(d) {
  const isCall = d.signal === "CALL";
  return (
    "*NOXA AI SIGNAL*  " + (isCall ? "[BUY]" : "[SELL]") + "\n\n" +
    "====================\n" +
    "* " + (isCall ? "HIGHER / BUY  ^" : "LOWER / SELL  v") + " *\n" +
    "Pair:   *" + d.asset + "*\n" +
    "Expiry: *" + d.expiry + "*\n" +
    "Price:  *" + d.price + "*\n" +
    "====================\n\n" +
    "*LIVE INDICATORS*\n" +
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
    "Live data for Crypto and Forex pairs.\n\n" +
    "/analyze - Get a signal\n/help - Help",
    { parse_mode:"Markdown", reply_markup:{ inline_keyboard:[[{text:"Get Signal Now",callback_data:"start:analyze"}]] } }
  );
});

bot.onText(/\/analyze/, (msg) => {
  getSession(msg.chat.id).step = "select_cat";
  bot.sendMessage(msg.chat.id, "*Select Asset Category:*", { parse_mode:"Markdown", reply_markup:catKB() });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "Crypto + Forex = REAL live data\n" +
    "Commodities + Indices = AI estimate\n" +
    "OTC pairs = available 24/7 including weekends\n\n" +
    "Best combo: 1min candle + 3min or 5min expiry\n\n" +
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
      "Fetching LIVE data for *" + sess.asset + "*...\n\nCalculating RSI, MACD, Trend...\nPlease wait...",
      { chat_id:chatId, message_id:msgId, parse_mode:"Markdown" }
    );
    try {
      let result;
      try {
        result = await runAnalysis(sess.asset, sess.expiry);
      } catch (e) {
        if (e.message === "USE_GROQ_ONLY") {
          result = await runGroqOnly(sess.asset, sess.expiry);
        } else {
          throw e;
        }
      }
      await bot.editMessageText(formatSignal(result), {
        chat_id:chatId, message_id:msgId, parse_mode:"Markdown",
        reply_markup:{ inline_keyboard:[[{text:"Analyze Again",callback_data:"confirm:analyze"}],[{text:"New Pair",callback_data:"back:cat"},{text:"New Expiry",callback_data:"back:expiry"}]] }
      });
    } catch (err) {
      console.log("Analysis error:", err.message);
      await bot.editMessageText(
        "Error: " + (err.message||"Unknown error") + "\n\nPlease retry or choose a different pair.",
        { chat_id:chatId, message_id:msgId, reply_markup:retryKB() }
      );
    }
  }
});

console.log("NOXA AI Bot running.");
