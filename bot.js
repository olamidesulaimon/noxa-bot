const TelegramBot = require("node-telegram-bot-api");
const https = require("https");

const TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ  = process.env.GROQ_API_KEY;
const TDKEY = process.env.TWELVEDATA_KEY || "77ea6d08dc844c66bd44e0440c282426";

if (!TOKEN || !GROQ) { console.error("Missing env vars!"); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("NOXA AI Bot running with LIVE data!");

// ── All Pocket Option Pairs ───────────────────────────────────────────────────
const PAIRS = {
  "FOREX": [
    "EUR/USD","GBP/USD","USD/JPY","USD/CHF","AUD/USD","USD/CAD",
    "GBP/JPY","EUR/JPY","EUR/GBP","NZD/USD","AUD/JPY","EUR/AUD",
    "GBP/CHF","EUR/CHF","AUD/CAD","GBP/AUD","EUR/NZD","GBP/NZD",
    "NZD/JPY","CAD/JPY","CHF/JPY","AUD/CHF","EUR/CAD","USD/SGD",
    "USD/NOK","USD/SEK","USD/DKK","USD/MXN","USD/ZAR","USD/TRY"
  ],
  "FOREX OTC": [
    "EUR/USD OTC","GBP/USD OTC","USD/JPY OTC","AUD/USD OTC",
    "USD/CAD OTC","EUR/JPY OTC","GBP/JPY OTC","NZD/USD OTC",
    "AUD/CHF OTC","CAD/JPY OTC","EUR/GBP OTC","USD/CHF OTC"
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

// Twelve Data symbol mapping
const TD_MAP = {
  // Forex
  "EUR/USD":"EUR/USD","GBP/USD":"GBP/USD","USD/JPY":"USD/JPY",
  "USD/CHF":"USD/CHF","AUD/USD":"AUD/USD","USD/CAD":"USD/CAD",
  "GBP/JPY":"GBP/JPY","EUR/JPY":"EUR/JPY","EUR/GBP":"EUR/GBP",
  "NZD/USD":"NZD/USD","AUD/JPY":"AUD/JPY","EUR/AUD":"EUR/AUD",
  "GBP/CHF":"GBP/CHF","EUR/CHF":"EUR/CHF","AUD/CAD":"AUD/CAD",
  "GBP/AUD":"GBP/AUD","EUR/NZD":"EUR/NZD","GBP/NZD":"GBP/NZD",
  "NZD/JPY":"NZD/JPY","CAD/JPY":"CAD/JPY","CHF/JPY":"CHF/JPY",
  "AUD/CHF":"AUD/CHF","EUR/CAD":"EUR/CAD","USD/SGD":"USD/SGD",
  "USD/NOK":"USD/NOK","USD/SEK":"USD/SEK","USD/DKK":"USD/DKK",
  "USD/MXN":"USD/MXN","USD/ZAR":"USD/ZAR","USD/TRY":"USD/TRY",
  // OTC maps to base pair
  "EUR/USD OTC":"EUR/USD","GBP/USD OTC":"GBP/USD","USD/JPY OTC":"USD/JPY",
  "AUD/USD OTC":"AUD/USD","USD/CAD OTC":"USD/CAD","EUR/JPY OTC":"EUR/JPY",
  "GBP/JPY OTC":"GBP/JPY","NZD/USD OTC":"NZD/USD","AUD/CHF OTC":"AUD/CHF",
  "CAD/JPY OTC":"CAD/JPY","EUR/GBP OTC":"EUR/GBP","USD/CHF OTC":"USD/CHF",
  // Crypto
  "BTC/USD":"BTC/USD","ETH/USD":"ETH/USD","XRP/USD":"XRP/USD",
  "LTC/USD":"LTC/USD","BNB/USD":"BNB/USD","ADA/USD":"ADA/USD",
  "SOL/USD":"SOL/USD","DOT/USD":"DOT/USD","DOGE/USD":"DOGE/USD",
  "AVAX/USD":"AVAX/USD","MATIC/USD":"MATIC/USD","LINK/USD":"LINK/USD",
  "UNI/USD":"UNI/USD","ATOM/USD":"ATOM/USD","XLM/USD":"XLM/USD",
  // Commodities
  "GOLD/USD":"XAU/USD","SILVER/USD":"XAG/USD","OIL/USD":"WTI/USD",
  "BRENT/USD":"BRENT/USD","PLATINUM/USD":"XPT/USD","COPPER/USD":"COPPER/USD",
  "NATURAL GAS/USD":"NGAS/USD",
  // Indices
  "US500":"SPX","US30":"DJI","NASDAQ":"NDX","UK100":"UKX",
  "GER40":"DAX","FRA40":"CAC40","JPN225":"N225","AUS200":"AS51",
  "HKG50":"HSI","ESP35":"IBEX35"
};

const EXPIRIES = ["1 min","3 min","5 min","15 min","30 min","1 hour"];
const sessions = {};
function session(id) { if (!sessions[id]) sessions[id] = {}; return sessions[id]; }
function chunk(arr, n) { const r=[]; for(let i=0;i<arr.length;i+=n) r.push(arr.slice(i,i+n)); return r; }
function bar(n) { const f=Math.round(n/10); return "[" + "#".repeat(f) + "-".repeat(10-f) + "] " + n + "%"; }

// ── Twelve Data fetch ─────────────────────────────────────────────────────────
function fetchCandles(symbol, callback) {
  const path = "/v1/time_series?symbol=" + encodeURIComponent(symbol) +
               "&interval=1min&outputsize=50&apikey=" + TDKEY;
  const req = https.get(
    { hostname: "api.twelvedata.com", path: path, headers: { "User-Agent": "NoxaBot/1.0" } },
    function(res) {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try {
          const data = JSON.parse(raw);
          if (!data.values || data.status === "error") return callback(new Error(data.message || "No data"));
          const candles = data.values.reverse().map(function(v) {
            return { open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close) };
          });
          callback(null, candles);
        } catch(e) { callback(e); }
      });
    }
  );
  req.on("error", callback);
  req.setTimeout(12000, function() { req.destroy(); callback(new Error("Timeout")); });
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcRSI(closes) {
  if (closes.length < 15) return 50;
  let g=0, l=0;
  for(let i=closes.length-14; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if(d>0) g+=d; else l-=d;
  }
  const ag=g/14, al=l/14;
  return al===0 ? 100 : Math.round(100-(100/(1+ag/al)));
}
function calcEMA(arr, p) { const k=2/(p+1); let e=arr[0]; return arr.map(function(v){e=v*k+e*(1-k);return e;}); }
function calcMACD(closes) {
  if(closes.length<35) return "NEUTRAL";
  const e12=calcEMA(closes,12), e26=calcEMA(closes,26);
  const line=e12.map(function(v,i){return v-e26[i];});
  const sig=calcEMA(line,9);
  return (line[line.length-1]-sig[sig.length-1])>0 ? "BULLISH" : "BEARISH";
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
  return up>=3 ? "BULLISH" : "BEARISH";
}
function calcSig(rsi,macd,bb,trend) {
  let bull=0, bear=0;
  if(rsi<45) bull++; else if(rsi>55) bear++;
  if(macd==="BULLISH") bull++; else if(macd==="BEARISH") bear++;
  if(bb<40) bull++; else if(bb>60) bear++;
  if(trend==="BULLISH") bull++; else bear++;
  return { dir: bull>bear?"CALL":"PUT", conf: Math.min(90,58+Math.abs(bull-bear)*9) };
}

// ── Groq analysis text ────────────────────────────────────────────────────────
function askGroq(pair, expiry, ld, callback) {
  const prompt =
    "Binary options analyst for Pocket Option.\n" +
    "LIVE DATA " + pair + ": Price=" + ld.price + " RSI=" + ld.rsi +
    " MACD=" + ld.macd + " Trend=" + ld.trend + " Signal=" + ld.signal +
    " Support=" + ld.support + " Resistance=" + ld.resistance + " Expiry=" + expiry + "\n" +
    "Write:\nANALYSIS: 2 sentences why " + ld.signal + " based on data\nEDGE: one entry tip";

  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile", temperature: 0.4, max_tokens: 200,
    messages: [
      { role: "system", content: "Trading analyst. Reply in ANALYSIS:/EDGE: format only." },
      { role: "user", content: prompt }
    ]
  });

  const req = https.request({
    hostname: "api.groq.com", path: "/openai/v1/chat/completions", method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer "+GROQ, "Content-Length": Buffer.byteLength(body) }
  }, function(res) {
    let raw="";
    res.on("data",function(c){raw+=c;});
    res.on("end",function() {
      try {
        const txt = JSON.parse(raw).choices[0].message.content;
        const a = txt.match(/ANALYSIS:\s*([\s\S]+?)(?=EDGE:|$)/i);
        const e = txt.match(/EDGE:\s*([\s\S]+?)$/i);
        callback(a?a[1].trim():"Signal confirmed by live indicators.", e?e[1].trim():"Enter at candle open.");
      } catch(e) { callback("Live data confirms "+ld.signal+" signal.", "Enter at candle open."); }
    });
  });
  req.on("error",function(){callback("Live data confirms "+ld.signal+" signal.","Enter at candle open.");});
  req.setTimeout(15000,function(){req.destroy();callback("Live data confirms "+ld.signal+" signal.","Enter at candle open.");});
  req.write(body); req.end();
}

// ── Groq fallback ─────────────────────────────────────────────────────────────
function groqOnly(pair, expiry, callback) {
  const body = JSON.stringify({
    model: "llama-3.3-70b-versatile", temperature: 0.5, max_tokens: 400,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown." },
      { role: "user", content: "Signal for "+pair+" expiry "+expiry+" Pocket Option. JSON: {\"signal\":\"CALL or PUT\",\"price\":\"real price\",\"change\":\"+0.00%\",\"rsi\":\"50\",\"macd\":\"BULLISH or BEARISH\",\"trend\":\"BULLISH or BEARISH\",\"support\":\"price\",\"resistance\":\"price\",\"confidence\":72,\"risk\":\"Medium\",\"analysis\":\"2 sentences\",\"edge\":\"tip\"}" }
    ]
  });
  const req = https.request({
    hostname:"api.groq.com", path:"/openai/v1/chat/completions", method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+GROQ,"Content-Length":Buffer.byteLength(body)}
  }, function(res) {
    let raw="";
    res.on("data",function(c){raw+=c;});
    res.on("end",function(){
      try {
        let txt = JSON.parse(raw).choices[0].message.content.trim();
        txt = txt.replace(/```json/gi,"").replace(/```/g,"").trim();
        const s=txt.indexOf("{"), e=txt.lastIndexOf("}");
        const r = JSON.parse(txt.slice(s,e+1));
        r.live=false; callback(null,r);
      } catch(e){callback(new Error("Groq failed"));}
    });
  });
  req.on("error",callback);
  req.setTimeout(20000,function(){req.destroy();callback(new Error("Timeout"));});
  req.write(body); req.end();
}

// ── Main analysis ─────────────────────────────────────────────────────────────
function analyze(pair, expiry, callback) {
  const symbol = TD_MAP[pair];
  if (!symbol) return groqOnly(pair, expiry, callback);

  fetchCandles(symbol, function(err, candles) {
    if (err || !candles || candles.length < 20) {
      return groqOnly(pair, expiry, callback);
    }
    const closes = candles.map(function(c){return c.close;});
    const rsi    = calcRSI(closes);
    const macd   = calcMACD(closes);
    const bb     = calcBB(closes);
    const trend  = calcTrend(closes);
    const sig    = calcSig(rsi,macd,bb,trend);
    const price  = closes[closes.length-1];
    const res    = Math.max.apply(null,candles.slice(-20).map(function(c){return c.high;})).toFixed(5);
    const sup    = Math.min.apply(null,candles.slice(-20).map(function(c){return c.low;})).toFixed(5);
    const chg    = (((price-closes[0])/closes[0])*100).toFixed(2);
    const ld = { price:price.toFixed(5), rsi:rsi, macd:macd, trend:trend, signal:sig.dir, support:sup, resistance:res };

    askGroq(pair, expiry, ld, function(analysis, edge) {
      callback(null, {
        pair, expiry, price:price.toFixed(5),
        change:(chg>=0?"+":"")+chg+"%",
        rsi:rsi.toString(), macd, trend,
        signal:sig.dir, confidence:sig.conf,
        risk:sig.conf>80?"Low":sig.conf>70?"Medium":"High",
        support:sup, resistance:res, analysis, edge, live:true
      });
    });
  });
}

// ── Format ────────────────────────────────────────────────────────────────────
function fmt(r) {
  const isCall = r.signal==="CALL";
  const rsiN   = parseInt(r.rsi||50);
  return (
    "*NOXA AI SIGNAL* "+(isCall?"[BUY]":"[SELL]")+"\n\n" +
    "====================\n" +
    "* "+(isCall?"HIGHER / BUY  ^":"LOWER / SELL  v")+" *\n" +
    "Pair:   *"+(r.pair||r.asset)+"*\n" +
    "Expiry: *"+r.expiry+"*\n" +
    "Price:  *"+r.price+"*\n" +
    "Data:   "+(r.live?"LIVE":"AI ESTIMATE")+"\n" +
    "====================\n\n" +
    "*INDICATORS*\n" +
    "- 24h Change: "+r.change+"\n" +
    "- RSI(14):    "+r.rsi+(rsiN>70?" OVERBOUGHT":rsiN<30?" OVERSOLD":" NEUTRAL")+"\n" +
    "- MACD:       "+r.macd+"\n" +
    "- Trend:      "+r.trend+"\n\n" +
    "*KEY LEVELS*\n" +
    "- Support:    "+r.support+"\n" +
    "- Resistance: "+r.resistance+"\n\n" +
    "*CONFIDENCE: "+r.confidence+"%*\n" +
    bar(r.confidence)+"\n" +
    "Risk: "+r.risk+"\n\n" +
    "*ANALYSIS*\n"+r.analysis+"\n\n" +
    "*EDGE*\n"+r.edge+"\n\n" +
    "====================\n" +
    "_NOXA AI - Pocket Option_"
  );
}

// ── Keyboards ─────────────────────────────────────────────────────────────────
function catKB() { return {inline_keyboard:chunk(Object.keys(PAIRS),2).map(function(row){return row.map(function(c){return{text:c,callback_data:"C:"+c};});})}; }
function pairKB(cat) {
  const rows = chunk(PAIRS[cat]||[],2).map(function(row){return row.map(function(p){return{text:p,callback_data:"P:"+p};});});
  rows.push([{text:"<< Back",callback_data:"BACK:cat"}]);
  return {inline_keyboard:rows};
}
function expKB(cat) {
  const rows = chunk(EXPIRIES,3).map(function(row){return row.map(function(e){return{text:e,callback_data:"E:"+e};});});
  rows.push([{text:"<< Back",callback_data:"BP:"+cat}]);
  return {inline_keyboard:rows};
}
function resKB(pair,expiry,cat) { return {inline_keyboard:[[{text:"Analyze Again",callback_data:"E:"+expiry}],[{text:"New Pair",callback_data:"C:"+cat},{text:"New Expiry",callback_data:"P:"+pair}]]}; }

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/,function(msg){
  sessions[msg.chat.id]={};
  bot.sendMessage(msg.chat.id,
    "Welcome *"+(msg.from.first_name||"Trader")+"*!\n\n" +
    "*NOXA AI* - Pocket Option Signal Bot\n\n" +
    "Live data signals for 60+ pairs!\n\n" +
    "/analyze - Get signal\n/help - Help",
    {parse_mode:"Markdown",reply_markup:{inline_keyboard:[[{text:"Get Signal Now",callback_data:"START"}]]}}
  );
});
bot.onText(/\/analyze/,function(msg){
  sessions[msg.chat.id]={};
  bot.sendMessage(msg.chat.id,"Select Category:",{reply_markup:catKB()});
});
bot.onText(/\/help/,function(msg){
  bot.sendMessage(msg.chat.id,
    "*NOXA AI Help*\n\n" +
    "60+ pairs with live data!\n\n" +
    "Forex: 30 pairs\nForex OTC: 12 pairs (24/7)\nCrypto: 15 coins\nCommodities: 7\nIndices: 10\n\n" +
    "Best: 1min candle + 3min or 5min expiry\n\n" +
    "LIVE DATA = real RSI, MACD, Trend\nAI ESTIMATE = AI market knowledge\n\n" +
    "Always use risk management!",
    {parse_mode:"Markdown"}
  );
});

// ── Callbacks ─────────────────────────────────────────────────────────────────
bot.on("callback_query",function(q){
  var cid=q.message.chat.id, mid=q.message.message_id, data=q.data, sess=session(cid);
  bot.answerCallbackQuery(q.id);

  if(data==="START"||data==="BACK:cat"){
    sessions[cid]={};
    return bot.editMessageText("Select Category:",{chat_id:cid,message_id:mid,reply_markup:catKB()});
  }
  if(data.startsWith("C:")){
    sess.cat=data.slice(2);
    return bot.editMessageText("*"+sess.cat+"*\n\nSelect pair:",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:pairKB(sess.cat)});
  }
  if(data.startsWith("BP:")){
    sess.cat=data.slice(3);
    return bot.editMessageText("*"+sess.cat+"*\n\nSelect pair:",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:pairKB(sess.cat)});
  }
  if(data.startsWith("P:")){
    sess.pair=data.slice(2);
    return bot.editMessageText("Pair: *"+sess.pair+"*\n\nSelect expiry:",{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:expKB(sess.cat||"FOREX")});
  }
  if(data.startsWith("E:")){
    sess.expiry=data.slice(2);
    var pair=sess.pair, expiry=sess.expiry, cat=sess.cat||"FOREX";
    if(!pair) return bot.editMessageText("Select a pair first.",{chat_id:cid,message_id:mid,reply_markup:catKB()});

    bot.editMessageText("Fetching LIVE data for *"+pair+"*...\n\nCalculating RSI, MACD, Trend...\nPlease wait...",
      {chat_id:cid,message_id:mid,parse_mode:"Markdown"});

    analyze(pair,expiry,function(err,result){
      if(err||!result){
        return bot.editMessageText("Could not get signal. Please retry.",{
          chat_id:cid,message_id:mid,
          reply_markup:{inline_keyboard:[[{text:"Retry",callback_data:"E:"+expiry}],[{text:"New Pair",callback_data:"BACK:cat"}]]}
        });
      }
      bot.editMessageText(fmt(result),{chat_id:cid,message_id:mid,parse_mode:"Markdown",reply_markup:resKB(pair,expiry,cat)});
    });
  }
});

setInterval(function(){console.log("alive "+new Date().toISOString());},5*60*1000);
