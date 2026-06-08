const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ  = process.env.GROQ_API_KEY;
const TDKEY = process.env.TWELVEDATA_KEY || "77ea6d08dc844c66bd44e0440c282426";

if (!TOKEN || !GROQ) { console.error("Missing env vars!"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("NOXA AI Bot running!");

// ── Bull & Bear Image URLs ────────────────────────────────────────────────────
const BULL_IMG = "https://i.imgur.com/2nCt3Sbl.jpg";
const BEAR_IMG = "https://i.imgur.com/rNIeJhP.jpg";

// ── All Pairs ─────────────────────────────────────────────────────────────────
const PAIRS = {
  "FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD",
    "GBP/JPY","EUR/JPY","EUR/GBP","NZD/USD","AUD/JPY","EUR/AUD",
    "GBP/CHF","EUR/CHF","AUD/CAD","GBP/AUD","EUR/NZD","GBP/NZD",
    "NZD/JPY","CAD/JPY","CHF/JPY","AUD/CHF","EUR/CAD","USD/SGD"
  ],
  "FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","USD/JPY OTC","AUD/USD OTC",
    "USD/CAD OTC","EUR/JPY OTC","GBP/JPY OTC","NZD/USD OTC",
    "AUD/CHF OTC","CAD/JPY OTC","EUR/GBP OTC","USD/CHF OTC",
    "AED/CNY OTC","USD/BRL OTC","EUR/TRY OTC","USD/INR OTC",
    "USD/PHP OTC","GBP/NOK OTC","AUD/NOK OTC","EUR/HUF OTC"
  ],
  "CRYPTO": [
    "BTC/USD","ETH/USD","XRP/USD","LTC/USD","BNB/USD",
    "ADA/USD","SOL/USD","DOT/USD","DOGE/USD","AVAX/USD",
    "MATIC/USD","LINK/USD","UNI/USD","ATOM/USD","XLM/USD"
  ],
  "COMMODITIES": [
    "GOLD/USD","SILVER/USD","OIL/USD","BRENT/USD",
    "PLATINUM/USD","COPPER/USD","NATURAL GAS/USD"
  ],
  "INDICES": [
    "US500","US30","NASDAQ","UK100","GER40",
    "FRA40","JPN225","AUS200","HKG50","ESP35"
  ]
};

const TD_MAP = {
  "EUR/USD":"EUR/USD","GBP/USD":"GBP/USD","USD/JPY":"USD/JPY",
  "USD/CHF":"USD/CHF","AUD/USD":"AUD/USD","USD/CAD":"USD/CAD",
  "GBP/JPY":"GBP/JPY","EUR/JPY":"EUR/JPY","EUR/GBP":"EUR/GBP",
  "NZD/USD":"NZD/USD","AUD/JPY":"AUD/JPY","EUR/AUD":"EUR/AUD",
  "GBP/CHF":"GBP/CHF","EUR/CHF":"EUR/CHF","AUD/CAD":"AUD/CAD",
  "GBP/AUD":"GBP/AUD","EUR/NZD":"EUR/NZD","GBP/NZD":"GBP/NZD",
  "NZD/JPY":"NZD/JPY","CAD/JPY":"CAD/JPY","CHF/JPY":"CHF/JPY",
  "AUD/CHF":"AUD/CHF","EUR/CAD":"EUR/CAD","USD/SGD":"USD/SGD",
  "EUR/USD OTC":"EUR/USD","GBP/USD OTC":"GBP/USD","USD/JPY OTC":"USD/JPY",
  "AUD/USD OTC":"AUD/USD","USD/CAD OTC":"USD/CAD","EUR/JPY OTC":"EUR/JPY",
  "GBP/JPY OTC":"GBP/JPY","NZD/USD OTC":"NZD/USD","AUD/CHF OTC":"AUD/CHF",
  "CAD/JPY OTC":"CAD/JPY","EUR/GBP OTC":"EUR/GBP","USD/CHF OTC":"USD/CHF",
  "BTC/USD":"BTC/USD","ETH/USD":"ETH/USD","XRP/USD":"XRP/USD",
  "LTC/USD":"LTC/USD","BNB/USD":"BNB/USD","ADA/USD":"ADA/USD",
  "SOL/USD":"SOL/USD","DOT/USD":"DOT/USD","DOGE/USD":"DOGE/USD",
  "AVAX/USD":"AVAX/USD","MATIC/USD":"MATIC/USD","LINK/USD":"LINK/USD",
  "UNI/USD":"UNI/USD","ATOM/USD":"ATOM/USD","XLM/USD":"XLM/USD",
  "GOLD/USD":"XAU/USD","SILVER/USD":"XAG/USD","OIL/USD":"WTI/USD",
  "BRENT/USD":"BRENT/USD","PLATINUM/USD":"XPT/USD","COPPER/USD":"COPPER/USD",
  "US500":"SPX","US30":"DJI","NASDAQ":"NDX","UK100":"UKX","GER40":"DAX",
  "FRA40":"CAC40","JPN225":"N225","AUS200":"AS51","HKG50":"HSI","ESP35":"IBEX35"
};

// ── Expiry times matching Pocket Option ───────────────────────────────────────
const EXPIRIES = [
  "5 SEC","8 SEC","10 SEC","12 SEC","15 SEC","30 SEC",
  "1 MIN","2 MIN","3 MIN","5 MIN","15 MIN","30 MIN","1 HOUR"
];

const sessions = {};
function session(id) { if (!sessions[id]) sessions[id] = {}; return sessions[id]; }
function chunk(arr, n) { const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; }

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsGet(hostname, path, callback) {
  const req = https.get(
    { hostname, path, headers: { "User-Agent": "NoxaBot/1.0" } },
    function(res) {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try { callback(null, JSON.parse(raw)); }
        catch(e) { callback(new Error("Parse error")); }
      });
    }
  );
  req.on("error", callback);
  req.setTimeout(12000, function() { req.destroy(); callback(new Error("Timeout")); });
}

function httpsPost(hostname, path, headers, body, callback) {
  const req = https.request(
    { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
    function(res) {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try { callback(null, JSON.parse(raw)); }
        catch(e) { callback(new Error("Parse error")); }
      });
    }
  );
  req.on("error", callback);
  req.setTimeout(20000, function() { req.destroy(); callback(new Error("Timeout")); });
  req.write(body);
  req.end();
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcRSI(closes) {
  if (closes.length < 15) return 50;
  let g=0, l=0;
  for(let i=closes.length-14; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    if(d>0) g+=d; else l-=d;
  }
  const ag=g/14, al=l/14;
  return al===0?100:Math.round(100-(100/(1+ag/al)));
}
function calcEMA(arr, p) {
  const k=2/(p+1); let e=arr[0];
  return arr.map(function(v){e=v*k+e*(1-k);return e;});
}
function calcMACD(closes) {
  if(closes.length<35) return "NEUTRAL";
  const e12=calcEMA(closes,12), e26=calcEMA(closes,26);
  const line=e12.map(function(v,i){return v-e26[i];});
  const sig=calcEMA(line,9);
  return (line[line.length-1]-sig[sig.length-1])>0?"BULLISH":"BEARISH";
}
function calcBB(closes) {
  if(closes.length<20) return 50;
  const sl=closes.slice(-20), mean=sl.reduce(function(a,b){return a+b;},0)/20;
  const std=Math.sqrt(sl.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/20);
  const up=mean+2*std, lo=mean-2*std;
  return Math.round(((closes[closes.length-1]-lo)/((up-lo)||1))*100);
}
function calcTrend(closes) {
  if(closes.length<5) return "NEUTRAL";
  const r=closes.slice(-5); let up=0;
  for(let i=1;i<r.length;i++) if(r[i]>r[i-1]) up++;
  return up>=3?"BULLISH":"BEARISH";
}
function calcSig(rsi,macd,bb,trend) {
  let bull=0, bear=0;
  if(rsi<45) bull++; else if(rsi>55) bear++;
  if(macd==="BULLISH") bull++; else if(macd==="BEARISH") bear++;
  if(bb<40) bull++; else if(bb>60) bear++;
  if(trend==="BULLISH") bull++; else bear++;
  return { dir:bull>bear?"CALL":"PUT", conf:Math.min(90,58+Math.abs(bull-bear)*9) };
}

// ── Fetch candles ─────────────────────────────────────────────────────────────
function fetchCandles(symbol, callback) {
  const path="/v1/time_series?symbol="+encodeURIComponent(symbol)+"&interval=1min&outputsize=50&apikey="+TDKEY;
  httpsGet("api.twelvedata.com", path, function(err, data) {
    if(err||!data.values||data.status==="error") return callback(new Error("No data"));
    const candles=data.values.reverse().map(function(v){
      return {open:parseFloat(v.open),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)};
    });
    callback(null, candles);
  });
}

// ── Groq call ─────────────────────────────────────────────────────────────────
function groqCall(messages, callback) {
  const body = JSON.stringify({
    model:"llama-3.3-70b-versatile", temperature:0.4, max_tokens:300, messages
  });
  httpsPost("api.groq.com", "/openai/v1/chat/completions",
    {"Content-Type":"application/json","Authorization":"Bearer "+GROQ},
    body, function(err, data) {
      if(err||!data.choices||!data.choices[0]) return callback("Signal ready.");
      callback(data.choices[0].message.content);
    }
  );
}

// ── Main analysis ─────────────────────────────────────────────────────────────
function analyze(pair, expiry, callback) {
  const symbol = TD_MAP[pair];

  function buildFromCandles(candles) {
    const closes=candles.map(function(c){return c.close;});
    const rsi=calcRSI(closes), macd=calcMACD(closes);
    const bb=calcBB(closes), trend=calcTrend(closes);
    const sig=calcSig(rsi,macd,bb,trend);
    const price=closes[closes.length-1];
    const res=Math.max.apply(null,candles.slice(-20).map(function(c){return c.high;})).toFixed(5);
    const sup=Math.min.apply(null,candles.slice(-20).map(function(c){return c.low;})).toFixed(5);
    const chg=(((price-closes[0])/closes[0])*100).toFixed(2);

    const prompt =
      "Binary options signal for "+pair+". Live data: Price="+price.toFixed(5)+
      " RSI="+rsi+" MACD="+macd+" Trend="+trend+" Signal="+sig.dir+
      " Support="+sup+" Resistance="+res+"\n"+
      "Write:\nANALYSIS: 2 sentences why "+sig.dir+"\nEDGE: one entry tip";

    groqCall([
      {role:"system",content:"Trading analyst. Reply in ANALYSIS:/EDGE: format only."},
      {role:"user",content:prompt}
    ], function(txt) {
      const a=txt.match(/ANALYSIS:\s*([\s\S]+?)(?=EDGE:|$)/i);
      const e=txt.match(/EDGE:\s*([\s\S]+?)$/i);
      callback(null, {
        pair, expiry, price:price.toFixed(5),
        change:(chg>=0?"+":"")+chg+"%",
        rsi:rsi.toString(), macd, trend,
        signal:sig.dir, confidence:sig.conf,
        risk:sig.conf>80?"Low":sig.conf>70?"Medium":"High",
        support:sup, resistance:res,
        analysis:a?a[1].trim():"Signal confirmed by live indicators.",
        edge:e?e[1].trim():"Enter at candle open for best result.",
        live:true
      });
    });
  }

  if(symbol) {
    fetchCandles(symbol, function(err, candles) {
      if(err||!candles||candles.length<20) return groqOnly(pair,expiry,callback);
      buildFromCandles(candles);
    });
  } else {
    groqOnly(pair, expiry, callback);
  }
}

function groqOnly(pair, expiry, callback) {
  const body=JSON.stringify({
    model:"llama-3.3-70b-versatile", temperature:0.5, max_tokens:400,
    messages:[
      {role:"system",content:"Return ONLY valid JSON. No markdown."},
      {role:"user",content:"Signal for "+pair+" expiry "+expiry+" Pocket Option. JSON:{\"signal\":\"CALL or PUT\",\"price\":\"real price\",\"change\":\"+0.00%\",\"rsi\":\"50\",\"macd\":\"BULLISH or BEARISH\",\"trend\":\"BULLISH or BEARISH\",\"support\":\"price\",\"resistance\":\"price\",\"confidence\":72,\"risk\":\"Medium\",\"analysis\":\"2 sentences\",\"edge\":\"tip\"}"}
    ]
  });
  httpsPost("api.groq.com","/openai/v1/chat/completions",
    {"Content-Type":"application/json","Authorization":"Bearer "+GROQ},
    body, function(err,data) {
      try {
        let txt=data.choices[0].message.content.trim();
        txt=txt.replace(/```json/gi,"").replace(/```/g,"").trim();
        const s=txt.indexOf("{"),e=txt.lastIndexOf("}");
        const r=JSON.parse(txt.slice(s,e+1));
        r.live=false; r.pair=pair; r.expiry=expiry;
        callback(null,r);
      } catch(e){callback(new Error("Failed"));}
    }
  );
}

// ── Send signal with bull/bear image ──────────────────────────────────────────
function sendSignal(chatId, msgId, pair, expiry, result) {
  const isCall = result.signal === "CALL";
  const imgUrl = isCall ? BULL_IMG : BEAR_IMG;
  const rsiN   = parseInt(result.rsi||50);
  const rsiLabel = rsiN>70?" OVERBOUGHT":rsiN<30?" OVERSOLD":" NEUTRAL";

  const caption =
    (isCall ? "🟢 *CALL* ⬆️" : "🔴 *PUT* ⬇️") + "\n\n" +
    "━━━━━━━━━━━━━━━━━━━\n" +
    "💱 *" + pair + "*\n" +
    "⏱ Expiry: *" + expiry + "*\n" +
    "💰 Price: *" + result.price + "*\n" +
    "📡 " + (result.live?"LIVE DATA":"AI ESTIMATE") + "\n" +
    "━━━━━━━━━━━━━━━━━━━\n\n" +
    "📊 *INDICATORS*\n" +
    "• 24h: " + result.change + "\n" +
    "• RSI: " + result.rsi + rsiLabel + "\n" +
    "• MACD: " + result.macd + "\n" +
    "• Trend: " + result.trend + "\n\n" +
    "📍 *KEY LEVELS*\n" +
    "• Support: " + result.support + "\n" +
    "• Resistance: " + result.resistance + "\n\n" +
    "🎯 *CONFIDENCE: " + result.confidence + "%*\n" +
    "Risk: " + result.risk + "\n\n" +
    "📝 " + result.analysis + "\n\n" +
    "⚡ *EDGE:* " + result.edge + "\n\n" +
    "━━━━━━━━━━━━━━━━━━━\n" +
    "_NOXA AI • Pocket Option_";

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 Analyze Again", callback_data: "E:"+expiry }],
      [{ text: "💱 New Pair", callback_data: "BACK:cat" }, { text: "⏱ New Expiry", callback_data: "P:"+pair }]
    ]
  };

  // Delete the loading message first
  bot.deleteMessage(chatId, msgId).catch(function(){});

  // Send image with signal as caption
  bot.sendPhoto(chatId, imgUrl, {
    caption: caption,
    parse_mode: "Markdown",
    reply_markup: keyboard
  }).catch(function() {
    // If image fails, send as text
    bot.sendMessage(chatId,
      (isCall?"🟢 *CALL* ⬆️":"🔴 *PUT* ⬇️") + "\n\n" + caption,
      { parse_mode:"Markdown", reply_markup:keyboard }
    );
  });
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function chunk(arr, n) { const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; }
function catKB() {
  const cats=Object.keys(PAIRS);
  return {inline_keyboard:chunk(cats,2).map(function(row){return row.map(function(c){return{text:c,callback_data:"C:"+c};});})};
}
function pairKB(cat) {
  const rows=chunk(PAIRS[cat]||[],2).map(function(row){return row.map(function(p){return{text:p,callback_data:"P:"+p};});});
  rows.push([{text:"🏠 Main Menu",callback_data:"BACK:cat"}]);
  return {inline_keyboard:rows};
}
function expiryKB(cat) {
  const rows=chunk(EXPIRIES,3).map(function(row){return row.map(function(e){return{text:e,callback_data:"E:"+e};});});
  rows.push([{text:"◀️ Back",callback_data:"BP:"+cat},{text:"🏠 Main Menu",callback_data:"BACK:cat"}]);
  return {inline_keyboard:rows};
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, function(msg) {
  sessions[msg.chat.id] = {};
  const name = msg.from.first_name || "Trader";
  bot.sendMessage(msg.chat.id,
    "🚀 *Welcome " + name + "!*\n\n" +
    "🤖 *NOXA AI* — Pocket Option Signal Bot\n\n" +
    "✅ 60+ trading pairs\n" +
    "📡 Live market data\n" +
    "🟢 CALL / 🔴 PUT signals\n" +
    "⏱ Short expiry from 5 seconds\n\n" +
    "/analyze — Get signal\n" +
    "/help — How to use",
    {
      parse_mode:"Markdown",
      reply_markup:{inline_keyboard:[
        [{text:"⚡ GET SIGNAL NOW",callback_data:"START"}]
      ]}
    }
  );
});

bot.onText(/\/analyze/, function(msg) {
  sessions[msg.chat.id]={};
  bot.sendMessage(msg.chat.id,"📂 *Select Asset Category:*",{parse_mode:"Markdown",reply_markup:catKB()});
});

bot.onText(/\/help/, function(msg) {
  bot.sendMessage(msg.chat.id,
    "📖 *NOXA AI Help*\n\n" +
    "How to get a signal:\n" +
    "1️⃣ /analyze\n" +
    "2️⃣ Choose category\n" +
    "3️⃣ Select pair\n" +
    "4️⃣ Choose expiry\n" +
    "5️⃣ Get CALL 🟢 or PUT 🔴\n\n" +
    "📡 LIVE DATA = real RSI & MACD\n" +
    "🤖 AI ESTIMATE = AI market knowledge\n\n" +
    "Best settings:\n" +
    "• Candle: 1 min\n" +
    "• Expiry: 1 MIN or 3 MIN\n\n" +
    "⚠️ Always use risk management!",
    {parse_mode:"Markdown"}
  );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on("callback_query", function(q) {
  var cid=q.message.chat.id, mid=q.message.message_id;
  var data=q.data, sess=session(cid);
  bot.answerCallbackQuery(q.id);

  if(data==="START"||data==="BACK:cat") {
    sessions[cid]={};
    return bot.editMessageText("📂 *Select Asset Category:*",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:catKB()});
  }
  if(data.startsWith("C:")) {
    sess.cat=data.slice(2);
    return bot.editMessageText("📂 *"+sess.cat+"*\n\nSelect your pair:",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:pairKB(sess.cat)});
  }
  if(data.startsWith("BP:")) {
    sess.cat=data.slice(3);
    return bot.editMessageText("📂 *"+sess.cat+"*\n\nSelect your pair:",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:pairKB(sess.cat)});
  }
  if(data.startsWith("P:")) {
    sess.pair=data.slice(2);
    return bot.editMessageText(
      "💱 Pair: *"+sess.pair+"*\n\n⏱ Select expiry time:",
      {chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:expiryKB(sess.cat||"FOREX")}
    );
  }
  if(data.startsWith("E:")) {
    sess.expiry=data.slice(2);
    var pair=sess.pair, expiry=sess.expiry, cat=sess.cat||"FOREX";
    if(!pair) return bot.editMessageText("Please select a pair first.",{chat_id:cid,message_id:mid,reply_markup:catKB()});

    bot.editMessageText(
      "📡 *Fetching LIVE data for "+pair+"...*\n\n🧠 Calculating RSI, MACD, Trend...\n⏳ Please wait...",
      {chat_id:cid,message_id:mid,parse_mode:"Markdown"}
    );

    analyze(pair, expiry, function(err, result) {
      if(err||!result) {
        return bot.editMessageText("❌ Could not get signal. Please retry.",{
          chat_id:cid, message_id:mid,
          reply_markup:{inline_keyboard:[[{text:"🔄 Retry",callback_data:"E:"+expiry}],[{text:"🏠 Main Menu",callback_data:"BACK:cat"}]]}
        });
      }
      sendSignal(cid, mid, pair, expiry, result);
    });
  }
});

setInterval(function(){console.log("alive "+new Date().toISOString());},5*60*1000);
