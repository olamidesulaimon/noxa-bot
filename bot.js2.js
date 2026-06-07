const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ  = process.env.GROQ_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("Bot started!");

const PAIRS = {
  "FOREX": ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","GBP/JPY","EUR/JPY","NZD/USD"],
  "FOREX OTC": ["EUR/USD OTC","GBP/USD OTC","USD/JPY OTC","EUR/JPY OTC","NZD/USD OTC"],
  "CRYPTO": ["BTC/USD","ETH/USD","XRP/USD","LTC/USD","BNB/USD"],
  "COMMODITIES": ["GOLD/USD","SILVER/USD","OIL/USD"],
  "INDICES": ["US500","US30","NASDAQ","UK100","GER40"]
};

const EXPIRIES = ["1 min","3 min","5 min","15 min","30 min","1 hour"];
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = {};
  return sessions[id];
}

function chunk(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

function bar(n) {
  return "[" + "#".repeat(n/10|0) + "-".repeat(10 - (n/10|0)) + "] " + n + "%";
}

function getSignal(asset, expiry, cb) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    temperature: 0.5,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: "You are a binary options analyst. Return ONLY a JSON object. No markdown. No explanation. Just JSON."
      },
      {
        role: "user",
        content: "Give me a binary options signal for " + asset + " with " + expiry + " expiry on Pocket Option. Use real market knowledge. Do NOT always say CALL - give PUT when market is overbought or bearish. Return this JSON: {\"signal\":\"CALL or PUT\",\"price\":\"real price\",\"change\":\"like +0.5%\",\"rsi\":\"number\",\"trend\":\"BULLISH or BEARISH\",\"support\":\"price\",\"resistance\":\"price\",\"confidence\":75,\"risk\":\"Medium\",\"analysis\":\"2 sentences why\",\"edge\":\"one tip\"}"
      }
    ]
  });

  const req = https.request({
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + GROQ,
      "Content-Length": Buffer.byteLength(body)
    }
  }, function(res) {
    let raw = "";
    res.on("data", function(c) { raw += c; });
    res.on("end", function() {
      try {
        const data = JSON.parse(raw);
        const txt = data.choices[0].message.content;
        const clean = txt.replace(/```json/g,"").replace(/```/g,"").trim();
        const s = clean.indexOf("{");
        const e = clean.lastIndexOf("}");
        const result = JSON.parse(clean.slice(s, e+1));
        cb(null, result);
      } catch(err) {
        cb(err);
      }
    });
  });

  req.on("error", cb);
  req.setTimeout(20000, function() { req.destroy(); cb(new Error("Timeout")); });
  req.write(body);
  req.end();
}

// /start
bot.onText(/\/start/, function(msg) {
  var name = msg.from.first_name || "Trader";
  bot.sendMessage(msg.chat.id,
    "Welcome *" + name + "*!\n\n*NOXA AI* - Pocket Option Bot\n\nGet HIGHER/LOWER signals for all pairs.\n\n/analyze - Get signal\n/help - Help",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "Get Signal Now", callback_data: "go" }]] }
    }
  );
});

// /analyze
bot.onText(/\/analyze/, function(msg) {
  bot.sendMessage(msg.chat.id, "Select Category:", {
    reply_markup: { inline_keyboard: chunk(Object.keys(PAIRS), 2).map(function(row) {
      return row.map(function(c) { return { text: c, callback_data: "cat_" + c }; });
    })}
  });
});

// /help
bot.onText(/\/help/, function(msg) {
  bot.sendMessage(msg.chat.id, "*NOXA AI Help*\n\nAll Pocket Option pairs supported.\nBest: 1min candle + 3min or 5min expiry.\n\nAlways use risk management!", { parse_mode: "Markdown" });
});

// callbacks
bot.on("callback_query", function(q) {
  var chatId = q.message.chat.id;
  var msgId  = q.message.message_id;
  var data   = q.data;
  var sess   = getSession(chatId);

  bot.answerCallbackQuery(q.id);

  if (data === "go") {
    bot.editMessageText("Select Category:", {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: chunk(Object.keys(PAIRS), 2).map(function(row) {
        return row.map(function(c) { return { text: c, callback_data: "cat_" + c }; });
      })}
    });
    return;
  }

  if (data.startsWith("cat_")) {
    sess.cat = data.slice(4);
    bot.editMessageText("*" + sess.cat + "*\n\nSelect pair:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: chunk(PAIRS[sess.cat] || [], 2).map(function(row) {
        return row.map(function(a) { return { text: a, callback_data: "pair_" + a }; });
      }).concat([[{ text: "<< Back", callback_data: "go" }]])}
    });
    return;
  }

  if (data.startsWith("pair_")) {
    sess.pair = data.slice(5);
    bot.editMessageText("Pair: *" + sess.pair + "*\n\nSelect expiry:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: chunk(EXPIRIES, 3).map(function(row) {
        return row.map(function(e) { return { text: e, callback_data: "exp_" + e }; });
      }).concat([[{ text: "<< Back", callback_data: "cat_" + sess.cat }]])}
    });
    return;
  }

  if (data.startsWith("exp_")) {
    sess.expiry = data.slice(4);
    bot.editMessageText("Analyzing *" + sess.pair + "*...\nPlease wait 10-15 seconds...", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown"
    });

    getSignal(sess.pair, sess.expiry, function(err, r) {
      if (err || !r) {
        bot.editMessageText("Error getting signal. Please retry.", {
          chat_id: chatId, message_id: msgId,
          reply_markup: { inline_keyboard: [[{ text: "Retry", callback_data: "exp_" + sess.expiry }], [{ text: "New Pair", callback_data: "go" }]] }
        });
        return;
      }

      var isCall = r.signal === "CALL";
      var txt =
        "*NOXA AI SIGNAL* " + (isCall ? "[BUY]" : "[SELL]") + "\n\n" +
        "====================\n" +
        "* " + (isCall ? "HIGHER / BUY ^" : "LOWER / SELL v") + " *\n" +
        "Pair:   *" + sess.pair + "*\n" +
        "Expiry: *" + sess.expiry + "*\n" +
        "Price:  *" + r.price + "*\n" +
        "====================\n\n" +
        "*INDICATORS*\n" +
        "- 24h: " + r.change + "\n" +
        "- RSI: " + r.rsi + "\n" +
        "- Trend: " + r.trend + "\n\n" +
        "*KEY LEVELS*\n" +
        "- Support: " + r.support + "\n" +
        "- Resistance: " + r.resistance + "\n\n" +
        "*CONFIDENCE: " + r.confidence + "%*\n" +
        bar(r.confidence) + "\n" +
        "Risk: " + r.risk + "\n\n" +
        "*ANALYSIS*\n" + r.analysis + "\n\n" +
        "*EDGE*\n" + r.edge + "\n\n" +
        "====================\n" +
        "_NOXA AI - Pocket Option_";

      bot.editMessageText(txt, {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "Analyze Again", callback_data: "exp_" + sess.expiry }],
          [{ text: "New Pair", callback_data: "go" }, { text: "New Expiry", callback_data: "pair_" + sess.pair }]
        ]}
      });
    });
    return;
  }
});
