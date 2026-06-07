const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ  = process.env.GROQ_API_KEY;

if (!TOKEN || !GROQ) {
  console.error("Missing TELEGRAM_TOKEN or GROQ_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("NOXA AI Bot is running!");

// ── Assets ────────────────────────────────────────────────────────────────────
const PAIRS = {
  "FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD",
    "GBP/JPY","EUR/JPY","NZD/USD","USD/CHF","EUR/GBP"
  ],
  "FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","USD/JPY OTC",
    "EUR/JPY OTC","NZD/USD OTC","AUD/CHF OTC"
  ],
  "CRYPTO": ["BTC/USD","ETH/USD","XRP/USD","LTC/USD","BNB/USD"],
  "COMMODITIES": ["GOLD/USD","SILVER/USD","OIL/USD"],
  "INDICES": ["US500","US30","NASDAQ","UK100","GER40"]
};

const EXPIRIES = ["1 min","3 min","5 min","15 min","30 min","1 hour"];
const sessions = {};

function session(id) {
  if (!sessions[id]) sessions[id] = {};
  return sessions[id];
}

function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

function progressBar(n) {
  const f = Math.round(n / 10);
  return "[" + "#".repeat(f) + "-".repeat(10 - f) + "] " + n + "%";
}

// ── Groq API call ─────────────────────────────────────────────────────────────
function askGroq(pair, expiry, callback) {
  const messages = [
    {
      role: "system",
      content: "You are a professional binary options trading analyst for Pocket Option. You must return ONLY a valid JSON object. No markdown. No code blocks. No extra text. Just the raw JSON."
    },
    {
      role: "user",
      content: `Analyze ${pair} for a ${expiry} binary options trade on Pocket Option.

Important rules:
- Base signal on real market knowledge for ${pair}
- Do NOT always give CALL - give PUT when price is high/overbought/bearish
- RSI above 70 should lean PUT, below 30 should lean CALL
- Price must be realistic for ${pair}
- Confidence between 63 and 87

Return this exact JSON:
{"signal":"CALL or PUT","price":"realistic current price","change":"like +0.45% or -0.32%","rsi":"number 1-100","macd":"BULLISH or BEARISH","trend":"BULLISH or BEARISH","support":"realistic support price","resistance":"realistic resistance price","confidence":75,"risk":"Low or Medium or High","analysis":"2 clear sentences explaining why this signal based on RSI MACD and trend","edge":"one specific entry tip for this trade"}`
    }
  ];

  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    temperature: 0.5,
    max_tokens: 500,
    messages: messages
  });

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + GROQ,
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const req = https.request(options, function(res) {
    let raw = "";
    res.on("data", function(chunk) { raw += chunk; });
    res.on("end", function() {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.choices || !parsed.choices[0]) {
          return callback(new Error("No response from Groq"));
        }
        let content = parsed.choices[0].message.content.trim();
        // Remove any markdown if present
        content = content.replace(/```json/gi, "").replace(/```/g, "").trim();
        // Find JSON object
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start === -1 || end === -1) {
          return callback(new Error("No JSON found"));
        }
        const result = JSON.parse(content.slice(start, end + 1));
        callback(null, result);
      } catch (e) {
        callback(new Error("Parse error: " + e.message));
      }
    });
  });

  req.on("error", function(e) { callback(e); });
  req.setTimeout(25000, function() {
    req.destroy();
    callback(new Error("Request timed out"));
  });
  req.write(body);
  req.end();
}

// ── Format signal message ─────────────────────────────────────────────────────
function formatSignal(pair, expiry, r) {
  const isCall = r.signal === "CALL";
  const dir = isCall ? "HIGHER / BUY  ^" : "LOWER / SELL  v";
  const tag = isCall ? "[BUY]" : "[SELL]";
  const rsiLabel = parseInt(r.rsi) > 70 ? " OVERBOUGHT" : parseInt(r.rsi) < 30 ? " OVERSOLD" : " NEUTRAL";

  return (
    "*NOXA AI SIGNAL* " + tag + "\n\n" +
    "====================\n" +
    "* " + dir + " *\n" +
    "Pair:   *" + pair + "*\n" +
    "Expiry: *" + expiry + "*\n" +
    "Price:  *" + r.price + "*\n" +
    "====================\n\n" +
    "*INDICATORS*\n" +
    "- 24h Change: " + r.change + "\n" +
    "- RSI(14):  " + r.rsi + rsiLabel + "\n" +
    "- MACD:     " + r.macd + "\n" +
    "- Trend:    " + r.trend + "\n\n" +
    "*KEY LEVELS*\n" +
    "- Support:    " + r.support + "\n" +
    "- Resistance: " + r.resistance + "\n\n" +
    "*CONFIDENCE: " + r.confidence + "%*\n" +
    progressBar(r.confidence) + "\n" +
    "Risk: " + r.risk + "\n\n" +
    "*ANALYSIS*\n" +
    r.analysis + "\n\n" +
    "*EDGE*\n" +
    r.edge + "\n\n" +
    "====================\n" +
    "_NOXA AI - Pocket Option Signals_"
  );
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function categoryKeyboard() {
  return {
    inline_keyboard: chunk(Object.keys(PAIRS), 2).map(function(row) {
      return row.map(function(c) { return { text: c, callback_data: "C:" + c }; });
    })
  };
}

function pairKeyboard(cat) {
  const rows = chunk(PAIRS[cat] || [], 2).map(function(row) {
    return row.map(function(p) { return { text: p, callback_data: "P:" + p }; });
  });
  rows.push([{ text: "<< Back", callback_data: "BACK:cat" }]);
  return { inline_keyboard: rows };
}

function expiryKeyboard(cat) {
  const rows = chunk(EXPIRIES, 3).map(function(row) {
    return row.map(function(e) { return { text: e, callback_data: "E:" + e }; });
  });
  rows.push([{ text: "<< Back", callback_data: "BACK:pair:" + cat }]);
  return { inline_keyboard: rows };
}

function resultKeyboard(pair, expiry, cat) {
  return {
    inline_keyboard: [
      [{ text: "Analyze Again", callback_data: "E:" + expiry }],
      [{ text: "New Pair", callback_data: "C:" + cat }, { text: "New Expiry", callback_data: "P:" + pair }]
    ]
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, function(msg) {
  var chatId = msg.chat.id;
  var name = msg.from.first_name || "Trader";
  sessions[chatId] = {};
  bot.sendMessage(chatId,
    "Welcome *" + name + "*!\n\n" +
    "*NOXA AI* - Pocket Option Signal Bot\n\n" +
    "Get AI-powered HIGHER/LOWER signals\n" +
    "for all Pocket Option pairs.\n\n" +
    "/analyze - Get a signal\n" +
    "/help - How to use",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "Get Signal Now", callback_data: "START" }]]
      }
    }
  );
});

bot.onText(/\/analyze/, function(msg) {
  sessions[msg.chat.id] = {};
  bot.sendMessage(msg.chat.id, "Select Asset Category:", {
    reply_markup: categoryKeyboard()
  });
});

bot.onText(/\/help/, function(msg) {
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "How to get a signal:\n" +
    "1. /analyze\n" +
    "2. Choose category\n" +
    "3. Select pair\n" +
    "4. Choose expiry time\n" +
    "5. Get HIGHER or LOWER signal\n\n" +
    "Best settings:\n" +
    "- Candle: 1 minute\n" +
    "- Expiry: 3 or 5 minutes\n\n" +
    "OTC pairs work 24/7 on weekends!\n\n" +
    "Always use risk management.",
    { parse_mode: "Markdown" }
  );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on("callback_query", function(query) {
  var chatId = query.message.chat.id;
  var msgId  = query.message.message_id;
  var data   = query.data;
  var sess   = session(chatId);

  bot.answerCallbackQuery(query.id);

  // Start
  if (data === "START" || data === "BACK:cat") {
    sess = {};
    sessions[chatId] = sess;
    bot.editMessageText("Select Asset Category:", {
      chat_id: chatId, message_id: msgId,
      reply_markup: categoryKeyboard()
    });
    return;
  }

  // Category selected
  if (data.startsWith("C:")) {
    sess.cat = data.slice(2);
    bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: pairKeyboard(sess.cat)
    });
    return;
  }

  // Back to pair list
  if (data.startsWith("BACK:pair:")) {
    sess.cat = data.slice(10);
    bot.editMessageText("*" + sess.cat + "*\n\nSelect your pair:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: pairKeyboard(sess.cat)
    });
    return;
  }

  // Pair selected
  if (data.startsWith("P:")) {
    sess.pair = data.slice(2);
    bot.editMessageText("Pair: *" + sess.pair + "*\n\nSelect expiry time:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: expiryKeyboard(sess.cat || "FOREX")
    });
    return;
  }

  // Expiry selected - run analysis
  if (data.startsWith("E:")) {
    sess.expiry = data.slice(2);
    var pair   = sess.pair;
    var expiry = sess.expiry;
    var cat    = sess.cat || "FOREX";

    if (!pair) {
      bot.editMessageText("Please select a pair first.", {
        chat_id: chatId, message_id: msgId,
        reply_markup: categoryKeyboard()
      });
      return;
    }

    bot.editMessageText(
      "Analyzing *" + pair + "*...\n\nNOXA AI is processing\nPlease wait 10-15 seconds...",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );

    askGroq(pair, expiry, function(err, result) {
      if (err || !result) {
        bot.editMessageText(
          "Could not get signal. Please tap Retry.",
          {
            chat_id: chatId, message_id: msgId,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Retry", callback_data: "E:" + expiry }],
                [{ text: "New Pair", callback_data: "BACK:cat" }]
              ]
            }
          }
        );
        return;
      }

      var msg = formatSignal(pair, expiry, result);
      bot.editMessageText(msg, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: resultKeyboard(pair, expiry, cat)
      });
    });
    return;
  }
});

// ── Keep alive ────────────────────────────────────────────────────────────────
setInterval(function() {
  console.log("Bot alive - " + new Date().toISOString());
}, 5 * 60 * 1000);
