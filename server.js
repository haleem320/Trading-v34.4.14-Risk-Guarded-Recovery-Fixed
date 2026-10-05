
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);
const BOT_ADMIN_TOKEN = String(process.env.BOT_ADMIN_TOKEN || "").trim();
const BOT_STATE_FILE = process.env.BOT_STATE_FILE || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ".", "bot-state-v32.json");
const BOT_TIMEZONE = String(process.env.BOT_TIMEZONE || "Asia/Kabul");
// v34.4.14 QUALITY PROFILE — STRICT PULLBACK ENTRY + RISK GUARD MODE
// Designed to avoid top entries while still producing a reasonable number of
// high-quality setups. The profile can be disabled explicitly with
// SMART_PULLBACK_PROFILE=false for legacy behavior.
const SMART_PULLBACK_PROFILE = String(process.env.SMART_PULLBACK_PROFILE ?? "true").toLowerCase() === "true";
const BOT_VERSION = "34.4.14-risk-guard-recovery-fixed";
const ENTRY_MODE_NAME = "STRICT_PULLBACK_CLOSED_RECLAIM";

const MIN_RISK_REWARD = Math.max(
  0.5,
  Number(process.env.MIN_RISK_REWARD || (SMART_PULLBACK_PROFILE ? 1.60 : 1.40))
);
const MIN_SIGNAL_SCORE = Math.max(50, Math.min(100, Number(process.env.MIN_SIGNAL_SCORE || (SMART_PULLBACK_PROFILE ? 80 : 82))));
const MIN_SCORE_EDGE = Math.max(0, Number(process.env.MIN_SCORE_EDGE || (SMART_PULLBACK_PROFILE ? 7 : 8)));
const BASE_URL = "https://api.mexc.com";

const ACCESS_KEY = process.env.MEXC_ACCESS_KEY || "";
const SECRET_KEY = process.env.MEXC_SECRET_KEY || "";

const SYMBOL = process.env.DEFAULT_SYMBOL || "SOL_USDT";
const INTERVAL = process.env.INTERVAL || "Min5";
const MAX_ORDER_USDT = Number(process.env.MAX_ORDER_USDT || 5);
// v34.3.11: adapt order margin to the actually available USDT so an existing
// position cannot freeze the whole entry engine when only a few cents of the
// requested margin are unavailable. A small reserve is kept for fees/buffer.
const ADAPTIVE_ORDER_SIZE = String(process.env.ADAPTIVE_ORDER_SIZE ?? "true").toLowerCase() === "true";
const ORDER_BALANCE_RESERVE_USDT = Math.max(0.05, Number(process.env.ORDER_BALANCE_RESERVE_USDT || 0.20));
const MIN_ADAPTIVE_ORDER_USDT = Math.max(0.50, Number(process.env.MIN_ADAPTIVE_ORDER_USDT || 1.50));

// Full-universe production scanner. MEXC publishes the active Futures contract
// list and an all-symbol ticker feed, so the bot refreshes its universe from MEXC
// instead of hard-coding five coins. Every active USDT perpetual is included in
// the market universe. Deep multi-timeframe analysis is processed in rotating
// batches so the bot can cover a large universe without getting stuck or
// hammering the API.
const FALLBACK_SYMBOLS = String(
  process.env.TRADING_SYMBOLS || "BTC_USDT,ETH_USDT,BNB_USDT,SOL_USDT,XRP_USDT"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const CORE_SYMBOLS = Array.from(new Set(FALLBACK_SYMBOLS));
const SYMBOL_LIMIT = 0;
const SCAN_BATCH_SIZE = Math.max(1068, Math.min(2000, Number(process.env.SCAN_BATCH_SIZE || 1068)));
const FAST_SCAN_CONCURRENCY = Math.max(4, Math.min(24, Number(process.env.FAST_SCAN_CONCURRENCY || 12)));
const DEEP_SCAN_CANDIDATES = Math.max(20, Math.min(120, Number(process.env.DEEP_SCAN_CANDIDATES || 60)));
const SCAN_SYMBOLS = SCAN_BATCH_SIZE;
const UNIVERSE_MIN_24H_USDT = Math.max(0, Number(process.env.UNIVERSE_MIN_24H_USDT || 0));
const UNIVERSE_REFRESH_TTL_MS = Math.max(60*1000, Number(process.env.UNIVERSE_REFRESH_TTL_MS || 5*60*1000));

const ADX_MIN = Math.max(10, Number(process.env.ADX_MIN || 18));
const VOLUME_MULTIPLIER = Math.max(0.75, Number(process.env.VOLUME_MULTIPLIER || 1.15));

// BREAKOUT + RETEST ENGINE: entries require a confirmed closed 5m breakout, a pullback/retest, and a directional reclaim. Breakout continuation without a pullback is blocked. Structure-based SL uses the local swing + ATR buffer.
// A live entry can only come from a confirmed closed 5m candle breaking the
// previous N-candle high/low with volume, body and close-location confirmation.
const BREAKOUT_LOOKBACK = Math.max(5, Number(process.env.BREAKOUT_LOOKBACK || 20));
const BREAKOUT_BUFFER_PCT = Math.max(0, Number(process.env.BREAKOUT_BUFFER_PCT || 0.0005));
const BREAKOUT_VOLUME_MULTIPLIER = Math.max(1, Number(process.env.BREAKOUT_VOLUME_MULTIPLIER || (SMART_PULLBACK_PROFILE ? 1.25 : 1.5)));
const BREAKOUT_MIN_BODY_ATR = Math.max(0.05, Number(process.env.BREAKOUT_MIN_BODY_ATR || (SMART_PULLBACK_PROFILE ? 0.28 : 0.35)));
const BREAKOUT_MIN_BODY_RATIO = Math.max(0.20, Math.min(0.95, Number(process.env.BREAKOUT_MIN_BODY_RATIO || (SMART_PULLBACK_PROFILE ? 0.40 : 0.45))));
const BREAKOUT_CLOSE_LOCATION_MIN = Math.max(0.50, Math.min(0.98, Number(process.env.BREAKOUT_CLOSE_LOCATION_MIN || (SMART_PULLBACK_PROFILE ? 0.65 : 0.70))));
const BREAKOUT_MAX_EXTENSION_ATR = Math.max(0.25, Number(process.env.BREAKOUT_MAX_EXTENSION_ATR || (SMART_PULLBACK_PROFILE ? 0.95 : 0.75)));
const BREAKOUT_MIN_SCORE = Math.max(50, Math.min(100, Number(process.env.BREAKOUT_MIN_SCORE || (SMART_PULLBACK_PROFILE ? 68 : 70))));
const BREAKOUT_REQUIRE_VOLUME = String(process.env.BREAKOUT_REQUIRE_VOLUME ?? "true").toLowerCase() === "true";
// Legacy breakout-retest flags are retained only for compatibility. The live
// entry engine below independently requires a meaningful pullback/retest and
// a closed-candle directional reclaim; these legacy flags cannot disable that safety gate.
const REQUIRE_BREAKOUT_RETEST = false;
const STRICT_BREAKOUT_RETEST_REQUIRED = false;
// EARLY BREAKOUT: allow entry during the live 5m trigger candle instead of
// waiting for the candle to fully close. This reduces late entries while
// keeping strict extension/volume/body guards to avoid chasing.
// Strictly closed-candle entries: live/in-progress trigger candles are never allowed.
const EARLY_BREAKOUT_ENABLED = false;
const EARLY_BREAKOUT_VOLUME_MULTIPLIER = Math.max(1, Number(process.env.EARLY_BREAKOUT_VOLUME_MULTIPLIER || 1.15));
const EARLY_BREAKOUT_MIN_BODY_ATR = Math.max(0.05, Number(process.env.EARLY_BREAKOUT_MIN_BODY_ATR || 0.20));
const EARLY_BREAKOUT_MIN_BODY_RATIO = Math.max(0.15, Math.min(0.90, Number(process.env.EARLY_BREAKOUT_MIN_BODY_RATIO || 0.30)));
const EARLY_BREAKOUT_CLOSE_LOCATION_MIN = Math.max(0.50, Math.min(0.95, Number(process.env.EARLY_BREAKOUT_CLOSE_LOCATION_MIN || 0.60)));
const EARLY_BREAKOUT_MAX_EXTENSION_ATR = Math.max(0.20, Number(process.env.EARLY_BREAKOUT_MAX_EXTENSION_ATR || 0.75));
const EARLY_BREAKOUT_MIN_SCORE = Math.max(50, Math.min(100, Number(process.env.EARLY_BREAKOUT_MIN_SCORE || 70)));
const ANALYSIS_TIMEFRAMES = ["Min5","Min15","Min30","Min60","Hour4","Day1"];
const SR_LOOKBACK = Math.max(20, Number(process.env.SR_LOOKBACK || 50));
const NEWS_RISK_ENABLED = String(process.env.NEWS_RISK_ENABLED ?? "true").toLowerCase() === "true";
const NEWS_RISK_LOOKBACK_MINUTES = Math.max(15, Number(process.env.NEWS_RISK_LOOKBACK_MINUTES || 90));
const NEWS_BLOCK_RISK_SCORE = Math.max(1, Number(process.env.NEWS_BLOCK_RISK_SCORE || 2));
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;
const NEWS_FEEDS = (process.env.NEWS_RSS_FEEDS || "https://www.coindesk.com/arc/outboundfeeds/rss/|https://cointelegraph.com/rss")
  .split("|").map(s => s.trim()).filter(Boolean);
const NEWS_HIGH_RISK_TERMS = [
  "hack","hacked","exploit","security breach","bridge attack","rug pull","bankruptcy",
  "insolvency","delisting","delisted","halt withdrawals","withdrawals suspended","frozen withdrawals",
  "liquidation","liquidated","lawsuit","fraud","stolen funds","critical vulnerability","depeg","de-pegged"
];
const NEWS_MARKET_RISK_TERMS = ["exchange collapse","exchange hacked","market crash","emergency halt","trading suspended"];
const TARGET_LEVERAGE = Math.max(1, Number(process.env.TARGET_LEVERAGE || 20));
const CONFIGURED_OPEN_TYPE = Math.max(1, Math.min(2, Number(process.env.OPEN_TYPE || 1)));
const CONFIGURED_POSITION_MODE = Math.max(1, Math.min(2, Number(process.env.POSITION_MODE || 2)));
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 0.0125);
const CONFIGURED_TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 0.02);
const FORCE_AUTO_STOP_LOSS = String(process.env.FORCE_AUTO_STOP_LOSS ?? "true").toLowerCase() === "true";
const MANUAL_STOP_LOSS = FORCE_AUTO_STOP_LOSS ? false : String(process.env.MANUAL_STOP_LOSS ?? "false").toLowerCase() === "true";
// Runner mode: use a distant 10% protective TP so strong moves are not cut at 2.5%.
// From +2.5%, the existing trailing/break-even manager protects the profit.
const TAKE_PROFIT_PCT = Math.max(0.02, Math.min(0.04, CONFIGURED_TAKE_PROFIT_PCT));
const ADAPTIVE_TP_ENABLED = String(process.env.ADAPTIVE_TP_ENABLED ?? "true").toLowerCase() === "true";
const ADAPTIVE_TP_START_PCT = TAKE_PROFIT_PCT;
const ADAPTIVE_TP_MAX_PCT = Math.max(TAKE_PROFIT_PCT, Math.min(0.04, Number(process.env.ADAPTIVE_TP_MAX_PCT || 0.04)));
const ADAPTIVE_TP_STEP_PCT = Math.max(0.005, Number(process.env.ADAPTIVE_TP_STEP_PCT || 0.015));
const ADAPTIVE_TP_EXTEND_TRIGGER_PCT = Math.max(0.02, Number(process.env.ADAPTIVE_TP_EXTEND_TRIGGER_PCT || 0.025));
const ADAPTIVE_TP_STRONG_ADX = Math.max(10, Number(process.env.ADAPTIVE_TP_STRONG_ADX || 20));
const ADAPTIVE_TP_STRONG_SLOPE_PCT = Math.max(0.0001, Number(process.env.ADAPTIVE_TP_STRONG_SLOPE_PCT || 0.0015));
const ADAPTIVE_TP_RSI_LONG_MAX = Math.min(90, Number(process.env.ADAPTIVE_TP_RSI_LONG_MAX || 76));
const ADAPTIVE_TP_RSI_SHORT_MIN = Math.max(10, Number(process.env.ADAPTIVE_TP_RSI_SHORT_MIN || 24));
const TARGET_FIRST_MIN_TP_PCT = ADAPTIVE_TP_START_PCT;
const TARGET_FIRST_MAX_TP_PCT = ADAPTIVE_TP_MAX_PCT;
const TARGET_FIRST_ATR_MULT = Math.max(0.25, Number(process.env.TARGET_FIRST_ATR_MULT || 1.00));

const REAL_TRADING_ENABLED =
  String(process.env.REAL_TRADING_ENABLED || "true").toLowerCase() === "true";

const AUTO_TRADING_ENABLED =
  String(process.env.AUTO_TRADING_ENABLED || "true").toLowerCase() === "true";

// Keep the entry scan responsive even if Railway has an old AUTO_INTERVAL_MINUTES
// value such as 120 minutes. A long scheduler interval can leave a recovered
// watchdog lock idle for hours. The bot's existing overlap/stale-lock protection
// still prevents concurrent scans.
const AUTO_INTERVAL_MINUTES = Math.min(
  5,
  Math.max(1, Number(process.env.AUTO_INTERVAL_MINUTES || 5))
);

// Trade Management watches every live position independently from the entry
// signal loop. It protects positions, moves the stop to break-even, and then
// trails the stop in the profitable direction without moving it backwards.
const TRADE_MANAGER_ENABLED =
  String(process.env.TRADE_MANAGER_ENABLED ?? "true").toLowerCase() === "true";
const TRADE_MANAGER_INTERVAL_SECONDS = Math.max(5, Number(process.env.TRADE_MANAGER_INTERVAL_SECONDS || 10));
const AUTO_RUN_STALE_MS = Math.max(60*1000, Number(process.env.AUTO_RUN_STALE_MS || 8*60*1000));
const BREAK_EVEN_ENABLED =
  !MANUAL_STOP_LOSS && String(process.env.BREAK_EVEN_ENABLED ?? "true").toLowerCase() === "true";
const BREAK_EVEN_TRIGGER_PCT = Math.max(0, Number(process.env.BREAK_EVEN_TRIGGER_PCT || 0.010));
const BREAK_EVEN_OFFSET_PCT = Math.max(0, Number(process.env.BREAK_EVEN_OFFSET_PCT || 0.002));
const TRAILING_STOP_ENABLED =
  !MANUAL_STOP_LOSS && String(process.env.TRAILING_STOP_ENABLED ?? "true").toLowerCase() === "true";
const TRAILING_TRIGGER_PCT = Math.max(BREAK_EVEN_TRIGGER_PCT, Number(process.env.TRAILING_TRIGGER_PCT || 0.020));
const TRAILING_STOP_PCT = Math.max(0.001, Number(process.env.TRAILING_STOP_PCT || 0.008));
const MIN_STOP_DISTANCE_PCT = Math.max(0.0005, Number(process.env.MIN_STOP_DISTANCE_PCT || 0.001));
const MAX_OPEN_POSITIONS = Math.max(1, Number(process.env.MAX_OPEN_POSITIONS || (SMART_PULLBACK_PROFILE ? 6 : 6)));
const MAX_SAME_DIRECTION_POSITIONS = Math.max(1, Number(process.env.MAX_SAME_DIRECTION_POSITIONS || (SMART_PULLBACK_PROFILE ? 6 : 6)));
const MAX_TRADES_PER_DAY = Math.max(1, Number(process.env.MAX_TRADES_PER_DAY || 12));
// Account-level circuit breaker: stop opening new trades after a meaningful
// daily equity drawdown. This is a hard safety gate, not a performance guarantee.
const DAILY_DRAWDOWN_PROTECTION_ENABLED = String(process.env.DAILY_DRAWDOWN_PROTECTION_ENABLED ?? "true").toLowerCase() === "true";
const MAX_DAILY_DRAWDOWN_PCT = Math.max(0.005, Math.min(0.20, Number(process.env.MAX_DAILY_DRAWDOWN_PCT || 0.03)));
const ENTRY_COOLDOWN_ALL_TRADES = String(process.env.ENTRY_COOLDOWN_ALL_TRADES ?? "true").toLowerCase() === "true";
const MAX_ENTRY_SLIPPAGE_PCT = Math.max(0.0005, Math.min(0.02, Number(process.env.MAX_ENTRY_SLIPPAGE_PCT || 0.0025)));
const REQUIRE_DAILY_ALIGNMENT = String(process.env.REQUIRE_DAILY_ALIGNMENT ?? "true").toLowerCase() === "true";
const REQUIRE_15M_ALIGNMENT = String(process.env.REQUIRE_15M_ALIGNMENT ?? "true").toLowerCase() === "true";
const REQUIRE_1H_ALIGNMENT = String(process.env.REQUIRE_1H_ALIGNMENT ?? "true").toLowerCase() === "true";
const MIN_PRECISION_SCORE = Math.max(50, Math.min(100, Number(process.env.MIN_PRECISION_SCORE || 80)));
const ENTRY_COOLDOWN_MINUTES = Math.max(0, Number(process.env.ENTRY_COOLDOWN_MINUTES || 20));
const MAX_LOSS_STREAK = Math.max(1, Number(process.env.MAX_LOSS_STREAK || 2));
const LOSS_STREAK_COOLDOWN_MINUTES = Math.max(15, Number(process.env.LOSS_STREAK_COOLDOWN_MINUTES || 60));
const VOLATILITY_SPIKE_ATR_MULTIPLIER = Math.max(1.5, Number(process.env.VOLATILITY_SPIKE_ATR_MULTIPLIER || 2.5));
const LIQUIDITY_MIN_24H_USDT = Math.max(0, Number(process.env.LIQUIDITY_MIN_24H_USDT || 200000));
const MAX_SPREAD_PCT = Math.max(0.0001, Number(process.env.MAX_SPREAD_PCT || 0.0015));
// Entry-location protection: avoid chasing extended moves into nearby support/resistance.
const ENTRY_SR_MIN_ROOM = Math.max(0.05, Math.min(0.35, Number(process.env.ENTRY_SR_MIN_ROOM || 0.08)));
const ENTRY_SR_BUFFER_ATR = Math.max(0.10, Number(process.env.ENTRY_SR_BUFFER_ATR || 0.25));
const ENTRY_MAX_DISTANCE_E21_ATR = Math.max(0.75, Number(process.env.ENTRY_MAX_DISTANCE_E21_ATR || 2.75));
const ENTRY_MIN_TP_ROOM_ATR = Math.max(0.10, Number(process.env.ENTRY_MIN_TP_ROOM_ATR || 0.35));
const PULLBACK_MAX_BARS_SINCE_TOUCH = Math.max(2, Number(process.env.PULLBACK_MAX_BARS_SINCE_TOUCH || 16));
const ENTRY_MAX_PULLBACK_DISTANCE_ATR = Math.max(0.25, Number(process.env.ENTRY_MAX_PULLBACK_DISTANCE_ATR || 1.50));
// Balanced pullback protection: allow strong setups from a meaningful >=0.30 ATR pullback, while S/R and anti-chase protections remain hard.
const ENTRY_MIN_PULLBACK_DEPTH_ATR = Math.max(0.30, Number(process.env.ENTRY_MIN_PULLBACK_DEPTH_ATR || 0.30));
const ENTRY_TRIGGER_MIN_PULLBACK_DEPTH_ATR = Math.max(0.25, Number(process.env.ENTRY_TRIGGER_MIN_PULLBACK_DEPTH_ATR || 0.30));
// Strict trigger-quality protection: only enter after a very recent pullback
// and a clear 5m reclaim candle. This reduces late/chasing entries.
const ENTRY_TRIGGER_MAX_BARS = Math.max(2, Number(process.env.ENTRY_TRIGGER_MAX_BARS || (SMART_PULLBACK_PROFILE ? 10 : 20)));
const ENTRY_TRIGGER_MAX_DISTANCE_ATR = Math.max(0.25, Number(process.env.ENTRY_TRIGGER_MAX_DISTANCE_ATR || (SMART_PULLBACK_PROFILE ? 1.35 : 1.75)));
const ENTRY_TRIGGER_MIN_BODY_PCT = Math.max(0.10, Math.min(0.80, Number(process.env.ENTRY_TRIGGER_MIN_BODY_PCT || 0.15)));
const ENTRY_TRIGGER_MAX_WICK_PCT = Math.max(0.15, Math.min(0.80, Number(process.env.ENTRY_TRIGGER_MAX_WICK_PCT || 0.75)));
// Minimum free room to the next recent S/R level, measured in ATR. This is
// intentionally stricter than the old percentage-only filter to prevent late
// entries directly underneath resistance / above support.
const ENTRY_SR_MIN_ROOM_ATR = Math.max(0.25, Number(process.env.ENTRY_SR_MIN_ROOM_ATR || 0.60));
const ENTRY_MOMENTUM_MIN_VOLUME = Math.max(0.75, Number(process.env.ENTRY_MOMENTUM_MIN_VOLUME || 1.00));
const ENTRY_MOMENTUM_MIN_BODY_ATR = Math.max(0.05, Number(process.env.ENTRY_MOMENTUM_MIN_BODY_ATR || 0.15));
const ENTRY_MOMENTUM_CLOSE_LOCATION = Math.max(0.50, Math.min(0.90, Number(process.env.ENTRY_MOMENTUM_CLOSE_LOCATION || 0.60)));
// Hard pullback/retest entry protection. A high score alone can never create
// a live order. The 15m setup must have a recent pullback and the 5m trigger
// must reclaim that area in the intended direction.
// v34.4.14: pullback/retest is a HARD entry requirement.
// A trend score alone can never create an order; the bot must first see a
// meaningful pullback and then a closed-candle directional reclaim.
const REQUIRE_PULLBACK_ENTRY = true;
const ENTRY_SETUP_PULLBACK_MAX_BARS = Math.max(2, Number(process.env.ENTRY_SETUP_PULLBACK_MAX_BARS || 8));
const ENTRY_TRIGGER_PULLBACK_MAX_BARS = Math.max(2, Number(process.env.ENTRY_TRIGGER_PULLBACK_MAX_BARS || 6));
const ENTRY_PULLBACK_RECLAIM_BUFFER_PCT = Math.max(0.0002, Number(process.env.ENTRY_PULLBACK_RECLAIM_BUFFER_PCT || 0.0008));
const BREAKOUT_RETEST_LOOKBACK_5M = Math.max(2, Number(process.env.BREAKOUT_RETEST_LOOKBACK_5M || (SMART_PULLBACK_PROFILE ? 16 : 6)));
const BREAKOUT_RETEST_TOLERANCE_PCT = Math.max(0.001, Number(process.env.BREAKOUT_RETEST_TOLERANCE_PCT || (SMART_PULLBACK_PROFILE ? 0.0045 : 0.003)));
// Pullback/retest entry mode: never enter simply because trend + score are high.
// A valid entry must first show a pullback/retest and then a directional reclaim.
const PULLBACK_LOOKBACK = Math.max(6, Number(process.env.PULLBACK_LOOKBACK || 20));
const PULLBACK_TOUCH_TOLERANCE_PCT = Math.max(0.001, Number(process.env.PULLBACK_TOUCH_TOLERANCE_PCT || 0.012));
const PULLBACK_RECLAIM_BUFFER_PCT = Math.max(0.0001, Number(process.env.PULLBACK_RECLAIM_BUFFER_PCT || 0.0006));
const STRUCTURE_STOP_BUFFER_ATR = Math.max(0.05, Number(process.env.STRUCTURE_STOP_BUFFER_ATR || (SMART_PULLBACK_PROFILE ? 0.25 : 0.35)));
const STRUCTURE_STOP_MIN_PCT = Math.max(0.004, Number(process.env.STRUCTURE_STOP_MIN_PCT || (SMART_PULLBACK_PROFILE ? 0.005 : 0.006)));
const MAX_STRUCTURE_STOP_PCT = Math.max(STRUCTURE_STOP_MIN_PCT, Number(process.env.MAX_STRUCTURE_STOP_PCT || (SMART_PULLBACK_PROFILE ? 0.0125 : 0.015)));
const PROTECTION_VERIFY_RETRIES = Math.max(4, Number(process.env.PROTECTION_VERIFY_RETRIES || 8));
const PROTECTION_VERIFY_DELAY_MS = Math.max(500, Number(process.env.PROTECTION_VERIFY_DELAY_MS || 1000));


// ALLOWED_SYMBOLS is the live MEXC Futures universe. A stale Railway
// ALLOWED_SYMBOLS/TRADING_SYMBOLS variable must never shrink the exchange-wide
// scanner. FALLBACK_SYMBOLS are used only if MEXC cannot return the universe.
const configuredSymbols = [];
let ALLOWED_SYMBOLS = [...CORE_SYMBOLS];
let scanCursor = 0;
let scanCycle = 0;

let lastAutoRun = null;
let autoBusySince = 0;
let lastAutoResult = null;
let autoBusy = false;
let lastTradeSignalCandle = new Map();
let tradeManagerBusy = false;
let lastTradeManagerRun = null;
let lastTradeManagerResult = null;
let tradeManagerHistory = [];
let tradeRiskState = {day:"", tradesToday:0, lastEntryAt:0, lossStreak:0, lastClosedAt:0, lastObservedPositions:{}, countedClosedPositions:{}, startEquity:null, seeded:false};
let stateLoaded = false;
let stateSaveTimer = null;
let btcHourlyCache = {time:0, analysis:null};
let symbolUniverseCache = {time:0, symbols:[], removed:[], source:"fallback", marketRanked:false};
let newsRiskCache = {time:0, items:[], source:"rss", error:null};
let marketStatsCache = {time:0, stats:{}};
let tradeStatsCache = {time:0, key:"", value:null};
const TRADE_STATS_CACHE_TTL_MS = 60 * 1000;
const SYMBOL_UNIVERSE_TTL_MS = UNIVERSE_REFRESH_TTL_MS;


function authTokenFrom(req) {
  const header = String(req.get("x-bot-token") || "").trim();
  const auth = String(req.get("authorization") || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return header;
}

function requireAdmin(req, res, next) {
  if (!BOT_ADMIN_TOKEN) {
    return res.status(503).json({success:false,error:"BOT_ADMIN_TOKEN is required for protected trading actions"});
  }
  const supplied = authTokenFrom(req);
  const a = Buffer.from(supplied);
  const b = Buffer.from(BOT_ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) {
    return res.status(401).json({success:false,error:"Unauthorized"});
  }
  next();
}

function localDayKey(date=new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {timeZone:BOT_TIMEZONE, year:"numeric", month:"2-digit", day:"2-digit"}).format(date);
  } catch {
    return date.toISOString().slice(0,10);
  }
}

function loadPersistentState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BOT_STATE_FILE,"utf8"));
    if (raw && typeof raw === "object") tradeRiskState = {...tradeRiskState, ...raw};
  } catch (e) {
    console.log("STATE LOAD WARNING", e.message);
  }
}

function savePersistentState() {
  loadPersistentState();
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(path.resolve(BOT_STATE_FILE)), {recursive:true});
      const tmp = `${BOT_STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(tradeRiskState,null,2));
      fs.renameSync(tmp, BOT_STATE_FILE);
    } catch (e) {
      console.log("STATE SAVE WARNING", e.message);
    }
  }, 50);
}

function recordLoss() {
  resetDailyRiskState();
  tradeRiskState.lossStreak = Number(tradeRiskState.lossStreak || 0) + 1;
  tradeRiskState.lastClosedAt = Date.now();
  savePersistentState();
}

function recordWin() {
  resetDailyRiskState();
  tradeRiskState.lossStreak = 0;
  tradeRiskState.lastClosedAt = Date.now();
  savePersistentState();
}

async function refreshActiveSymbols(force=false) {
  if (!force && symbolUniverseCache.symbols.length && Date.now()-symbolUniverseCache.time < SYMBOL_UNIVERSE_TTL_MS) {
    return ALLOWED_SYMBOLS;
  }
  try {
    const [detailResult, tickerResult] = await Promise.allSettled([
      mexc("GET", "/api/v1/contract/detail", {}),
      mexc("GET", "/api/v1/contract/ticker", {})
    ]);
    const detailResp = detailResult.status === "fulfilled" ? detailResult.value : null;
    const tickerResp = tickerResult.status === "fulfilled" ? tickerResult.value : null;
    const rows = Array.isArray(detailResp?.data) ? detailResp.data : [];
    const tickers = Array.isArray(tickerResp?.data) ? tickerResp.data : [];

    marketStatsCache = {time:Date.now(), stats:Object.fromEntries(tickers.map(x => [String(x?.symbol || "").toUpperCase(), {
      amount24:num(x?.amount24) || 0, volume24:num(x?.volume24) || 0, lastPrice:num(x?.lastPrice) || 0,
      bid1:num(x?.bid1) || null, ask1:num(x?.ask1) || null, riseFallRate:num(x?.riseFallRate) || 0
    }]))};

    const activeSet = new Set(rows.filter(x => {
      const symbol=String(x?.symbol || "").toUpperCase();
      if(!symbol.endsWith("_USDT")) return false;
      const state=x?.state;
      return state===undefined || state===null || state==="" || Number(state)===0;
    }).map(x => String(x.symbol).toUpperCase()));

    // If the contract-detail endpoint is temporarily unavailable but ticker data
    // is healthy, keep the known USDT ticker universe rather than collapsing to 5.
    const tickerSymbols = tickers
      .map(x => String(x?.symbol || "").toUpperCase())
      .filter(s => s.endsWith("_USDT"));
    const universeSet = activeSet.size ? activeSet : new Set(tickerSymbols);

    const ranked = (tickers.length ? tickers : [...universeSet].map(symbol => ({symbol})))
      .map(x => ({symbol:String(x?.symbol || "").toUpperCase(), amount24:num(x?.amount24)||0}))
      .filter(x => universeSet.has(x.symbol))
      .filter(x => !UNIVERSE_MIN_24H_USDT || x.amount24 >= UNIVERSE_MIN_24H_USDT)
      .sort((a,b)=>b.amount24-a.amount24)
      .map(x=>x.symbol);

    const next = ranked.length ? ranked : [...universeSet];
    if(next.length) {
      ALLOWED_SYMBOLS=Array.from(new Set([...CORE_SYMBOLS, ...next]));
      // Keep only actually active symbols in the live universe; fallback cores
      // are retained only when MEXC returned no usable universe at all.
      ALLOWED_SYMBOLS=next;
      scanCursor = scanCursor % ALLOWED_SYMBOLS.length;
      symbolUniverseCache={
        time:Date.now(),
        symbols:ALLOWED_SYMBOLS,
        removed:CORE_SYMBOLS.filter(s=>!universeSet.has(s)),
        source:"mexc-all-active-usdt-futures",
        marketRanked:true
      };
    }
    return ALLOWED_SYMBOLS.length ? ALLOWED_SYMBOLS : CORE_SYMBOLS;
  } catch(e) {
    return ALLOWED_SYMBOLS.length ? ALLOWED_SYMBOLS : CORE_SYMBOLS;
  }
}

function xmlEntities(text="") {
  return String(text).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function parseRssItems(xml) {
  const out=[];
  const blocks=String(xml).match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title=(block.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g,"").trim();
    const pub=(block.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/(pubDate|published|updated)>/i)?.[2] || "").trim();
    const link=(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const time=Date.parse(pub);
    if(title) out.push({title:xmlEntities(title), link:xmlEntities(link), publishedAt:Number.isFinite(time)?new Date(time).toISOString():null, ts:Number.isFinite(time)?time:Date.now()});
  }
  return out;
}

async function refreshNewsRisk(force=false) {
  if (!NEWS_RISK_ENABLED) return {riskScore:0, items:[], blocked:false, enabled:false};
  if (!force && Date.now()-newsRiskCache.time < NEWS_CACHE_TTL_MS) return newsRiskCache;
  const items=[];
  let hadSuccess=false;
  for (const feed of NEWS_FEEDS) {
    try {
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),7000);
      const res=await fetch(feed,{signal:controller.signal,headers:{"User-Agent":"MEXC-Futures-Bot-News-Risk/1.0"}});
      clearTimeout(timer);
      if(!res.ok) continue;
      const text=await res.text();
      items.push(...parseRssItems(text));
      hadSuccess=true;
    } catch {}
  }
  const cutoff=Date.now()-NEWS_RISK_LOOKBACK_MINUTES*60*1000;
  const recent=items.filter(x=>x.ts>=cutoff).slice(0,80);
  let riskScore=0;
  for(const item of recent){
    const t=item.title.toLowerCase();
    if(NEWS_MARKET_RISK_TERMS.some(k=>t.includes(k))) riskScore=Math.max(riskScore,2);
    if(NEWS_HIGH_RISK_TERMS.some(k=>t.includes(k))) riskScore=Math.max(riskScore,2);
  }
  const result={time:Date.now(),items:recent.slice(0,30),riskScore,blocked:riskScore>=NEWS_BLOCK_RISK_SCORE,enabled:true,source:hadSuccess?"rss":"rss-unavailable",error:hadSuccess?null:"No RSS feed could be read"};
  newsRiskCache=result;
  return result;
}

function coinMatchesNews(symbol, title) {
  const base=String(symbol).split("_")[0].toLowerCase();
  const t=String(title).toLowerCase();
  return t.includes(base) || (base==="btc" && t.includes("bitcoin")) || (base==="eth" && t.includes("ethereum"));
}

function nowMs() {
  return Date.now();
}

const MEXC_MIN_REQUEST_GAP_MS = Math.max(40, Number(process.env.MEXC_MIN_REQUEST_GAP_MS || 110));
const MEXC_MAX_RETRIES = Math.max(1, Math.min(5, Number(process.env.MEXC_MAX_RETRIES || 4)));
let mexcRequestQueue = Promise.resolve();
let lastMexcRequestStart = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runMexcRequest(task) {
  const run = mexcRequestQueue.then(async () => {
    const wait = Math.max(0, MEXC_MIN_REQUEST_GAP_MS - (Date.now() - lastMexcRequestStart));
    if (wait) await sleep(wait);
    lastMexcRequestStart = Date.now();
    return task();
  });
  mexcRequestQueue = run.catch(() => {});
  return run;
}

const candleCache = new Map();
const CANDLE_CACHE_TTL_MS = { Min5: 15 * 1000, Min15: 10 * 60 * 1000, Min30: 15 * 60 * 1000, Min60: 30 * 60 * 1000, Hour4: 2 * 60 * 60 * 1000 };
const advancedSignalCache = new Map();
const ADVANCED_SIGNAL_CACHE_TTL_MS = 5 * 1000;

function sign(timestamp, params = "") {
  return crypto
    .createHmac("sha256", SECRET_KEY)
    .update(ACCESS_KEY + String(timestamp) + params)
    .digest("hex");
}

async function mexc(method, path, params = {}, privateReq = false) {
  let url = BASE_URL + path;
  let body = null;
  let headers = {};

  if (privateReq) {
    if (!ACCESS_KEY || !SECRET_KEY) {
      throw new Error("MEXC API credentials are not configured");
    }

    const timestamp = nowMs();
    let parameterString = "";

    if (method === "GET" || method === "DELETE") {
      const keys = Object.keys(params).sort();
      parameterString = keys
        .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== "")
        .map(k => `${k}=${params[k]}`)
        .join("&");
      if (parameterString) url += "?" + parameterString;
    } else {
      parameterString = JSON.stringify(params);
      body = parameterString;
      headers["Content-Type"] = "application/json";
    }

    headers["ApiKey"] = ACCESS_KEY;
    headers["Request-Time"] = String(timestamp);
    headers["Signature"] = sign(timestamp, parameterString);
    headers["Recv-Window"] = "10000";
  } else if (method === "GET") {
    const qs = Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== "")
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");
    if (qs) url += "?" + qs;
  }

  let lastError = null;
  for (let attempt = 0; attempt < MEXC_MAX_RETRIES; attempt++) {
    try {
      const res = await runMexcRequest(() => fetch(url, { method, headers, body }));
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      const rateLimited = res.status === 429 || Number(data?.code) === 510 ||
        /requests are too frequent|rate limit|too many requests/i.test(String(data?.message || text));
      if (rateLimited) {
        lastError = new Error(`MEXC API rate limit (attempt ${attempt + 1}/${MEXC_MAX_RETRIES})`);
        if (attempt + 1 < MEXC_MAX_RETRIES) {
          await sleep(700 * (2 ** attempt) + Math.floor(Math.random() * 300));
          continue;
        }
        throw new Error(`MEXC API error code 510: Requests are too frequent after ${MEXC_MAX_RETRIES} retries`);
      }

      if (!res.ok || (data && data.success === false)) {
        const code = data?.code !== undefined ? ` code ${data.code}` : "";
        throw new Error(`MEXC API error${code}: ${data?.message || text}`);
      }
      return data;
    } catch (e) {
      lastError = e;
      if (attempt + 1 >= MEXC_MAX_RETRIES || !/rate limit|too frequent|429/i.test(String(e.message))) throw e;
      await sleep(700 * (2 ** attempt) + Math.floor(Math.random() * 300));
    }
  }
  throw lastError || new Error("MEXC API request failed");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandles(raw) {
  const data = raw?.data ?? raw;
  if (!data) return [];

  // MEXC Futures REST can return columnar arrays:
  // { time:[], open:[], close:[], high:[], low:[], vol:[] }
  if (!Array.isArray(data) && typeof data === "object") {
    const times = data.time ?? data.t ?? data.timestamp ?? [];
    const opens = data.open ?? data.o ?? [];
    const highs = data.high ?? data.h ?? [];
    const lows = data.low ?? data.l ?? [];
    const closes = data.close ?? data.c ?? [];
    const volumes = data.vol ?? data.volume ?? data.v ?? [];

    if (Array.isArray(times) && Array.isArray(opens) &&
        Array.isArray(highs) && Array.isArray(lows) &&
        Array.isArray(closes)) {
      const n = Math.min(times.length, opens.length, highs.length,
                         lows.length, closes.length);
      const out = [];
      for (let i = 0; i < n; i++) {
        const c = {
          time: num(times[i]),
          open: num(opens[i]),
          high: num(highs[i]),
          low: num(lows[i]),
          close: num(closes[i]),
          volume: num(volumes[i])
        };
        if (c.open !== null && c.high !== null &&
            c.low !== null && c.close !== null) out.push(c);
      }
      return out;
    }
  }

  // Also support row arrays or object rows.
  if (!Array.isArray(data)) return [];
  return data.map(x => {
    if (Array.isArray(x)) {
      return {
        time: num(x[0]),
        open: num(x[1]),
        high: num(x[2]),
        low: num(x[3]),
        close: num(x[4]),
        volume: num(x[5])
      };
    }
    return {
      time: num(x.time ?? x.t ?? x.timestamp),
      open: num(x.open ?? x.o),
      high: num(x.high ?? x.h),
      low: num(x.low ?? x.l),
      close: num(x.close ?? x.c),
      volume: num(x.volume ?? x.v)
    };
  }).filter(c =>
    c.open !== null && c.high !== null &&
    c.low !== null && c.close !== null
  );
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1-k);
  }
  return e;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1-k);
    out[i] = e;
  }
  return out;
}

function rsi(values, period=14) {
  if (values.length <= period) return null;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++) {
    const d=values[i]-values[i-1];
    if (d>=0) gains += d; else losses -= d;
  }
  let avgGain=gains/period, avgLoss=losses/period;
  for (let i=period+1;i<values.length;i++) {
    const d=values[i]-values[i-1];
    const gain=Math.max(d,0);
    const loss=Math.max(-d,0);
    avgGain=(avgGain*(period-1)+gain)/period;
    avgLoss=(avgLoss*(period-1)+loss)/period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100/(1+(avgGain/avgLoss)));
}

function atr(candles, period=14) {
  if (candles.length <= period) return null;
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    trs.push(Math.max(
      c.high-c.low,
      Math.abs(c.high-p.close),
      Math.abs(c.low-p.close)
    ));
  }
  let a=trs.slice(0,period).reduce((x,y)=>x+y,0)/period;
  for(let i=period;i<trs.length;i++) a=(a*(period-1)+trs[i])/period;
  return a;
}

function intervalMinutes(interval) {
  const text = String(interval || "Min5");
  const m = text.match(/Min(\\d+)/i);
  if (m) return Number(m[1]);
  if (/^Hour4$/i.test(text)) return 240;
  if (/^Day1$/i.test(text)) return 1440;
  return 5;
}

async function getCandles(symbol=SYMBOL, interval=INTERVAL) {
  const key = `${symbol}:${interval}`;
  const ttl = CANDLE_CACHE_TTL_MS[interval] || 60 * 1000;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.time < ttl) return cached.data;

  const mins = Math.max(1, intervalMinutes(interval));
  const end = Date.now();
  const bars = 500;
  const start = end - (bars + 10) * mins * 60 * 1000;
  const data = await mexc("GET", "/api/v1/contract/kline/" + symbol, {
    interval,
    start: Math.floor(start/1000),
    end: Math.floor(end/1000)
  });
  const candles = normalizeCandles(data).sort((a,b)=>a.time-b.time);
  candleCache.set(key, {time:Date.now(), data:candles});
  return candles;
}

function sma(values, period) {
  if (values.length < period) return null;
  let sum=0;
  for (let i=values.length-period;i<values.length;i++) sum += values[i];
  return sum/period;
}

function macd(values, fastPeriod=12, slowPeriod=26, signalPeriod=9) {
  const ef=emaSeries(values, fastPeriod), es=emaSeries(values, slowPeriod);
  const line=values.map((_,i)=>ef[i] !== null && es[i] !== null ? ef[i]-es[i] : null);
  const valid=line.filter(x=>x!==null);
  if (valid.length < signalPeriod) return {line:null, signal:null, histogram:null};
  const sigSeries=emaSeries(valid, signalPeriod);
  const ml=line[line.length-1];
  const sl=sigSeries[sigSeries.length-1];
  return {line:ml, signal:sl, histogram:ml-sl};
}

function adx(candles, period=14) {
  if (candles.length < period*2+2) return null;
  const trs=[], plus=[], minus=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i], p=candles[i-1];
    const up=c.high-p.high, down=p.low-c.low;
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
    plus.push(up>down && up>0 ? up : 0);
    minus.push(down>up && down>0 ? down : 0);
  }
  let tr=trs.slice(0,period).reduce((a,b)=>a+b,0);
  let pd=plus.slice(0,period).reduce((a,b)=>a+b,0);
  let md=minus.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=period;i<trs.length;i++){
    tr=tr-tr/period+trs[i]; pd=pd-pd/period+plus[i]; md=md-md/period+minus[i];
    const pdi=tr ? 100*pd/tr : 0, mdi=tr ? 100*md/tr : 0;
    dx.push((pdi+mdi) ? 100*Math.abs(pdi-mdi)/(pdi+mdi) : 0);
  }
  if(dx.length<period) return null;
  let a=dx.slice(0,period).reduce((x,y)=>x+y,0)/period;
  for(let i=period;i<dx.length;i++) a=(a*(period-1)+dx[i])/period;
  return a;
}

function averageVolume(candles, period=20) {
  const vols=candles.map(c=>num(c.volume)||0);
  return sma(vols, Math.min(period, vols.length));
}

function recentSupportResistance(candles, lookback=SR_LOOKBACK) {
  const n=Math.min(lookback, candles.length);
  const slice=candles.slice(-n);
  return {support:Math.min(...slice.map(c=>c.low)), resistance:Math.max(...slice.map(c=>c.high))};
}

function basicDivergence(candles, period=40) {
  const slice=candles.slice(-Math.min(period,candles.length));
  if(slice.length<20) return {bullish:false,bearish:false};
  const closes=slice.map(c=>c.close);
  const rsis=[];
  for(let i=14;i<closes.length;i++) rsis.push(rsi(closes.slice(0,i+1),14));
  if(rsis.length<8) return {bullish:false,bearish:false};
  const half=Math.floor(slice.length/2);
  const oldPriceLow=Math.min(...closes.slice(0,half));
  const newPriceLow=Math.min(...closes.slice(half));
  const oldPriceHigh=Math.max(...closes.slice(0,half));
  const newPriceHigh=Math.max(...closes.slice(half));
  const oldRsi=sma(rsis.slice(0,Math.floor(rsis.length/2)), Math.max(1,Math.floor(rsis.length/2)));
  const newRsi=sma(rsis.slice(Math.floor(rsis.length/2)), Math.max(1,rsis.length-Math.floor(rsis.length/2)));
  return {
    bullish:newPriceLow < oldPriceLow && newRsi > oldRsi + 2,
    bearish:newPriceHigh > oldPriceHigh && newRsi < oldRsi - 2
  };
}


function slopePct(series, lookback=5) {
  if (!Array.isArray(series) || series.length < lookback + 1) return null;
  const a = num(series[series.length - 1]);
  const b = num(series[series.length - 1 - lookback]);
  if (!(a > 0 && b > 0)) return null;
  return (a - b) / b;
}

function candleQuality(c) {
  if (!c) return {bodyPct:0, upperWickPct:0, lowerWickPct:0, bullish:false, bearish:false};
  const range=Math.max(1e-12, c.high-c.low);
  const body=Math.abs(c.close-c.open);
  const upper=c.high-Math.max(c.open,c.close);
  const lower=Math.min(c.open,c.close)-c.low;
  return {
    bodyPct:body/range,
    upperWickPct:upper/range,
    lowerWickPct:lower/range,
    bullish:c.close>c.open,
    bearish:c.close<c.open
  };
}

function trendStrength(direction, adxValue, slope21, slope50) {
  if (direction==="LONG") {
    return (adxValue ?? 0) + Math.max(0,(slope21 ?? 0))*100 + Math.max(0,(slope50 ?? 0))*50;
  }
  if (direction==="SHORT") {
    return (adxValue ?? 0) + Math.max(0,-(slope21 ?? 0))*100 + Math.max(0,-(slope50 ?? 0))*50;
  }
  return 0;
}

function detectPullbackRetest(candles, ema21, ema50, atr14, direction) {
  const closed = Array.isArray(candles) ? candles : [];
  if (!Array.isArray(closed) || closed.length < 8 || !direction || direction === "NEUTRAL") {
    return {confirmed:false, type:null, level:null, pullbackLow:null, pullbackHigh:null, barsSinceTouch:null};
  }
  const current = closed[closed.length - 1];
  const prior = closed.slice(Math.max(0, closed.length - PULLBACK_LOOKBACK - 1), closed.length - 1);
  if (!current || prior.length < 4) return {confirmed:false, type:null, level:null, pullbackLow:null, pullbackHigh:null, barsSinceTouch:null};
  const atr = num(atr14) || 0;
  const touchTol = PULLBACK_TOUCH_TOLERANCE_PCT;
  const reclaim = PULLBACK_RECLAIM_BUFFER_PCT;
  const q = candleQuality(current);

  if (direction === "LONG") {
    const levels = [num(ema21), num(ema50)].filter(x => x > 0);
    let touchIdx = -1, pullbackLow = null, touchLevel = null;
    for (let i = prior.length - 1; i >= 0; i--) {
      const c = prior[i];
      const hit = levels.some(level => Number(c.low) <= level * (1 + touchTol) && Number(c.high) >= level * (1 - touchTol));
      if (hit) { touchIdx = i; pullbackLow = Number(c.low); touchLevel = levels.find(level => Number(c.low) <= level * (1 + touchTol) && Number(c.high) >= level * (1 - touchTol)) || null; break; }
    }
    // A recent EMA pullback/touch is enough to qualify the 15m setup.
    // The directional confirmation is handled separately by the 5m trigger.
    const emaPullback = touchIdx >= 0;

    // Breakout -> pullback -> retest of the broken local high -> bullish reclaim.
    const base = prior.slice(Math.max(0, prior.length - 8), Math.max(1, prior.length - 3));
    const localHigh = base.length ? Math.max(...base.map(c => Number(c.high))) : null;
    let breakoutIdx = -1;
    if (localHigh) {
      for (let i = 0; i < prior.length; i++) {
        if (Number(prior[i].close) > localHigh * (1 + reclaim)) { breakoutIdx = i; break; }
      }
    }
    let retest = false, retestLow = null, retestIdx = -1;
    if (breakoutIdx >= 0 && localHigh) {
      for (let i = breakoutIdx + 1; i < prior.length; i++) {
        if (Number(prior[i].low) <= localHigh * (1 + touchTol) && Number(prior[i].low) >= localHigh * (1 - Math.max(0.02, touchTol * 5))) {
          retest = true; retestLow = Number(prior[i].low); retestIdx = i; break;
        }
      }
    }
    // A broken-level retest is also sufficient; 5m confirmation decides entry timing.
    const breakoutRetest = retest && localHigh;
    if (emaPullback || breakoutRetest) {
      const finalLow = Math.min(...[pullbackLow, retestLow].filter(x => Number.isFinite(x)));
      const impulseHigh = breakoutRetest && Number.isFinite(localHigh)
        ? Number(localHigh)
        : (touchIdx >= 0 ? Math.max(...prior.slice(0, touchIdx + 1).map(c => Number(c.high))) : Number(current.high));
      const pullbackDepthAtr = atr > 0 && Number.isFinite(finalLow) && Number.isFinite(impulseHigh)
        ? Math.max(0, (impulseHigh - finalLow) / atr) : 0;
      return {confirmed:true, type:breakoutRetest ? "BREAKOUT_RETEST" : "EMA_PULLBACK", level:breakoutRetest ? localHigh : touchLevel,
        pullbackLow:finalLow, pullbackHigh:Number(current.high), pullbackDepthAtr,
        barsSinceTouch:touchIdx>=0 ? prior.length-1-touchIdx : (retest ? prior.length-1-retestIdx : null), atr14:atr};
    }
  }

  if (direction === "SHORT") {
    const levels = [num(ema21), num(ema50)].filter(x => x > 0);
    let touchIdx = -1, pullbackHigh = null, touchLevel = null;
    for (let i = prior.length - 1; i >= 0; i--) {
      const c = prior[i];
      const hit = levels.some(level => Number(c.high) >= level * (1 - touchTol) && Number(c.low) <= level * (1 + touchTol));
      if (hit) { touchIdx = i; pullbackHigh = Number(c.high); touchLevel = levels.find(level => Number(c.high) >= level * (1 - touchTol) && Number(c.low) <= level * (1 + touchTol)) || null; break; }
    }
    // A recent EMA pullback/touch is enough to qualify the 15m setup.
    // The directional confirmation is handled separately by the 5m trigger.
    const emaPullback = touchIdx >= 0;

    const base = prior.slice(Math.max(0, prior.length - 8), Math.max(1, prior.length - 3));
    const localLow = base.length ? Math.min(...base.map(c => Number(c.low))) : null;
    let breakdownIdx = -1;
    if (localLow) {
      for (let i = 0; i < prior.length; i++) {
        if (Number(prior[i].close) < localLow * (1 - reclaim)) { breakdownIdx = i; break; }
      }
    }
    let retest = false, retestHigh = null, retestIdx = -1;
    if (breakdownIdx >= 0 && localLow) {
      for (let i = breakdownIdx + 1; i < prior.length; i++) {
        if (Number(prior[i].high) >= localLow * (1 - touchTol) && Number(prior[i].high) <= localLow * (1 + Math.max(0.02, touchTol * 5))) {
          retest = true; retestHigh = Number(prior[i].high); retestIdx = i; break;
        }
      }
    }
    // A broken-level retest is also sufficient; 5m confirmation decides entry timing.
    const breakdownRetest = retest && localLow;
    if (emaPullback || breakdownRetest) {
      const finalHigh = Math.max(...[pullbackHigh, retestHigh].filter(x => Number.isFinite(x)));
      const impulseLow = breakdownRetest && Number.isFinite(localLow)
        ? Number(localLow)
        : (touchIdx >= 0 ? Math.min(...prior.slice(0, touchIdx + 1).map(c => Number(c.low))) : Number(current.low));
      const pullbackDepthAtr = atr > 0 && Number.isFinite(finalHigh) && Number.isFinite(impulseLow)
        ? Math.max(0, (finalHigh - impulseLow) / atr) : 0;
      return {confirmed:true, type:breakdownRetest ? "BREAKDOWN_RETEST" : "EMA_PULLBACK", level:breakdownRetest ? localLow : touchLevel,
        pullbackLow:Number(current.low), pullbackHigh:finalHigh, pullbackDepthAtr,
        barsSinceTouch:touchIdx>=0 ? prior.length-1-touchIdx : (retest ? prior.length-1-retestIdx : null), atr14:atr};
    }
  }
  return {confirmed:false, type:null, level:null, pullbackLow:null, pullbackHigh:null, barsSinceTouch:null, atr14:atr};
}

function timeframeAnalysis(candles) {
  const closed=candles.slice(0,-1);
  const closes=closed.map(c=>c.close);
  const i=closes.length-1;
  const e9=emaSeries(closes,9), e21=emaSeries(closes,21), e50=emaSeries(closes,50), e200=emaSeries(closes,200);
  const r=rsi(closes,14), a=atr(closed,14), m=macd(closes), ad=adx(closed,14);
  const av=averageVolume(closed,20), cv=num(closed[i]?.volume)||0;
  const sr=recentSupportResistance(closed.slice(0,-1));
  const div=basicDivergence(closed);
  const price=closes[i];
  const last=closed[i];
  const prev=closed[i-1];
  const q=candleQuality(last);
  const slope9=slopePct(e9,5), slope21=slopePct(e21,5), slope50=slopePct(e50,5);
  const atrPct=(a && price>0)?a/price:null;
  const lastRange = last ? Math.max(0, Number(last.high)-Number(last.low)) : 0;
  const rangeAtrRatio = a && lastRange>0 ? lastRange/a : 0;

  let direction="NEUTRAL";
  if(e9[i] && e21[i] && e50[i] && e200[i]) {
    // Balanced trend definition: keep the core EMA structure, but do not
    // require perfect 4-EMA alignment. This avoids turning many valid
    // pullbacks into WAIT merely because price briefly crossed EMA200.
    if(e9[i]>e21[i] && e21[i]>e50[i] && price>e200[i] && (slope21===null || slope21>=-0.003)) direction="LONG";
    else if(e9[i]<e21[i] && e21[i]<e50[i] && price<e200[i] && (slope21===null || slope21<=0.003)) direction="SHORT";
  }

  const pullbackRetest = detectPullbackRetest(closed, e21[i], e50[i], a, direction);
  const srRange=Math.max(1e-12,sr.resistance-sr.support);
  const srPos=(price-sr.support)/srRange;
  const distE21=a ? Math.abs(price-e21[i])/a : null;
  const distE50=a ? Math.abs(price-e50[i])/a : null;
  const momentumSlope = slopePct(closes,5);

  // "Pullback / breakout" context: favor entries that are near the trend's
  // fast/medium averages or are breaking a recent local level with a strong candle.
  const nearE21 = distE21!==null && distE21<=1.25;
  const nearE50 = distE50!==null && distE50<=1.75;
  const breakoutLong = price>sr.resistance && q.bullish && q.bodyPct>=0.45;
  const breakoutShort = price<sr.support && q.bearish && q.bodyPct>=0.45;

  return {
    price,ema9:e9[i],ema21:e21[i],ema50:e50[i],ema200:e200[i],
    rsi14:r,atr14:a,atrPct,macd:m,adx14:ad,avgVolume20:av,currentVolume:cv,
    volumeRatio:av?cv/av:null,support:sr.support,resistance:sr.resistance,
    rangeAtrRatio,divergence:div,direction,candleTime:closed[i]?.time,
    slope9,slope21,slope50,momentumSlope,candle:q,
    srPos,distE21,distE50,nearE21,nearE50,breakoutLong,breakoutShort,
    pullbackRetest,
    trendStrength:trendStrength(direction,ad,slope21,slope50)
  };
}

function pullbackReclaimPass(analysis, direction, maxBars, minDepthAtr) {
  if (!analysis || !["LONG","SHORT"].includes(direction)) return false;
  const p = analysis.pullbackRetest;
  if (!p?.confirmed) return false;
  if (p.barsSinceTouch === null || Number(p.barsSinceTouch) > maxBars) return false;
  if (Number(p.pullbackDepthAtr || 0) < minDepthAtr) return false;
  const level = num(p.level);
  const price = num(analysis.price);
  if (!(level > 0 && price > 0)) return false;
  const buffer = Math.max(PULLBACK_RECLAIM_BUFFER_PCT, ENTRY_PULLBACK_RECLAIM_BUFFER_PCT);
  const candle = analysis.candle;
  if (direction === "LONG") {
    return Boolean(candle?.bullish) && price > level * (1 + buffer);
  }
  return Boolean(candle?.bearish) && price < level * (1 - buffer);
}


function timeframeBias(candles) {
  if (!Array.isArray(candles) || candles.length < 60) return {bias:"NEUTRAL", price:null, ema9:null, ema21:null, ema50:null};
  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  const e9 = emaSeries(closes, 9);
  const e21 = emaSeries(closes, 21);
  const e50 = emaSeries(closes, 50);
  const price = closes[closes.length - 1];
  const a = e9[e9.length-1], b = e21[e21.length-1], c = e50[e50.length-1];
  if (![price,a,b,c].every(Number.isFinite)) return {bias:"NEUTRAL", price, ema9:a, ema21:b, ema50:c};
  if (price > b && a > b && b > c) return {bias:"LONG", price, ema9:a, ema21:b, ema50:c};
  if (price < b && a < b && b < c) return {bias:"SHORT", price, ema9:a, ema21:b, ema50:c};
  return {bias:"NEUTRAL", price, ema9:a, ema21:b, ema50:c};
}

async function getAdvancedSignal(symbol=SYMBOL) {
  await refreshActiveSymbols();
  await ensureTradableSymbol(symbol);

  const cached = advancedSignalCache.get(symbol);
  if (cached && Date.now() - cached.time < ADVANCED_SIGNAL_CACHE_TTL_MS) return cached.data;

  // ENTRY ENGINE v34.4.14: only a confirmed CLOSED 5m pullback/reclaim or
  // closed breakout-retest can trigger an entry. Continuation/no-pullback
  // entries are blocked. 15m pullback, momentum, anti-chase and S/R room
  // protections are applied before an order can reach preflight.
  const c5 = await getCandles(symbol, "Min5");
  const breakout = breakoutOpportunityFromCandles(c5);
  const b = (breakout && breakout.signal !== "WAIT") ? breakout : fallbackMomentumOpportunity(c5);
  if (!b) {
    const result = {signal:"WAIT", reason:"No qualified closed 5m setup (breakout or momentum fallback)", symbol, interval:"Min5", score:0};
    advancedSignalCache.set(symbol,{time:Date.now(),data:result});
    return result;
  }

  const signal = b.signal;
  const price = b.price;
  const tpPct = TAKE_PROFIT_PCT;
  const protectionPlan = signal !== "WAIT" && price > 0
    ? protectionPricesFor(signal, price, null, b.atr, b)
    : null;
  const stopPct = Number(protectionPlan?.stopPct || 0);
  const riskReward = stopPct > 0 ? tpPct / stopPct : 0;
  const volatilitySpike = Number(b.bodyAtr || 0) >= VOLATILITY_SPIKE_ATR_MULTIPLIER;
  const lateEntryRisk = signal !== "WAIT" && Number(b.extensionAtr || 0) > BREAKOUT_MAX_EXTENSION_ATR;
  const stopDistanceOk = Boolean(protectionPlan?.valid && protectionPlan.stopPct > 0 && protectionPlan.stopPct <= MAX_STRUCTURE_STOP_PCT * 1.02);

  let htf15 = null, htf60 = null, dailyBias = null, htf15Analysis = null, htfAlignmentPass = true, setupPullbackPass = true;
  if (signal !== "WAIT") {
    const [c15, c60, c1d] = await Promise.all([getCandles(symbol, "Min15"), getCandles(symbol, "Min60"), getCandles(symbol, "Day1")]);
    htf15 = timeframeBias(c15);
    htf60 = timeframeBias(c60);
    dailyBias = timeframeBias(c1d);
    htf15Analysis = timeframeAnalysis(c15);
    const p15 = htf15Analysis?.pullbackRetest;
    const pullbackFresh = p15?.confirmed &&
      (p15.barsSinceTouch === null || Number(p15.barsSinceTouch) <= ENTRY_SETUP_PULLBACK_MAX_BARS) &&
      Number(p15.pullbackDepthAtr || 0) >= ENTRY_MIN_PULLBACK_DEPTH_ATR;
    setupPullbackPass = htf15Analysis?.direction === signal && pullbackFresh;
    // 15m is a confirmation, not a mandatory exact match. A neutral 15m is
    // allowed when 1h is not opposing the signal. This keeps the 1D context
    // while avoiding unnecessary WAIT states during normal pullbacks.
    htfAlignmentPass = htf15.bias !== (signal === "LONG" ? "SHORT" : "LONG") &&
      htf60.bias !== (signal === "LONG" ? "SHORT" : "LONG");
    // 1D is included as higher-timeframe context. It is intentionally not a
    // hard blocker by default so a neutral/opposite daily candle cannot freeze
    // the bot. Same-direction daily trend is surfaced as a confirmation flag.
    const dailyAlignmentPass = dailyBias?.bias === signal;
    const dailyContext = dailyBias?.bias === "NEUTRAL" ? "NEUTRAL" :
      (dailyAlignmentPass ? "ALIGNED" : "OPPOSITE");
    // Keep these on the result for mobile diagnostics.
    htf15Analysis.dailyAlignmentPass = dailyAlignmentPass;
    htf15Analysis.dailyContext = dailyContext;
  }

  let finalSignal = signal;
  let reason = b.reason;
  const requiredScore = b.fallbackMomentum ? Math.max(65, MIN_SIGNAL_SCORE - 5) : BREAKOUT_MIN_SCORE;
  if (finalSignal !== "WAIT" && b.score < requiredScore) {
    finalSignal = "WAIT";
    reason = `${b.fallbackMomentum ? "Momentum" : "Breakout"} score ${b.score}/100 below minimum ${requiredScore}`;
  }
  if (finalSignal !== "WAIT" && volatilitySpike) {
    finalSignal = "WAIT";
    reason = `Breakout candle volatility too high (${Number(b.bodyAtr).toFixed(2)} ATR)`;
  }
  if (finalSignal !== "WAIT" && !stopDistanceOk) {
    finalSignal = "WAIT";
    reason = protectionPlan?.reason || "Invalid breakout protection plan";
  }
  if (finalSignal !== "WAIT" && !htfAlignmentPass) {
    finalSignal = "WAIT";
    reason = `Higher-timeframe conflict: 15m=${htf15?.bias || "NA"}, 1h=${htf60?.bias || "NA"}, signal=${signal}`;
  }
  if (finalSignal !== "WAIT" && dailyBias?.bias && dailyBias.bias !== "NEUTRAL" && dailyBias.bias !== signal) {
    finalSignal = "WAIT";
    reason = `1D trend conflict: daily=${dailyBias.bias}, signal=${signal}`;
  }
  // Smart pullback profile: accept either a confirmed 5m breakout-retest
  // reclaim OR a fresh 15m pullback setup. This preserves anti-top-entry
  // protection without requiring both timeframes to touch the same level.
  // v34.4.14: BOTH setup pullback and the 5m trigger pullback are required.
  // A score/HTF trend alone must never create an order.
  const smartPullbackPass = Boolean(setupPullbackPass) &&
    (Boolean(b.retestConfirmed) || Boolean(b.pullbackTriggerPass));
  if (finalSignal !== "WAIT" && REQUIRE_PULLBACK_ENTRY && !smartPullbackPass) {
    finalSignal = "WAIT";
    reason = `Pullback confirmation missing for ${signal}; entry blocked to avoid top/chasing entry`;
  }
  if (finalSignal !== "WAIT" && Number(b.score || 0) < MIN_SIGNAL_SCORE) {
    finalSignal = "WAIT";
    reason = `Signal score too low (${Number(b.score || 0).toFixed(1)} < ${MIN_SIGNAL_SCORE})`;
  }
  if (finalSignal !== "WAIT" && Number(b.precisionScore ?? b.score ?? 0) < MIN_PRECISION_SCORE) {
    finalSignal = "WAIT";
    reason = `Precision score too low (${Number(b.precisionScore ?? b.score ?? 0).toFixed(1)} < ${MIN_PRECISION_SCORE})`;
  }
  if (finalSignal !== "WAIT" && REQUIRE_15M_ALIGNMENT && htf15?.bias !== signal) {
    finalSignal = "WAIT";
    reason = `15m alignment required: 15m=${htf15?.bias || "NA"}, signal=${signal}`;
  }
  if (finalSignal !== "WAIT" && REQUIRE_1H_ALIGNMENT && htf60?.bias !== signal) {
    finalSignal = "WAIT";
    reason = `1h alignment required: 1h=${htf60?.bias || "NA"}, signal=${signal}`;
  }
  if (finalSignal !== "WAIT" && REQUIRE_DAILY_ALIGNMENT && dailyBias?.bias !== signal) {
    finalSignal = "WAIT";
    reason = `Daily alignment required: 1D=${dailyBias?.bias || "NA"}, signal=${signal}`;
  }
  if (finalSignal !== "WAIT" && riskReward < MIN_RISK_REWARD) {
    finalSignal = "WAIT";
    reason = `Risk/reward too low (${riskReward.toFixed(2)} < ${MIN_RISK_REWARD})`;
  }

  const safePrecisionScore = Number.isFinite(Number(b.precisionScore))
    ? Math.max(0, Math.min(100, Number(b.precisionScore)))
    : Math.max(0, Math.min(100, Number(b.score) || 0));

  const result = {
    signal: finalSignal,
    reason,
    symbol,
    interval:"Min5",
    price,
    score:b.score,
    precisionScore:safePrecisionScore,
    directionScores:{LONG:signal === "LONG" ? b.score : 0, SHORT:signal === "SHORT" ? b.score : 0},
    candleTime:b.candleTime,
    atr14:b.atr,
    ema9:null,
    ema21:null,
    rsi14:null,
    reasons:[b.reason],
    breakout:{
      lookback:BREAKOUT_LOOKBACK,
      bufferPct:BREAKOUT_BUFFER_PCT,
      level:b.breakoutLevel,
      resistance:b.resistance,
      support:b.support,
      swingLow:b.swingLow,
      swingHigh:b.swingHigh,
      distancePct:b.breakoutDistancePct,
      extensionAtr:b.extensionAtr,
      bodyAtr:b.bodyAtr,
      bodyPct:b.bodyPct,
      closeLocation:b.closeLocation,
      volumeRatio:b.volumeRatio,
      rawVolumeRatio:b.rawVolumeRatio ?? b.volumeRatio,
      volumeMultiplier:b.early ? EARLY_BREAKOUT_VOLUME_MULTIPLIER : BREAKOUT_VOLUME_MULTIPLIER,
      earlyBreakout:b.early === true,
      confirmed:b.confirmed,
      volumePass:b.volumePass,
      bodyPass:b.bodyPass,
      extensionPass:b.directionSpecificPass,
      triggerCandleTime:b.candleTime,
      earlyBreakout:b.early === true
    },
    timeframes:{
      Min5:{price,atr14:b.atr,candleTime:b.candleTime,volumeRatio:b.volumeRatio,candle:{bodyPct:b.bodyPct,bullish:signal==="LONG",bearish:signal==="SHORT"}},
      Min15:htf15,
      Min60:htf60,
      Day1:dailyBias
    },
    quality:{
      breakoutOnly:false,
      breakoutConfirmed:Boolean(b.confirmed && !b.fallbackMomentum),
      breakoutVolumePass:b.volumePass,
      breakoutBodyPass:b.bodyPass,
      breakoutExtensionPass:b.directionSpecificPass,
      triggerCandleQuality:b.bodyPass,
      strictTriggerPass:b.confirmed,
      strictEntryDistanceOk:true,
      setupNotExhausted:true,
      noPullbackRequired:true,
      requirePullbackEntry:REQUIRE_PULLBACK_ENTRY,
      pullbackEntryPass:Boolean(b.pullbackEntryPass),
      setupPullbackPass,
      smartPullbackPass,
      triggerPullbackPass:Boolean(b.retestConfirmed || b.pullbackTriggerPass),
      pullbackDepthAtr:Number(b.pullbackDepthAtr || htf15Analysis?.pullbackRetest?.pullbackDepthAtr || 0),
      pullbackBarsAgo:Number.isFinite(Number(b.pullbackBarsAgo)) ? Number(b.pullbackBarsAgo) : null,
      resistanceRoomAtr:Number.isFinite(Number(b.resistanceRoomAtr)) ? Number(b.resistanceRoomAtr) : null,
      momentumVolumeRatio:Number(b.volumeRatio || 0),
      momentumBodyAtr:Number(b.bodyAtr || 0),
      resistanceRoomMinAtr:ENTRY_SR_MIN_ROOM_ATR,
      lateEntryRisk,
      volatilitySpike,
      higherTimeframeAlignmentPass:htfAlignmentPass,
      dailyTrend:dailyBias?.bias || "NEUTRAL",
      dailyAlignmentPass:dailyBias?.bias === signal,
      breakoutEntryMode:b.entryMode || (b.retestConfirmed ? "BREAKOUT_RETEST" : "BREAKOUT_CONTINUATION"),
      riskReward:Number(riskReward.toFixed(3)),
      minRiskReward:MIN_RISK_REWARD,
      precisionScore:safePrecisionScore,
      counterWickPct:b.counterWickPct ?? 0,
      stopDistanceOk,
      protectionPlan,
      tpTargetPct:tpPct,
      tpReachableForTarget:true,
      entryTriggerMaxBars:0,
      entryTriggerMaxDistanceAtr:b.early ? EARLY_BREAKOUT_MAX_EXTENSION_ATR : BREAKOUT_MAX_EXTENSION_ATR,
      entryTriggerMinBodyPct:BREAKOUT_MIN_BODY_RATIO,
      breakoutLevel:b.breakoutLevel,
      breakoutDistancePct:b.breakoutDistancePct,
      breakoutExtensionAtr:b.extensionAtr,
      breakoutVolumeRatio:b.volumeRatio,
      breakoutBodyAtr:b.bodyAtr
    },
    higherTimeframe:{alignmentPass:htfAlignmentPass,Min15:htf15,Min15Analysis:htf15Analysis,Min60:htf60,Day1:dailyBias,setupPullbackPass},
    newsRisk:{enabled:false,riskScore:0,marketBlocked:false,coinCritical:false,matchedHeadlines:[]}
  };

  advancedSignalCache.set(symbol,{time:Date.now(),data:result});
  return result;
}

async function getSignal(symbol=SYMBOL, interval=INTERVAL) {
  // Keep the public API compatible while upgrading the actual decision engine.
  return getAdvancedSignal(symbol);
}

async function getContract(symbol=SYMBOL) {
  const d = await mexc("GET", "/api/v1/contract/detail", { symbol });
  const arr = Array.isArray(d?.data) ? d.data : [];
  return arr[0] || d?.data || {};
}

async function getTicker(symbol=SYMBOL) {
  const d = await mexc("GET", "/api/v1/contract/ticker", { symbol });
  return d?.data || d || {};
}

async function getAccount() {
  return mexc("GET", "/api/v1/private/account/assets", {}, true);
}

async function getPositions(symbol=null) {
  const params = symbol ? {symbol} : {};
  const d = await mexc("GET", "/api/v1/private/position/open_positions", params, true);
  return Array.isArray(d?.data) ? d.data : [];
}

async function getCurrentOrders(symbol=SYMBOL) {
  const d = await mexc("GET", "/api/v1/private/order/list/open_orders/" + symbol, {}, true);
  return Array.isArray(d?.data) ? d.data : [];
}

async function getPlanOrders(symbol=SYMBOL) {
  const d = await mexc("GET", "/api/v1/private/planorder/list/orders", { symbol }, true);
  return Array.isArray(d?.data) ? d.data : [];
}

async function getLeverage(symbol=SYMBOL) {
  const d = await mexc("GET", "/api/v1/private/position/leverage", { symbol }, true);
  return d?.data || d;
}

async function getPositionMode() {
  const d = await mexc("GET", "/api/v1/private/position/position_mode", {}, true);
  return d?.data ?? d;
}


function collectObjects(value, out=[]) {
  if (value && typeof value === "object") {
    out.push(value);
    if (Array.isArray(value)) value.forEach(v => collectObjects(v,out));
    else Object.values(value).forEach(v => collectObjects(v,out));
  }
  return out;
}

function hasNumericField(value, field, expected) {
  return collectObjects(value).some(o => o[field] !== undefined && Number(o[field]) === Number(expected));
}

function getUsdtAsset(accountData) {
  const data = accountData?.data;
  if (Array.isArray(data)) {
    return data.find(x => String(x?.currency || x?.asset || "").toUpperCase() === "USDT") || null;
  }
  if (data && typeof data === "object" && String(data.currency || data.asset || "").toUpperCase() === "USDT") return data;
  return null;
}

function availableBalance(accountData) {
  const usdt = getUsdtAsset(accountData);
  // MEXC's newer Futures asset payload can expose availableOpen/availableCash.
  // availableOpen is the amount explicitly usable for opening a new position;
  // prefer it over wallet/equity fields and fall back to availableBalance.
  return num(usdt?.availableOpen ?? usdt?.availableBalance ?? usdt?.available ?? usdt?.available_amount) || 0;
}

function balanceDiagnostics(accountData) {
  const usdt = getUsdtAsset(accountData) || {};
  return {
    currency: String(usdt.currency || usdt.asset || "USDT"),
    availableOpen: num(usdt.availableOpen),
    availableBalance: num(usdt.availableBalance),
    availableCash: num(usdt.availableCash),
    cashBalance: num(usdt.cashBalance),
    frozenBalance: num(usdt.frozenBalance),
    positionMargin: num(usdt.positionMargin),
    orderMargin: num(usdt.orderMargin),
    equity: num(usdt.equity),
    unrealized: num(usdt.unrealized),
    selectedSource: usdt.availableOpen !== undefined && num(usdt.availableOpen) !== null ? "availableOpen" : "availableBalance"
  };
}

function accountEquity(accountData) {
  const arr = Array.isArray(accountData?.data) ? accountData.data : [];
  const usdt = arr.find(x => String(x.currency || x.asset || "").toUpperCase() === "USDT");
  return num(usdt?.equity ?? usdt?.walletBalance ?? usdt?.balance ?? usdt?.availableBalance ?? usdt?.available) || 0;
}

function contractVolume(contract) {
  return Math.max(1, Math.floor(MAX_ORDER_USDT * TARGET_LEVERAGE / Math.max(0.0000001, num(contract?.contractSize) || 0.1) / 1000000));
}

function calcVolume(contract, price, leverage=TARGET_LEVERAGE, orderUsdt=MAX_ORDER_USDT) {
  const size = num(contract?.contractSize) || 0.1;
  const minVol = Math.max(1e-12, num(contract?.minVol) || 1);
  const step = Math.max(1e-12, num(contract?.volUnit) || minVol);
  const maxVol = num(contract?.maxVol) || Infinity;
  if (!(price > 0) || !(size > 0)) return 0;
  // Quantity is in contracts. Round UP to the exchange quantity step so the
  // requested USDT size is not accidentally rounded below the minimum.
  const requestedUsdt = Math.max(0, Number(orderUsdt) || 0);
  const raw = (requestedUsdt * Math.max(1, leverage)) / (price * size);
  const stepped = Math.ceil(Math.max(minVol, raw) / step - 1e-12) * step;
  const capped = Math.min(stepped, maxVol);
  return Number(capped.toFixed(Math.max(0, Number(contract?.volScale) || 0)));
}

function priceDecimalsFromTick(tick) {
  const t = Number(tick);
  if (!(t > 0)) return 2;
  const s = t.toFixed(12).replace(/0+$/, "");
  const dot = s.indexOf(".");
  return dot >= 0 ? s.length - dot - 1 : 0;
}

function roundPrice(price, contract) {
  const tick = num(contract?.priceUnit) || 0.01;
  const decimals = priceDecimalsFromTick(tick);
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  // Round on the contract tick, then convert through fixed decimal text.
  // This prevents IEEE-754 artifacts such as 0.18960000000000002 from being
  // sent to MEXC, which rejects those values with error 2015 (price/quantity
  // precision error).
  const steps = Math.round((n / tick) + Number.EPSILON);
  const rounded = steps * tick;
  return Number(rounded.toFixed(decimals));
}


async function ensureTradableSymbol(symbol) {
  symbol = String(symbol || "").trim().toUpperCase();
  if (!symbol.endsWith("_USDT")) throw new Error("Symbol not allowed");
  if (ALLOWED_SYMBOLS.includes(symbol)) return true;
  const d = await mexc("GET", "/api/v1/contract/detail", { symbol });
  const c = Array.isArray(d?.data) ? d.data[0] : d?.data;
  const active = c && String(c.symbol || "").toUpperCase() === symbol &&
    (c.state === undefined || c.state === null || c.state === "" || Number(c.state) === 0);
  if (!active) throw new Error("Symbol not allowed");
  ALLOWED_SYMBOLS = Array.from(new Set([symbol, ...ALLOWED_SYMBOLS]));
  return true;
}

async function preflight(symbol=SYMBOL) {
  symbol = String(symbol || SYMBOL).toUpperCase();
  // Refresh the dynamic universe before direct preflight checks. This prevents
  // a valid active MEXC symbol from being rejected by a stale 500-symbol list.
  await refreshActiveSymbols(true);
  await ensureTradableSymbol(symbol);
  const signal = await getSignal(symbol);
  const [positions, orders, plans, account, leverage, mode, contract] =
    await Promise.all([
      getPositions(symbol),
      getCurrentOrders(symbol),
      getPlanOrders(symbol),
      getAccount(),
      getLeverage(symbol),
      getPositionMode(),
      getContract(symbol)
    ]);

  const balance = availableBalance(account);
  const balanceInfo = balanceDiagnostics(account);
  const price = signal.price || 0;
  const minLev = Math.max(1, num(contract?.minLeverage) || 1);
  const maxLev = Math.max(minLev, num(contract?.maxLeverage) || TARGET_LEVERAGE);
  const effectiveLeverage = Math.max(minLev, Math.min(TARGET_LEVERAGE, maxLev));
  const size = num(contract?.contractSize) || 0.1;
  const availableForOrder = Math.max(0, balance - ORDER_BALANCE_RESERVE_USDT);
  const requestedOrderUsdt = ADAPTIVE_ORDER_SIZE
    ? Math.min(MAX_ORDER_USDT, availableForOrder)
    : MAX_ORDER_USDT;
  let volume = price ? calcVolume(contract, price, effectiveLeverage, requestedOrderUsdt) : 0;
  // Adaptive sizing must never round UP beyond the available margin.
  // MEXC quantity steps can otherwise turn 4.79 USDT into a 5.00+ USDT
  // margin request and make the preflight fail even though adaptive sizing is on.
  if (ADAPTIVE_ORDER_SIZE && price && volume > 0) {
    const step = Math.max(1e-12, num(contract?.volUnit) || num(contract?.minVol) || 1);
    const minVol = Math.max(1e-12, num(contract?.minVol) || 1);
    const maxAdjust = 10000;
    let guard = 0;
    while (volume >= minVol && guard++ < maxAdjust) {
      const testNotional = price * size * volume;
      const testMargin = effectiveLeverage > 0 ? testNotional / effectiveLeverage : testNotional;
      if (testMargin <= availableForOrder + 1e-9) break;
      const next = volume - step;
      if (next < minVol - 1e-12) { volume = 0; break; }
      volume = Number(next.toFixed(Math.max(0, Number(contract?.volScale) || 0)));
    }
  }
  const notional = price * size * volume;
  const margin = effectiveLeverage > 0 ? notional / effectiveLeverage : notional;

  const supportedOpenType = Number(contract?.positionOpenType);
  const configuredOpenType = CONFIGURED_OPEN_TYPE === 1 || CONFIGURED_OPEN_TYPE === 2 ? CONFIGURED_OPEN_TYPE : 1;
  const leverageObjects = collectObjects(leverage);
  const reportedOpenType = Number(leverageObjects.find(o => o.openType !== undefined)?.openType);
  // v34.3.2: MEXC account/exchange state is authoritative. A stale OPEN_TYPE
  // env value must not block an otherwise valid entry, and the exact same value
  // is passed to the order endpoint below.
  const actualOpenType = (reportedOpenType === 1 || reportedOpenType === 2)
    ? reportedOpenType
    : ((supportedOpenType === 1 || supportedOpenType === 2) ? supportedOpenType : configuredOpenType);
  const openTypeOk = actualOpenType === 1 || actualOpenType === 2;
  const levOk = effectiveLeverage >= minLev && effectiveLeverage <= maxLev;
  const modeValues = collectObjects(mode)
    .flatMap(o => [o.positionMode, o.positionModeType])
    .filter(v => v !== undefined)
    .map(Number)
    .filter(v => v === 1 || v === 2);
  const actualPositionMode = modeValues[0] || CONFIGURED_POSITION_MODE;
  const modeOk = actualPositionMode === 1 || actualPositionMode === 2;

  const balanceOk = balance >= margin + ORDER_BALANCE_RESERVE_USDT;
  const sizingOk = volume > 0 && notional > 0 &&
    (!contract?.maxVol || volume <= Number(contract.maxVol));

  const ready = REAL_TRADING_ENABLED &&
    signal.signal !== "WAIT" &&
    positions.length===0 && orders.length===0 && plans.length===0 &&
    balanceOk && openTypeOk && levOk && modeOk && sizingOk;

  return {
    success:true,
    symbol,
    signal,
    noOpenPosition: positions.length===0,
    noOpenOrders: orders.length===0,
    noPlanOrders: plans.length===0,
    balanceOk,
    isolatedMargin: actualOpenType === 1,
    openType: actualOpenType,
    actualOpenType,
    openTypeOk,
    leverageOk: levOk,
    effectiveLeverage,
    positionModeOk: modeOk,
    actualPositionMode,
    configuredPositionMode: CONFIGURED_POSITION_MODE,
    sizingOk,
    balance, balanceInfo, price, volume, notional, requiredMargin:margin,
    adaptiveOrderSize:ADAPTIVE_ORDER_SIZE, requestedOrderUsdt, orderBalanceReserveUSDT:ORDER_BALANCE_RESERVE_USDT,
    leverage, positionMode:mode, contract,
    liveTradingEnabled:REAL_TRADING_ENABLED,
    autoTradingEnabled:AUTO_TRADING_ENABLED,
    ready,
    readyReason: ready ? "READY" : [
      !REAL_TRADING_ENABLED && "REAL_TRADING_ENABLED=false",
      signal.signal === "WAIT" && `SIGNAL=${signal.reason || "WAIT"}`,
      positions.length>0 && "open position exists",
      orders.length>0 && "open order exists",
      plans.length>0 && "plan order exists",
      !balanceOk && `insufficient balance (need ~${(margin + ORDER_BALANCE_RESERVE_USDT).toFixed(4)} USDT; available ${balance.toFixed(4)} USDT)`,
      !openTypeOk && `openType unavailable (resolved ${actualOpenType})`,
      !levOk && `leverage outside contract range (${minLev}-${maxLev})`,
      !modeOk && `position mode unavailable (${actualPositionMode})`,
      !sizingOk && "invalid contract quantity"
    ].filter(Boolean).join("; ")
  };
}


async function getOpenTPSL(symbol=SYMBOL) {
  // MEXC documents /stoporder/open_orders as the current TP/SL endpoint and
  // /stoporder/list/orders as the paginated TP/SL list. During the first few
  // seconds after a position opens, the two endpoints can briefly disagree,
  // so callers poll both rather than treating one empty response as failure.
  const normalize = (d) => {
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.data?.resultList)) return d.data.resultList;
    if (Array.isArray(d?.resultList)) return d.resultList;
    return [];
  };
  const out = [];
  try {
    const d = await mexc("GET", "/api/v1/private/stoporder/open_orders", { symbol }, true);
    for (const x of normalize(d)) out.push({...x, __tpslSource:"current"});
  } catch (e) {
    console.log("TP/SL CURRENT QUERY ERROR", JSON.stringify({symbol, error:e.message}));
  }
  try {
    const d = await mexc("GET", "/api/v1/private/stoporder/list/orders", {
      symbol, is_finished: 0, page_num: 1, page_size: 100
    }, true);
    for (const x of normalize(d)) {
      const state = Number(x?.state);
      const finished = Number(x?.isFinished);
      if ((!Number.isFinite(finished) || finished === 0) &&
          (!Number.isFinite(state) || state === 1)) {
        out.push({...x, __tpslSource:"list"});
      }
    }
  } catch (e) {
    console.log("TP/SL LIST QUERY ERROR", JSON.stringify({symbol, error:e.message}));
  }
  return out;
}

function samePrice(a, b, contract, ticks=2) {
  const tick = num(contract?.priceUnit) || 0.01;
  const x = num(a), y = num(b);
  return x !== null && y !== null && Math.abs(x-y) <= tick * Math.max(1, ticks) + 1e-9;
}

function protectionSemanticallyValid(direction, referencePrice, stop, take) {
  const ref=num(referencePrice), sl=num(stop), tp=num(take);
  if (!(ref>0 && sl>0 && tp>0)) return false;
  return direction === "LONG" ? (sl < ref && tp > ref) :
         direction === "SHORT" ? (sl > ref && tp < ref) : false;
}

function positionVolume(position) {
  return num(position?.holdVol ?? position?.vol ?? position?.volume ?? position?.positionVol) || 0;
}

function positionIdOf(position) {
  return position?.positionId ?? position?.positionID ?? position?.id;
}

function positionDirection(position) {
  const t = Number(position?.positionType ?? position?.position_type ?? position?.type);
  if (t === 1) return "LONG";
  if (t === 2) return "SHORT";
  const side = Number(position?.side);
  if (side === 1) return "LONG";
  if (side === 3) return "SHORT";
  const text = String(position?.positionType ?? position?.side ?? "").toUpperCase();
  if (text.includes("LONG")) return "LONG";
  if (text.includes("SHORT")) return "SHORT";
  return null;
}

function entryPriceOf(position) {
  return num(
    position?.openAvgPrice ?? position?.openAvgPx ?? position?.avgPrice ??
    position?.holdAvgPrice ?? position?.positionAvgPrice ?? position?.entryPrice
  );
}

function stopOrderIdOf(order) {
  return order?.id ?? order?.orderId ?? order?.stopPlanOrderId ?? order?.stopOrderId;
}


function targetFirstTpPct(price, atr14) {
  return ADAPTIVE_TP_START_PCT;
}

function protectionPricesFor(direction, entryPrice, contract, atr14=null, structure=null) {
  if (!(entryPrice > 0) || !["LONG","SHORT"].includes(direction)) {
    return {stop:null, take:null, tpPct:TAKE_PROFIT_PCT, stopPct:0, manualStopLoss:false, valid:false, reason:"Invalid entry direction/price"};
  }

  const take = direction === "LONG"
    ? roundPrice(entryPrice * (1 + TAKE_PROFIT_PCT), contract)
    : roundPrice(entryPrice * (1 - TAKE_PROFIT_PCT), contract);

  // STRUCTURE SL: never use a blind fixed 2% stop. Put the stop beyond the
  // latest local swing that invalidates the breakout, with an ATR buffer.
  // A configurable minimum distance (0.4% in Smart Pullback mode) prevents
  // an excessively tight blind stop; a maximum structural distance rejects setups
  // requires an excessively wide stop. This is a price-distance rule, not a
  // guarantee that the stop will only be hit 1% of the time.
  const minPct = STRUCTURE_STOP_MIN_PCT;
  const maxPct = MAX_STRUCTURE_STOP_PCT;
  const buffer = Math.max(0, Number(atr14) || 0) * STRUCTURE_STOP_BUFFER_ATR;
  const swing = direction === "LONG"
    ? num(structure?.pullbackLow ?? structure?.retestExtreme ?? structure?.swingLow)
    : num(structure?.pullbackHigh ?? structure?.retestExtreme ?? structure?.swingHigh);
  const structural = direction === "LONG"
    ? (swing !== null ? swing - buffer : null)
    : (swing !== null ? swing + buffer : null);

  const minimumStop = direction === "LONG" ? entryPrice * (1 - minPct) : entryPrice * (1 + minPct);
  const maximumStop = direction === "LONG" ? entryPrice * (1 - maxPct) : entryPrice * (1 + maxPct);

  let stopRaw;
  if (direction === "LONG") {
    stopRaw = structural !== null ? Math.min(structural, minimumStop) : minimumStop;
    if (stopRaw < maximumStop) {
      return {stop:null, take, tpPct:TAKE_PROFIT_PCT, stopPct:Math.abs((entryPrice-stopRaw)/entryPrice), manualStopLoss:false, valid:false, reason:`Structure SL too wide (> ${(maxPct*100).toFixed(2)}%)`};
    }
  } else {
    stopRaw = structural !== null ? Math.max(structural, minimumStop) : minimumStop;
    if (stopRaw > maximumStop) {
      return {stop:null, take, tpPct:TAKE_PROFIT_PCT, stopPct:Math.abs((stopRaw-entryPrice)/entryPrice), manualStopLoss:false, valid:false, reason:`Structure SL too wide (> ${(maxPct*100).toFixed(2)}%)`};
    }
  }

  const stop = roundPrice(stopRaw, contract);
  const stopPct = Math.abs(stop - entryPrice) / entryPrice;
  // v34.3.5: do not reject a directionally-correct structural stop merely
  // because price rounding makes it a few ticks inside the configured band.
  // The important safety checks are: SL must be on the correct side of entry,
  // must not be zero/negative, and must not exceed the maximum structural risk.
  const semanticOk = protectionSemanticallyValid(direction, entryPrice, stop, take);
  const roundedBandOk = stopPct > 0 && stopPct <= maxPct * 1.02;
  const valid = Boolean(stop > 0 && semanticOk && roundedBandOk);
  return {stop, take, tpPct:TAKE_PROFIT_PCT, stopPct, manualStopLoss:false, valid,
    method:structural !== null ? "STRUCTURE_SWING_ATR_BUFFER" : "MIN_DISTANCE",
    swingPrice:swing, bufferAtr:STRUCTURE_STOP_BUFFER_ATR, minStopPct:minPct, maxStopPct:maxPct,
    reason:valid ? null : (semanticOk ? `Structure SL too wide (> ${(maxPct*100).toFixed(2)}%)` : "Invalid structure-based protection")};
}

function adaptiveTpLevel(direction, entryPrice, currentTake, marketPrice, analysis) {
  if (!ADAPTIVE_TP_ENABLED || !(entryPrice > 0) || !(marketPrice > 0) || !analysis) return null;
  const profit = profitableMovePct(direction, entryPrice, marketPrice);
  if (profit < ADAPTIVE_TP_EXTEND_TRIGGER_PCT) return null;
  const slope = num(analysis.momentumSlope);
  const adx14 = num(analysis.adx14);
  const rsi14 = num(analysis.rsi14);
  const strong = direction === "LONG"
    ? analysis.direction === "LONG" && slope !== null && slope >= ADAPTIVE_TP_STRONG_SLOPE_PCT &&
      (adx14 === null || adx14 >= ADAPTIVE_TP_STRONG_ADX) && (rsi14 === null || rsi14 <= ADAPTIVE_TP_RSI_LONG_MAX)
    : analysis.direction === "SHORT" && slope !== null && slope <= -ADAPTIVE_TP_STRONG_SLOPE_PCT &&
      (adx14 === null || adx14 >= ADAPTIVE_TP_STRONG_ADX) && (rsi14 === null || rsi14 >= ADAPTIVE_TP_RSI_SHORT_MIN);
  if (!strong) return null;

  const currentPct = Math.abs((num(currentTake) - entryPrice) / entryPrice);
  const nextPct = Math.min(ADAPTIVE_TP_MAX_PCT, Math.max(ADAPTIVE_TP_START_PCT, currentPct + ADAPTIVE_TP_STEP_PCT));
  if (nextPct <= currentPct + 0.0025) return null;
  return {targetPct:nextPct, profitPct:profit, momentumSlope:slope, adx14, rsi14};
}

const pendingProtectionByPosition = new Map();

async function ensureProtection(symbol, direction, position, stop, take, contract, referencePrice=null) {
  // Automatic fixed SL + TP protection. Entry quality is handled separately
  // by the hard pullback/reclaim gate before an order can be opened.
  take = roundPrice(take, contract);
  const pid = positionIdOf(position);
  const vol = positionVolume(position);
  const positionReference = num(referencePrice ?? entryPriceOf(position));
  if (!(take > 0) || !positionReference) return {protected:false, reason:"invalid take-profit or position reference"};
  if (pid === undefined || pid === null || vol <= 0) return {protected:false, reason:"position id/volume not available"};

  const pendingKey = `${symbol}:${pid}`;
  const pending = pendingProtectionByPosition.get(pendingKey);
  if (pending && Date.now() - pending.at < 10 * 60 * 1000) {
    return {protected:false, protectionAccepted:true, safeToHold:true, verificationPending:true,
      positionId:pid, volume:vol, stopLossPrice:pending.stop ?? null, takeProfitPrice:pending.take,
      placement:pending.result, reason:"TP placement accepted; verification endpoint still settling"};
  }
  if (pending) pendingProtectionByPosition.delete(pendingKey);

  const wantedType = direction === "LONG" ? 1 : 2;
  const isLiveProtection = (x) => {
    const state = Number(x?.state), finished = Number(x?.isFinished);
    return (!Number.isFinite(state) || state === 1) && (!Number.isFinite(finished) || finished === 0);
  };
  const findMatch = (rows) => {
    const live = rows.filter(isLiveProtection);
    const exact = live.find(x => String(x?.positionId ?? "") === String(pid));
    if (exact) return exact;
    const fallback = live.filter(x => String(x?.symbol || "").toUpperCase() === String(symbol).toUpperCase() &&
      Number(x?.positionType) === wantedType && !x?.positionId);
    return fallback.length === 1 ? fallback[0] : null;
  };
  const tpMatches = (match) => !!match && num(match.takeProfitPrice) !== null && samePrice(match.takeProfitPrice, take, contract, 2) && (stop === null || num(match.stopLossPrice) !== null);
  const liveTpMatchesPosition = (rows) => rows.filter(isLiveProtection)
    .filter(x => String(x?.positionId ?? "") === String(pid))
    .filter(x => num(x?.takeProfitPrice) !== null);

  let tpsl = await getOpenTPSL(symbol);
  let match = findMatch(tpsl);
  const existingTpOrders = liveTpMatchesPosition(tpsl);
  // Never create a second protection order for the same position. If a TP exists
  // without the required SL, upgrade the existing order in-place instead.
  if (existingTpOrders.length > 0) {
    const existing = existingTpOrders.find(tpMatches) || existingTpOrders[0];
    if (existingTpOrders.length > 1) console.log("TP/SL DUPLICATE DETECTED", JSON.stringify({symbol,direction,positionId:pid,count:existingTpOrders.length}));
    if (num(existing.stopLossPrice) !== null && tpMatches(existing)) {
      return {protected:true, positionId:pid, volume:vol, stopLossPrice:existing.stopLossPrice,
        takeProfitPrice:existing.takeProfitPrice, tpsl:existing, manualStopLoss:false, duplicateTpCount:existingTpOrders.length};
    }
    const existingId = stopOrderIdOf(existing);
    if (existingId !== undefined && existingId !== null && stop > 0) {
      try {
        await mexc("POST", "/api/v1/private/stoporder/change_price", {orderId:existingId, stopLossPrice:stop, takeProfitPrice:take}, true);
        await new Promise(r=>setTimeout(r,500));
        const verifyRows = await getOpenTPSL(symbol);
        const verified = verifyRows.find(x => String(x.positionId ?? "") === String(pid) && (!x.state || Number(x.state) === 1));
        if (verified && num(verified.stopLossPrice) !== null && num(verified.takeProfitPrice) !== null && samePrice(verified.stopLossPrice, stop, contract) && samePrice(verified.takeProfitPrice, take, contract)) {
          return {protected:true, positionId:pid, volume:vol, stopLossPrice:verified.stopLossPrice, takeProfitPrice:verified.takeProfitPrice, tpsl:verified, manualStopLoss:false, upgradedExisting:true};
        }
      } catch (e) {
        console.log("TP/SL EXISTING ORDER UPGRADE FAILED", JSON.stringify({symbol,direction,positionId:pid,error:e.message}));
      }
    }
    // If an existing TP cannot be upgraded, do not create a duplicate order.
    return {protected:false, protectionAccepted:false, verificationPending:true, safeToHold:false,
      positionId:pid, volume:vol, stopLossPrice:existing.stopLossPrice ?? null, takeProfitPrice:existing.takeProfitPrice,
      tpsl:existing, manualStopLoss:false, error:"Existing TP found but automatic SL could not be verified"};
  }

  let lastError = null, placementAccepted = false, placeResult = null;
  for (let placementAttempt=1; placementAttempt<=2 && !placementAccepted; placementAttempt++) {
    try {
      placeResult = await mexc("POST", "/api/v1/private/stoporder/place", {
        positionId:pid, vol, stopLossPrice:stop, takeProfitPrice:take,
        profitTrend: direction === "LONG" ? 2 : 1,
        profitLossVolType:"SAME", volType:1, positionMode:1
      }, true);
      placementAccepted = true;
      pendingProtectionByPosition.set(pendingKey, {at:Date.now(), stop, take, result:placeResult});
      console.log("TP/SL PLACE ACCEPTED", JSON.stringify({symbol,direction,positionId:pid,requestedStop:stop,requestedTake:take,
        placementAttempt,stopLoss:"AUTO_STRUCTURE",result:placeResult?.data ?? placeResult ?? null}));
    } catch (e) {
      lastError = e.message;
      console.log("TP/SL PLACE FAILED", JSON.stringify({symbol,direction,positionId:pid,requestedStop:stop,requestedTake:take,
        placementAttempt,stopLoss:"AUTO_STRUCTURE",error:e.message}));
      if (placementAttempt < 2) await new Promise(r=>setTimeout(r, PROTECTION_VERIFY_DELAY_MS));
    }
  }

  if (placementAccepted) {
    for (let attempt=1; attempt<=PROTECTION_VERIFY_RETRIES; attempt++) {
      await new Promise(r=>setTimeout(r, PROTECTION_VERIFY_DELAY_MS));
      tpsl = await getOpenTPSL(symbol); match = findMatch(tpsl);
      console.log("TP/SL VERIFY", JSON.stringify({symbol,direction,positionId:pid,attempt,requestedStop:stop,requestedTake:take,
        matched:match ? {id:stopOrderIdOf(match),positionId:match.positionId ?? null,state:match.state ?? null,
          isFinished:match.isFinished ?? null,stop:match.stopLossPrice ?? null,take:match.takeProfitPrice ?? null} : null}));
      if (tpMatches(match)) {
        pendingProtectionByPosition.delete(pendingKey);
        return {protected:true,verifiedAttempt:attempt,positionId:pid,volume:vol,
          stopLossPrice:match.stopLossPrice ?? stop,takeProfitPrice:match.takeProfitPrice,tpsl:match,
          placement:placeResult,manualStopLoss:false};
      }
    }
  }

  if (placementAccepted) return {protected:false,protectionAccepted:true,safeToHold:true,verificationPending:true,
    positionId:pid,volume:vol,stopLossPrice:match?.stopLossPrice ?? stop,takeProfitPrice:match?.takeProfitPrice ?? take,
    tpsl:match || null,placement:placeResult,manualStopLoss:false,
    reason:"TP placement accepted; verification endpoint did not reflect it yet"};

  return {protected:false,positionId:pid,volume:vol,stopLossPrice:match?.stopLossPrice ?? stop,
    takeProfitPrice:match?.takeProfitPrice ?? null,tpsl:match || null,placement:placeResult,manualStopLoss:false,
    error:lastError || "Take-profit could not be placed or verified"};
}

function logExitReason(data) {
  // One compact, human-readable event per exit attempt. This makes rapid closes
  // diagnosable from Railway logs without opening the long AUTO RESULT JSON.
  console.log("EXIT REASON", JSON.stringify({
    time: new Date().toISOString(),
    symbol: data?.symbol || null,
    direction: data?.direction || null,
    positionId: data?.positionId ?? null,
    entryPrice: data?.entryPrice ?? null,
    closePrice: data?.closePrice ?? null,
    reason: data?.reason || "UNKNOWN",
    tp: data?.takeProfitPrice ?? null,
    sl: data?.stopLossPrice ?? null,
    tpslConfirmed: data?.tpslConfirmed ?? null,
    detail: data?.detail || null
  }));
}

async function placeMarketOrder(symbol, direction) {
  if (!REAL_TRADING_ENABLED) throw new Error("REAL_TRADING_ENABLED is false");
  symbol = String(symbol || "").toUpperCase();
  await refreshActiveSymbols(true);
  await ensureTradableSymbol(symbol);
  if (!["LONG","SHORT"].includes(direction)) throw new Error("Direction must be LONG or SHORT");

  const pf = await preflight(symbol);
  if (!pf.ready) throw new Error("Preflight failed: " + JSON.stringify(pf));
  // Final direction lock: the live signal must still equal the direction that
  // reached this order function. Never place a LONG order from a SHORT signal
  // (or vice versa), even if the market changes between scan and preflight.
  const finalSignalDirection = String(pf.signal?.signal || "WAIT").toUpperCase();
  if (finalSignalDirection !== direction) {
    throw new Error(`FINAL DIRECTION MISMATCH - ORDER BLOCKED (requested ${direction}, live signal ${finalSignalDirection})`);
  }

  const side = direction === "LONG" ? 1 : 3;
  // Final quote sanity check: do not send a market order if price moved too far
  // away from the price used to build the signal/protection plan.
  const liveTicker = await mexc("GET", "/api/v1/contract/ticker", { symbol });
  const livePrice = num(liveTicker?.data?.lastPrice ?? liveTicker?.data?.fairPrice ?? liveTicker?.data?.indexPrice);
  if (!(livePrice > 0) || !(pf.price > 0)) throw new Error("Fresh market price unavailable; entry blocked");
  const entryDrift = Math.abs(livePrice - pf.price) / pf.price;
  if (entryDrift > MAX_ENTRY_SLIPPAGE_PCT) throw new Error(`Entry price moved ${(entryDrift*100).toFixed(3)}%; trade blocked`);

  const targetPlan = protectionPricesFor(direction, livePrice, pf.contract, pf.signal?.atr14, pf.signal?.breakout);
  const stop = targetPlan.stop;
  const take = targetPlan.take;
  if (!targetPlan.valid || !(stop > 0)) throw new Error(`Protection plan rejected: ${targetPlan.reason || "unsafe structure stop"}`);

  // IMPORTANT v20: do NOT attach TP/SL to the opening market order.
  // MEXC can reject that combined request with error 5003 (price/stop-limit
  // validation). Open the market position first, then place and verify
  // protection using the actual filled/entry price.
  let order;
  try {
    order = await mexc("POST", "/api/v1/private/order/create", {
      symbol,
      price: 0,
      vol: pf.volume,
      side,
      type: 5,
      openType: pf.actualOpenType,
      leverage: pf.effectiveLeverage,
      positionMode: pf.actualPositionMode
    }, true);
  } catch (e) {
    // Make the failure explicit so logs show that no TP/SL was involved.
    throw new Error(`ENTRY ORDER FAILED (no TP/SL attached): ${e.message}`);
  }

  // Give MEXC a moment to create the position.
  let position = null;
  for (let i=0;i<10;i++) {
    await new Promise(r=>setTimeout(r,700));
    const ps = await getPositions(symbol);
    position = ps.find(p => num(p?.holdVol ?? p?.vol ?? p?.volume) > 0) || null;
    if (position) break;
  }

  if (!position) {
    return {success:true, order, protected:false, warning:"Order accepted but position not visible yet"};
  }

  // Use the actual position entry price when available. This avoids building
  // TP/SL from a stale signal candle price and reduces 5003 trigger-price errors.
  const ps2 = await getPositions(symbol);
  const livePos = ps2.find(p => String(positionIdOf(p)) === String(positionIdOf(position))) || position;
  const entryPrice = num(
    livePos?.openAvgPrice ?? livePos?.openAvgPx ?? livePos?.avgPrice ??
    livePos?.holdAvgPrice ?? livePos?.positionAvgPrice ?? livePos?.entryPrice
  ) || pf.price;
  const targetPlanFromEntry = protectionPricesFor(direction, entryPrice, pf.contract, pf.signal?.atr14, pf.signal?.breakout);
  const stopFromEntry = targetPlanFromEntry.stop;
  const takeFromEntry = targetPlanFromEntry.take;
  if (!targetPlanFromEntry.valid || !(stopFromEntry > 0)) {
    console.log("POST-ENTRY PROTECTION PLAN INVALID", JSON.stringify({symbol,direction,positionId:positionIdOf(livePos),entryPrice,reason:targetPlanFromEntry.reason || "unsafe structure stop"}));
  }

  // Never assume TP/SL was accepted. Verify it on MEXC.
  let protection;
  try {
    protection = await ensureProtection(symbol, direction, livePos, stopFromEntry, takeFromEntry, pf.contract, entryPrice);
  } catch (e) {
    console.log("TP-ONLY PROTECTION ERROR - HOLD POSITION", JSON.stringify({symbol,direction,positionId:positionIdOf(livePos),
      entryPrice,stopLossPrice:stopFromEntry,takeProfitPrice:takeFromEntry,stopLoss:"AUTO_STRUCTURE",error:e.message}));
    return {success:true,order,position:livePos,protected:false,verificationPending:true,safeToHold:true,entryPrice,
      stopLossPrice:stopFromEntry,takeProfitPrice:takeFromEntry,warning:"TP/SL placement/verification pending; automatic structure SL is being verified."};
  }

  if (!protection.protected) {
    console.log("TP-ONLY VERIFICATION PENDING - HOLD POSITION", JSON.stringify({symbol,direction,
      positionId:positionIdOf(livePos),entryPrice,stopLossPrice:stopFromEntry,stopLoss:"AUTO_STRUCTURE",takeProfitPrice:takeFromEntry}));
    return {success:true,order,position:livePos,protected:false,protectionAccepted:protection.protectionAccepted,
      verificationPending:true,safeToHold:true,entryPrice,stopLossPrice:stopFromEntry,takeProfitPrice:takeFromEntry,
      protection,warning:"Automatic structure-based SL/TP is pending verification."};
  }


  console.log("TP/SL PROTECTION CONFIRMED", JSON.stringify({
    time:new Date().toISOString(), symbol, direction, positionId:positionIdOf(livePos),
    entryPrice, stopLossPrice:stopFromEntry, takeProfitPrice:takeFromEntry, protected:true, manualStopLoss:false
  }));

  return {
    success:true,
    order,
    position:livePos,
    protected:true,
    entryPrice,
    stopLossPrice:stopFromEntry,
    takeProfitPrice:takeFromEntry,
    protection
  };
}


function profitableMovePct(direction, entryPrice, marketPrice) {
  if (!(entryPrice > 0 && marketPrice > 0)) return -1;
  return direction === "LONG"
    ? (marketPrice-entryPrice)/entryPrice
    : (entryPrice-marketPrice)/entryPrice;
}

function betterStop(direction, candidate, current, contract) {
  const c = num(current), n = num(candidate);
  if (n === null) return false;
  if (c === null) return true;
  const tick = num(contract?.priceUnit) || 0.01;
  return direction === "LONG" ? n > c + tick/2 : n < c - tick/2;
}

function safeStopForMarket(direction, stop, marketPrice, contract) {
  const tick = num(contract?.priceUnit) || 0.01;
  const minGap = Math.max(tick, marketPrice * MIN_STOP_DISTANCE_PCT);
  let s = num(stop);
  if (direction === "LONG") {
    s = Math.min(s, marketPrice - minGap);
  } else {
    s = Math.max(s, marketPrice + minGap);
  }
  return roundPrice(s, contract);
}

async function changeProtectionStop(symbol, match, direction, newStop, take, contract) {
  const orderId = stopOrderIdOf(match);
  if (orderId === undefined || orderId === null) {
    throw new Error("Active TP/SL order id is unavailable");
  }
  await mexc("POST", "/api/v1/private/stoporder/change_price", {
    orderId,
    stopLossPrice: newStop,
    takeProfitPrice: take
  }, true);
  await new Promise(r=>setTimeout(r,500));
  const tpsl = await getOpenTPSL(symbol);
  const pid = match.positionId;
  const verified = tpsl.find(x => String(x.positionId) === String(pid) &&
    (!x.state || Number(x.state) === 1));
  const ok = !!verified &&
    samePrice(verified.stopLossPrice, newStop, contract) &&
    samePrice(verified.takeProfitPrice, take, contract);
  if (!ok) throw new Error("MEXC did not verify the updated TP/SL");
  return verified;
}

async function recoveryProtectionPlan(symbol, direction, entryPrice, contract) {
  const candles = await getCandles(symbol, "Min5");
  const closed = candles.filter(c => Number(c.time) < Date.now() - 20 * 1000);
  if (closed.length < 25) return {valid:false, reason:"Not enough closed 5m candles for recovery structure"};
  const window = closed.slice(-21, -1);
  const atr14 = atr(closed, 14);
  if (!(atr14 > 0)) return {valid:false, reason:"ATR unavailable for recovery protection"};
  const lows = window.map(c => Number(c.low)).filter(Number.isFinite);
  const highs = window.map(c => Number(c.high)).filter(Number.isFinite);
  if (!lows.length || !highs.length) return {valid:false, reason:"Recent swing data unavailable"};
  const swingLow = Math.min(...lows);
  const swingHigh = Math.max(...highs);
  const structure = {swingLow, swingHigh, recovery:true};
  const plan = protectionPricesFor(direction, entryPrice, contract, atr14, structure);
  if (plan.valid) return {...plan, recovery:true, recoveryAtr14:atr14, recoverySwingLow:swingLow, recoverySwingHigh:swingHigh};
  const emergencyStop = direction === "LONG" ? roundPrice(entryPrice * (1 - STRUCTURE_STOP_MIN_PCT), contract) : roundPrice(entryPrice * (1 + STRUCTURE_STOP_MIN_PCT), contract);
  const take = direction === "LONG" ? roundPrice(entryPrice * (1 + TAKE_PROFIT_PCT), contract) : roundPrice(entryPrice * (1 - TAKE_PROFIT_PCT), contract);
  const valid = Boolean(protectionSemanticallyValid(direction, entryPrice, emergencyStop, take) && emergencyStop > 0 && take > 0);
  return {stop:valid ? emergencyStop:null, take:valid ? take:null, tpPct:TAKE_PROFIT_PCT, stopPct:Math.abs(emergencyStop-entryPrice)/entryPrice, manualStopLoss:false, valid, method:"EMERGENCY_MIN_DISTANCE", recovery:true, recoveryAtr14:atr14, recoverySwingLow:swingLow, recoverySwingHigh:swingHigh, reason:valid ? `Structure recovery rejected (${plan.reason || "unknown"}); emergency minimum-distance protection used` : "Emergency recovery protection invalid"};
}

async function managePosition(symbol, position) {
  const vol = positionVolume(position);
  if (vol <= 0) return {symbol, skipped:true, reason:"zero position volume"};
  const direction = positionDirection(position);
  const entry = entryPriceOf(position);
  if (!direction || !(entry > 0)) return {symbol, skipped:true, reason:"position direction or entry price unavailable"};

  const [contract, ticker] = await Promise.all([getContract(symbol), getTicker(symbol)]);
  const marketPrice = num(ticker?.lastPrice ?? ticker?.fairPrice ?? ticker?.indexPrice);
  if (!(marketPrice > 0)) throw new Error("Current market price unavailable");

  let tpsl = await getOpenTPSL(symbol);
  let match = tpsl.find(x => String(x.positionId) === String(positionIdOf(position)) &&
    (!x.state || Number(x.state) === 1) && (!Number.isFinite(Number(x.isFinished)) || Number(x.isFinished) === 0));

  if (!match || num(match.takeProfitPrice) === null || num(match.stopLossPrice) === null) {
    const target = await recoveryProtectionPlan(symbol, direction, entry, contract);
    if (!target.valid || !(target.stop > 0) || !(target.take > 0)) {
      return {symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
        action:"PROTECTION_PLAN_REJECTED",reason:target.reason || "invalid automatic protection plan",
        stopLossPrice:target.stop ?? null,takeProfitPrice:target.take ?? null,manualStopLoss:false};
    }
    console.log("PROTECTION RECOVERY", JSON.stringify({symbol, direction, positionId:positionIdOf(position), entryPrice:entry, method:target.method, stop:target.stop, take:target.take, atr14:target.recoveryAtr14, swingLow:target.recoverySwingLow, swingHigh:target.recoverySwingHigh, reason:target.reason || null}));
    const protection = await ensureProtection(symbol, direction, position, target.stop, target.take, contract, entry);
    if (!protection.protected) {
      return {symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
        action:"PROTECTION_VERIFICATION_PENDING",reason:"TP/SL accepted/settling; automatic structure SL is verifying",
        stopLossPrice:target.stop,takeProfitPrice:target.take,manualStopLoss:false};
    }
    match = protection.tpsl;
  }

  let currentTake = num(match?.takeProfitPrice);
  let currentStop = num(match?.stopLossPrice);
  if (!(currentTake > 0) || !(currentStop > 0)) {
    return {symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
      action:"PROTECTION_MISSING",reason:"verified TP/SL price unavailable",stopLossPrice:currentStop,takeProfitPrice:currentTake};
  }

  const profitPct = profitableMovePct(direction, entry, marketPrice);
  let adaptive = null;
  let tpUpdated = false;
  let stopUpdated = false;
  let newStop = currentStop;

  // Initial TP is 2%. If momentum remains strong, adaptive TP may extend it;
  // the trailing/break-even SL independently protects profit and never moves backwards.
  try {
    const candles5m = await getCandles(symbol, "Min5");
    const analysis5m = timeframeAnalysis(candles5m);
    adaptive = adaptiveTpLevel(direction, entry, currentTake, marketPrice, analysis5m);
    if (adaptive) {
      const targetTake = direction === "LONG"
        ? roundPrice(entry * (1 + adaptive.targetPct), contract)
        : roundPrice(entry * (1 - adaptive.targetPct), contract);
      const currentPct = Math.abs((currentTake-entry)/entry);
      if (targetTake > 0 && Math.abs(targetTake-currentTake) > (num(contract?.priceUnit)||0.00000001) && adaptive.targetPct > currentPct + 0.0025) {
        const orderId = stopOrderIdOf(match);
        if (orderId !== undefined && orderId !== null) {
          const payload = {orderId, takeProfitPrice:targetTake, stopLossPrice:currentStop};
          await mexc("POST", "/api/v1/private/stoporder/change_price", payload, true);
          await new Promise(r=>setTimeout(r,500));
          const verifiedRows = await getOpenTPSL(symbol);
          const verified = verifiedRows.find(x => String(x.positionId ?? "") === String(positionIdOf(position)) && (!x.state || Number(x.state) === 1));
          if (verified && num(verified.takeProfitPrice) !== null && num(verified.stopLossPrice) !== null && samePrice(verified.takeProfitPrice, targetTake, contract, 2)) {
            match = verified;
            currentTake = num(verified.takeProfitPrice);
            currentStop = num(verified.stopLossPrice);
            tpUpdated = true;
            console.log("ADAPTIVE TP UPDATED", JSON.stringify({symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
              oldTake:currentTake,targetTake, targetPct:adaptive.targetPct, profitPct:adaptive.profitPct,
              momentumSlope:adaptive.momentumSlope,adx14:adaptive.adx14,rsi14:adaptive.rsi14}));
          }
        }
      }
    }
  } catch (e) {
    console.log("ADAPTIVE TP CHECK ERROR", JSON.stringify({symbol,direction,positionId:positionIdOf(position),error:e.message}));
  }

  // Profit protection: once the trade reaches +1%, move SL safely above entry.
  // From +2%, trail behind market price. The stop can only move in the
  // profitable direction and is always kept a safe distance from market price.
  try {
    let candidateStop = null;
    if (TRAILING_STOP_ENABLED && profitPct >= TRAILING_TRIGGER_PCT) {
      candidateStop = direction === "LONG"
        ? marketPrice * (1 - TRAILING_STOP_PCT)
        : marketPrice * (1 + TRAILING_STOP_PCT);
    } else if (BREAK_EVEN_ENABLED && profitPct >= BREAK_EVEN_TRIGGER_PCT) {
      candidateStop = direction === "LONG"
        ? entry * (1 + BREAK_EVEN_OFFSET_PCT)
        : entry * (1 - BREAK_EVEN_OFFSET_PCT);
    }

    if (candidateStop !== null) {
      candidateStop = safeStopForMarket(direction, candidateStop, marketPrice, contract);
      if (betterStop(direction, candidateStop, currentStop, contract)) {
        const updated = await changeProtectionStop(symbol, match, direction, candidateStop, currentTake, contract);
        currentStop = num(updated?.stopLossPrice) ?? candidateStop;
        match = updated;
        stopUpdated = true;
        newStop = currentStop;
        console.log("PROFIT STOP UPDATED", JSON.stringify({symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
          profitPct,candidateStop:currentStop,mode:profitPct>=TRAILING_TRIGGER_PCT?"TRAILING":"BREAK_EVEN"}));
      }
    }
  } catch (e) {
    console.log("PROFIT STOP UPDATE ERROR", JSON.stringify({symbol,direction,positionId:positionIdOf(position),error:e.message}));
  }

  return {symbol,direction,positionId:positionIdOf(position),entryPrice:entry,marketPrice,
    profitPct,stopLossPrice:currentStop,takeProfitPrice:currentTake,
    action:tpUpdated?"ADAPTIVE_TP_RAISED":(stopUpdated?"PROFIT_STOP_RAISED":"HOLD_PROTECTED"),
    reason:tpUpdated?"Strong 5m momentum; TP extended":(stopUpdated?"Profit protected with break-even/trailing stop":"Automatic structure SL active"),
    adaptiveTpEnabled:ADAPTIVE_TP_ENABLED,adaptiveTpMaxPct:ADAPTIVE_TP_MAX_PCT,
    breakEvenEnabled:BREAK_EVEN_ENABLED,trailingStopEnabled:TRAILING_STOP_ENABLED,manualStopLoss:false,tpsl:match};
}

async function syncClosedRiskFromHistory() {
  resetDailyRiskState();
  let rows=[];
  try {
    const d=await mexc("GET","/api/v1/private/position/list/history_positions",{start_time:Date.now()-48*60*60*1000,end_time:Date.now(),page_num:1,page_size:100},true);
    const payload=d?.data;
    rows=Array.isArray(payload)?payload:(Array.isArray(payload?.resultList)?payload.resultList:[]);
  } catch { return; }
  const closed=rows.filter(p=>Number(p?.state)===3 || Number(p?.closeVol||0)>0 || Number(p?.closeAvgPrice||0)>0)
    .sort((a,b)=>Number(a?.updateTime||a?.closeTime||0)-Number(b?.updateTime||b?.closeTime||0));
  if(!tradeRiskState.seeded) {
    for(const p of closed.slice(-100)) { const id=String(p?.positionId||p?.id||""); if(id) tradeRiskState.countedClosedPositions[id]=true; }
    tradeRiskState.seeded=true;
    savePersistentState();
    return;
  }
  let changed=false;
  for(const p of closed) {
    const id=String(p?.positionId||p?.id||"");
    if(!id || tradeRiskState.countedClosedPositions[id]) continue;
    const pnl=num(p?.realised ?? p?.realizedPnl ?? p?.profit);
    if(pnl===null) continue;
    tradeRiskState.countedClosedPositions[id]=true;
    if(pnl < 0) recordLoss(); else if(pnl > 0) recordWin();
    changed=true;
  }
  const ids=Object.keys(tradeRiskState.countedClosedPositions||{});
  if(ids.length>200) tradeRiskState.countedClosedPositions=Object.fromEntries(ids.slice(-200).map(id=>[id,true]));
  if(changed) savePersistentState();
}

async function tradeManagerOnce() {
  if (tradeManagerBusy) return {skipped:true, reason:"trade manager already running"};
  tradeManagerBusy = true;
  lastTradeManagerRun = new Date().toISOString();
  try {
    if (!TRADE_MANAGER_ENABLED) {
      const result={skipped:true, reason:"TRADE_MANAGER_ENABLED is false"};
      lastTradeManagerResult=result;
      return result;
    }
    if (!REAL_TRADING_ENABLED) {
      const result={skipped:true, reason:"REAL_TRADING_ENABLED is false"};
      lastTradeManagerResult=result;
      return result;
    }

    await syncClosedRiskFromHistory();
    const results=[];
    // MEXC supports fetching all open positions without a symbol. This avoids
    // making up to 150 private requests every manager cycle. We only call
    // managePosition() for symbols that actually have a live position.
    const allPositions = await getPositions();
    const grouped = new Map();
    for (const position of allPositions) {
      if (positionVolume(position) <= 0) continue;
      const symbol = String(position?.symbol || "").toUpperCase();
      if (!symbol) continue;
      if (!grouped.has(symbol)) grouped.set(symbol, []);
      grouped.get(symbol).push(position);
    }
    for (const [symbol, positions] of grouped.entries()) {
      for (const position of positions) {
        try {
          results.push(await managePosition(symbol, position));
        } catch (e) {
          results.push({symbol, action:"MANAGER_ERROR", error:e.message});
        }
      }
    }
    const result={success:true, results};
    lastTradeManagerResult=result;
    return result;
  } finally {
    tradeManagerBusy=false;
  }
}

function resetDailyRiskState() {
  loadPersistentState();
  const day=localDayKey();
  if(tradeRiskState.day!==day) {
    tradeRiskState={day,tradesToday:0,lastEntryAt:0,lossStreak:0,lastClosedAt:0,lastObservedPositions:{},countedClosedPositions:{},startEquity:null,seeded:false};
    savePersistentState();
  }
  return tradeRiskState;
}

async function openPositionCount() {
  try {
    const ps = await getPositions();
    return ps.filter(p=>positionVolume(p)>0).length;
  } catch {
    return 0;
  }
}

async function entryRiskGate(symbol, signal) {
  resetDailyRiskState();
  const direction = String(signal || "").toUpperCase();
  if (!["LONG","SHORT"].includes(direction)) return {ok:false,reason:`Invalid entry direction (${direction || "EMPTY"})`};
  if(tradeRiskState.tradesToday>=MAX_TRADES_PER_DAY) return {ok:false,reason:`Daily trade limit reached (${MAX_TRADES_PER_DAY})`};
  if(tradeRiskState.lossStreak>=MAX_LOSS_STREAK) {
    const elapsed=Date.now()-(tradeRiskState.lastClosedAt||0);
    if(elapsed < LOSS_STREAK_COOLDOWN_MINUTES*60000) return {ok:false,reason:`Loss-streak protection active (${tradeRiskState.lossStreak} losses; ${LOSS_STREAK_COOLDOWN_MINUTES}m cooldown)`};
    tradeRiskState.lossStreak=0;
    savePersistentState();
  }
  const openPositions=await getPositions();
  const open=openPositions.length;
  // Cooldown applies between all new entries, not only when the account is flat.
  // This prevents rapid stacking during a noisy candle sequence.
  if(ENTRY_COOLDOWN_ALL_TRADES && tradeRiskState.lastEntryAt && Date.now()-tradeRiskState.lastEntryAt<ENTRY_COOLDOWN_MINUTES*60000) return {ok:false,reason:`Entry cooldown active (${ENTRY_COOLDOWN_MINUTES}m between entries)`};
  if(open===0 && !ENTRY_COOLDOWN_ALL_TRADES && tradeRiskState.lastEntryAt && Date.now()-tradeRiskState.lastEntryAt<ENTRY_COOLDOWN_MINUTES*60000) return {ok:false,reason:`Entry cooldown active (${ENTRY_COOLDOWN_MINUTES}m)`};
  if(open>=MAX_OPEN_POSITIONS) return {ok:false,reason:`Maximum open positions reached (${MAX_OPEN_POSITIONS})`};
  const sameDirection=openPositions.filter(p=>positionDirection(p)===direction).length;
  if(sameDirection>=MAX_SAME_DIRECTION_POSITIONS) return {ok:false,reason:`Same-direction concentration limit reached (${MAX_SAME_DIRECTION_POSITIONS} ${direction})`};

  // Account-level daily drawdown circuit breaker. Once breached, no new
  // positions are opened until the local trading day resets. Existing positions
  // remain under the independent trade manager/SL protection.
  const account=await getAccount();
  const equity=accountEquity(account);
  if(equity>0 && !tradeRiskState.startEquity) {
    tradeRiskState.startEquity=equity;
    savePersistentState();
  }
  if(equity>0 && tradeRiskState.startEquity>0) {
    const dailyDrawdown=(tradeRiskState.startEquity-equity)/tradeRiskState.startEquity;
    if(DAILY_DRAWDOWN_PROTECTION_ENABLED && dailyDrawdown >= MAX_DAILY_DRAWDOWN_PCT) return {ok:false,reason:`Daily drawdown circuit breaker (${(dailyDrawdown*100).toFixed(2)}% >= ${(MAX_DAILY_DRAWDOWN_PCT*100).toFixed(2)}%)`,dailyDrawdown};
  }

  const news=await refreshNewsRisk();
  const sig=await getSignal(symbol);
  if(NEWS_RISK_ENABLED && (news?.blocked || sig?.newsRisk?.coinCritical)) return {ok:false,reason:sig?.reason||"News risk filter blocked entry"};

  const stats=marketStatsCache.stats[symbol] || {};
  if(LIQUIDITY_MIN_24H_USDT>0 && stats.amount24>0 && stats.amount24<LIQUIDITY_MIN_24H_USDT) return {ok:false,reason:`Liquidity filter: 24h turnover too low (${Math.round(stats.amount24)} USDT)`};
  if(stats.bid1>0 && stats.ask1>0 && stats.lastPrice>0){
    const spread=(stats.ask1-stats.bid1)/stats.lastPrice;
    if(spread>MAX_SPREAD_PCT) return {ok:false,reason:`Spread filter: ${(spread*100).toFixed(3)}%`};
  }

  const atrPct=(sig?.atr14 && sig?.price) ? sig.atr14/sig.price : 0;
  if(atrPct>0.08) return {ok:false,reason:`Extreme volatility filter (ATR ${(atrPct*100).toFixed(2)}%)`};
  if(sig?.quality?.volatilitySpike) return {ok:false,reason:`Volatility spike filter (${VOLATILITY_SPIKE_ATR_MULTIPLIER}x ATR)`};
  if(sig?.quality?.lateEntryRisk) return {ok:false,reason:sig.reason || "Late entry location filter"};
  if(Number(sig?.score||0) < MIN_SIGNAL_SCORE) return {ok:false,reason:`Signal score below safety threshold (${Number(sig?.score||0).toFixed(1)} < ${MIN_SIGNAL_SCORE})`};
  if(Number(sig?.precisionScore||0) < MIN_PRECISION_SCORE) return {ok:false,reason:`Precision score below safety threshold (${Number(sig?.precisionScore||0).toFixed(1)} < ${MIN_PRECISION_SCORE})`};
  if(REQUIRE_15M_ALIGNMENT && sig?.timeframes?.Min15?.bias !== direction) return {ok:false,reason:`15m trend not aligned (${sig?.timeframes?.Min15?.bias || "NA"})`};
  if(REQUIRE_1H_ALIGNMENT && sig?.timeframes?.Min60?.bias !== direction) return {ok:false,reason:`1h trend not aligned (${sig?.timeframes?.Min60?.bias || "NA"})`};
  if(REQUIRE_DAILY_ALIGNMENT && sig?.timeframes?.Day1?.bias !== direction) return {ok:false,reason:`Daily trend not aligned (${sig?.timeframes?.Day1?.bias || "NA"})`};
  if(!MANUAL_STOP_LOSS && Number(sig?.quality?.riskReward||0) < MIN_RISK_REWARD) return {ok:false,reason:`Risk/reward below minimum (${Number(sig?.quality?.riskReward||0).toFixed(2)} < ${MIN_RISK_REWARD})`};
  return {ok:true,openPositions:open,sameDirectionPositions:sameDirection,equity,signal,dailyDrawdown:tradeRiskState.startEquity>0 ? (tradeRiskState.startEquity-equity)/tradeRiskState.startEquity : 0};
}


async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (e) { out[i] = {error:e?.message || String(e)}; }
    }
  }
  const n = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({length:n}, () => runner()));
  return out;
}

function breakoutOpportunityFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < BREAKOUT_LOOKBACK + BREAKOUT_RETEST_LOOKBACK_5M + 8) return null;

  // Precision entry model:
  // 1) A CLOSED 5m candle must break the previous N-candle high/low.
  // 2) The next few closed candles must pull back to that broken level.
  // 3) The current closed candle must reclaim the level in the same direction.
  // This prevents buying the top of an extended breakout and prevents a SHORT
  // signal from being converted into a LONG order.
  const closed = candles.slice(0, -1);
  const current = closed[closed.length - 1];
  const atr14 = atr(closed, 14);
  if (!current || !(atr14 > 0)) return null;

  const evaluateRetest = (direction, breakoutCandle, prior, level, breakoutIdx) => {
    if (!breakoutCandle || !prior?.length || !(level > 0)) return null;
    const bq = candleQuality(breakoutCandle);
    const cq = candleQuality(current);
    const range = Math.max(1e-12, Number(current.high) - Number(current.low));
    const avgVol = averageVolume(prior, Math.min(20, prior.length));
    const breakoutVol = Number(breakoutCandle.volume) || 0;
    const volumeRatio = avgVol > 0 ? breakoutVol / avgVol : 0;
    const breakoutBody = Math.abs(Number(breakoutCandle.close) - Number(breakoutCandle.open));
    const breakoutBodyAtr = atr14 > 0 ? breakoutBody / atr14 : 0;
    const reclaimBuffer = Math.max(BREAKOUT_RETEST_TOLERANCE_PCT * 0.20, ENTRY_PULLBACK_RECLAIM_BUFFER_PCT);
    const touchTol = BREAKOUT_RETEST_TOLERANCE_PCT;

    let touched = false;
    let retestExtreme = null;
    if (direction === "LONG") {
      touched = Number(current.low) <= level * (1 + touchTol);
      retestExtreme = Number(current.low);
    } else {
      touched = Number(current.high) >= level * (1 - touchTol);
      retestExtreme = Number(current.high);
    }
    const reclaimPass = direction === "LONG"
      ? Boolean(cq.bullish) && Number(current.close) > level * (1 + reclaimBuffer)
      : Boolean(cq.bearish) && Number(current.close) < level * (1 - reclaimBuffer);

    const closeLocation = direction === "LONG"
      ? (Number(current.close) - Number(current.low)) / range
      : (Number(current.high) - Number(current.close)) / range;
    const retestBodyPass = cq.bodyPct >= Math.max(ENTRY_TRIGGER_MIN_BODY_PCT, 0.30);
    const retestClosePass = closeLocation >= Math.max(BREAKOUT_CLOSE_LOCATION_MIN, 0.70);
    const volumePass = !BREAKOUT_REQUIRE_VOLUME || volumeRatio >= BREAKOUT_VOLUME_MULTIPLIER;
    const breakoutBodyPass = breakoutBodyAtr >= BREAKOUT_MIN_BODY_ATR && bq.bodyPct >= BREAKOUT_MIN_BODY_RATIO;
    if (!volumePass || !breakoutBodyPass) return null;

    // Preferred path: pullback/retest + reclaim.
    // Fallback path: if the breakout remains confirmed and the market has not
    // overextended, allow the next closed candle to continue beyond the level.
    // This is deliberately still closed-candle based; live candles remain off.
    const retestPass = touched && reclaimPass && retestBodyPass && retestClosePass;
    const continuationPass = !REQUIRE_BREAKOUT_RETEST &&
      !retestPass &&
      ((direction === "LONG" && Boolean(cq.bullish) && Number(current.close) > level * (1 + reclaimBuffer)) ||
       (direction === "SHORT" && Boolean(cq.bearish) && Number(current.close) < level * (1 - reclaimBuffer))) &&
      cq.bodyPct >= Math.max(ENTRY_TRIGGER_MIN_BODY_PCT, 0.20) &&
      closeLocation >= Math.max(0.60, BREAKOUT_CLOSE_LOCATION_MIN - 0.10);
    if (!retestPass && !continuationPass) return null;

    const swingWindow = closed.slice(Math.max(0, closed.length - 10), closed.length);
    const swingLow = Math.min(...swingWindow.map(c => Number(c.low)));
    const swingHigh = Math.max(...swingWindow.map(c => Number(c.high)));
    const extensionAtr = direction === "LONG"
      ? Math.max(0, (Number(current.close) - level) / atr14)
      : Math.max(0, (level - Number(current.close)) / atr14);
    if (extensionAtr > BREAKOUT_MAX_EXTENSION_ATR) return null;

    // Score the breakout and the reclaim separately. A high score without a
    // retest is never enough to create a live order.
    let score = retestPass ? 40 : 38;
    if (volumeRatio >= BREAKOUT_VOLUME_MULTIPLIER) score += 15;
    if (volumeRatio >= BREAKOUT_VOLUME_MULTIPLIER * 1.35) score += 5;
    if (breakoutBodyAtr >= BREAKOUT_MIN_BODY_ATR) score += 10;
    if (bq.bodyPct >= 0.60) score += 5;
    if (closeLocation >= 0.85) score += 10;
    if (cq.bodyPct >= 0.50) score += 5;
    if (extensionAtr <= BREAKOUT_MAX_EXTENSION_ATR * 0.50) score += 10;
    score = Math.min(100, score);

    const counterWickPct = direction === "LONG" ? cq.upperWickPct : cq.lowerWickPct;
    let precisionScore = score;
    if (counterWickPct <= 0.20) precisionScore += 7;
    else if (counterWickPct <= 0.30) precisionScore += 3;
    else if (counterWickPct >= 0.45) precisionScore -= 7;
    precisionScore = Math.max(0, Math.min(100, precisionScore));

    return {
      signal: score >= BREAKOUT_MIN_SCORE ? direction : "WAIT",
      direction,
      score,
      precisionScore,
      price:Number(current.close),
      atr:atr14,
      volumeRatio,
      rawVolumeRatio:volumeRatio,
      breakoutLevel:level,
      breakoutDistancePct:direction === "LONG"
        ? (Number(breakoutCandle.close) - level) / level
        : (level - Number(breakoutCandle.close)) / level,
      extensionAtr,
      bodyAtr:breakoutBodyAtr,
      bodyPct:cq.bodyPct,
      upperWickPct:cq.upperWickPct,
      lowerWickPct:cq.lowerWickPct,
      counterWickPct,
      closeLocation,
      candleTime:current.time,
      breakoutCandleTime:breakoutCandle.time,
      resistance:direction === "LONG" ? level : Math.max(...prior.map(c => Number(c.high))),
      support:direction === "SHORT" ? level : Math.min(...prior.map(c => Number(c.low))),
      swingLow,
      swingHigh,
      pullbackLow: direction === "LONG" ? retestExtreme : null,
      pullbackHigh: direction === "SHORT" ? retestExtreme : null,
      confirmed:true,
      volumePass,
      bodyPass:breakoutBodyPass,
      directionSpecificPass:true,
      early:false,
      retestConfirmed:retestPass,
      retestExtreme,
      entryMode:retestPass ? "BREAKOUT_RETEST" : "BREAKOUT_CONTINUATION",
      reason:retestPass
        ? `${direction} confirmed 5m breakout → pullback/retest → reclaim`
        : `${direction} confirmed closed 5m breakout continuation (retest not present)`,
      pullbackEntryPass:retestPass
    };
  };

  // Search only a recent breakout window. The entry is the current reclaim
  // candle, not the original breakout candle.
  for (let barsAgo = 1; barsAgo <= BREAKOUT_RETEST_LOOKBACK_5M; barsAgo++) {
    const idx = closed.length - 1 - barsAgo;
    if (idx < BREAKOUT_LOOKBACK) continue;
    const breakoutCandle = closed[idx];
    const prior = closed.slice(idx - BREAKOUT_LOOKBACK, idx);
    if (prior.length < BREAKOUT_LOOKBACK) continue;

    const resistance = Math.max(...prior.map(c => Number(c.high)));
    const support = Math.min(...prior.map(c => Number(c.low)));
    const longBreak = Number(breakoutCandle.close) > resistance * (1 + BREAKOUT_BUFFER_PCT) && candleQuality(breakoutCandle).bullish;
    const shortBreak = Number(breakoutCandle.close) < support * (1 - BREAKOUT_BUFFER_PCT) && candleQuality(breakoutCandle).bearish;

    if (longBreak) {
      const result = evaluateRetest("LONG", breakoutCandle, prior, resistance, idx);
      if (result?.signal === "LONG") return result;
    }
    if (shortBreak) {
      const result = evaluateRetest("SHORT", breakoutCandle, prior, support, idx);
      if (result?.signal === "SHORT") return result;
    }
  }

  return {
    signal:"WAIT",
    direction:"WAIT",
    score:0,
    precisionScore:0,
    price:Number(current.close),
    atr:atr14,
    volumeRatio:0,
    rawVolumeRatio:0,
    breakoutLevel:null,
    breakoutDistancePct:0,
    extensionAtr:0,
    bodyAtr:0,
    bodyPct:0,
    upperWickPct:0,
    lowerWickPct:0,
    counterWickPct:0,
    closeLocation:0,
    candleTime:current.time,
    resistance:null,
    support:null,
    swingLow:null,
    swingHigh:null,
    confirmed:false,
    volumePass:false,
    bodyPass:false,
    directionSpecificPass:false,
    early:false,
    retestConfirmed:false,
    reason:"No confirmed 5m breakout followed by a pullback/retest reclaim"
  };
}


function fallbackMomentumOpportunity(candles) {
  // v34.4.14 STRICT PULLBACK ENTRY:
  // This path is not a no-pullback fallback. It is a closed-5m
  // pullback -> momentum reclaim setup used when the breakout/retest scanner
  // does not find a qualifying broken-level retest.
  if (!Array.isArray(candles) || candles.length < 100) return null;
  const closed = candles.slice(0, -1);
  const current = closed[closed.length - 1];
  const a = atr(closed, 14);
  if (!current || !(a > 0)) return null;

  const closes = closed.map(c => Number(c.close));
  const e9s = emaSeries(closes, 9);
  const e21s = emaSeries(closes, 21);
  const e50s = emaSeries(closes, 50);
  const e200s = emaSeries(closes, 200);
  const i = closed.length - 1;
  const e9 = Number(e9s[i]);
  const e21 = Number(e21s[i]);
  const e50 = Number(e50s[i]);
  const e200 = Number(e200s[i]);
  if (![e9, e21, e50, e200].every(Number.isFinite)) return null;

  const q = candleQuality(current);
  const range = Math.max(1e-12, Number(current.high) - Number(current.low));
  const closeLong = (Number(current.close) - Number(current.low)) / range;
  const closeShort = (Number(current.high) - Number(current.close)) / range;
  const avgVol = averageVolume(closed.slice(-21, -1), 20);
  const volumeRatio = avgVol > 0 ? (Number(current.volume) || 0) / avgVol : 0;
  const bodyAtr = Math.abs(Number(current.close) - Number(current.open)) / a;
  const distE21 = Math.abs(Number(current.close) - e21) / a;

  const longTrend = Number(current.close) > e9 && e9 > e21 && e21 > e50 && Number(current.close) > e200;
  const shortTrend = Number(current.close) < e9 && e9 < e21 && e21 < e50 && Number(current.close) < e200;
  if (!longTrend && !shortTrend) return null;

  const direction = longTrend ? 'LONG' : 'SHORT';
  const pullback = detectPullbackRetest(closed, e21, e50, a, direction);
  const pullbackBars = Number(pullback?.barsSinceTouch);
  const pullbackDepth = Number(pullback?.pullbackDepthAtr || 0);
  const pullbackPass = Boolean(pullback?.confirmed) &&
    Number.isFinite(pullbackBars) && pullbackBars <= ENTRY_TRIGGER_PULLBACK_MAX_BARS &&
    pullbackDepth >= ENTRY_TRIGGER_MIN_PULLBACK_DEPTH_ATR;
  if (!pullbackPass) return null;

  // The current CLOSED candle is the momentum/reclaim trigger. A weak candle,
  // weak volume or poor close location cannot trigger an order after a pullback.
  const momentumPass = volumeRatio >= ENTRY_MOMENTUM_MIN_VOLUME &&
    bodyAtr >= ENTRY_MOMENTUM_MIN_BODY_ATR &&
    (direction === 'LONG' ? q.bullish && closeLong >= ENTRY_MOMENTUM_CLOSE_LOCATION
                           : q.bearish && closeShort >= ENTRY_MOMENTUM_CLOSE_LOCATION);
  if (!momentumPass) return null;

  // Never chase an extended move away from EMA21 after the pullback.
  if (distE21 > ENTRY_TRIGGER_MAX_DISTANCE_ATR) return null;

  // Keep clear room to the next recent resistance/support. The current candle
  // is excluded so a new high/low cannot falsely report its own level as room.
  const srWindow = closed.slice(Math.max(0, closed.length - SR_LOOKBACK - 1), -1);
  if (srWindow.length < 10) return null;
  const recentResistance = Math.max(...srWindow.map(c => Number(c.high)));
  const recentSupport = Math.min(...srWindow.map(c => Number(c.low)));
  const roomAtr = direction === 'LONG'
    ? (recentResistance - Number(current.close)) / a
    : (Number(current.close) - recentSupport) / a;
  if (roomAtr < ENTRY_SR_MIN_ROOM_ATR) return null;

  // Additional anti-pump guard: do not enter if the trigger candle itself is
  // abnormally large. The move must be a controlled reclaim, not a chase.
  if (bodyAtr >= VOLATILITY_SPIKE_ATR_MULTIPLIER) return null;

  let score = 64;
  if (volumeRatio >= 1.00) score += 6;
  if (volumeRatio >= 1.25) score += 5;
  if (bodyAtr >= 0.15) score += 4;
  if (bodyAtr >= 0.25) score += 4;
  if ((direction === 'LONG' ? closeLong : closeShort) >= 0.70) score += 5;
  if (distE21 <= 0.75) score += 4;
  if (pullbackDepth >= 0.50) score += 5;
  if (roomAtr >= 1.00) score += 3;
  score = Math.min(100, score);

  const counterWickPct = direction === 'LONG' ? q.upperWickPct : q.lowerWickPct;
  let precisionScore = score;
  if (counterWickPct <= 0.20) precisionScore += 7;
  else if (counterWickPct <= 0.30) precisionScore += 3;
  else if (counterWickPct >= 0.45) precisionScore -= 7;
  precisionScore = Math.max(0, Math.min(100, precisionScore));

  const recent = closed.slice(Math.max(0, closed.length - 12), closed.length);
  const breakoutLevel = direction === 'LONG'
    ? Math.max(...recent.slice(0, -1).map(c => Number(c.high)))
    : Math.min(...recent.slice(0, -1).map(c => Number(c.low)));
  const swingLow = Math.min(...recent.map(c => Number(c.low)));
  const swingHigh = Math.max(...recent.map(c => Number(c.high)));

  return {
    signal: direction,
    direction,
    score,
    precisionScore,
    price: Number(current.close),
    atr: a,
    volumeRatio,
    rawVolumeRatio: volumeRatio,
    breakoutLevel,
    breakoutDistancePct: 0,
    extensionAtr: distE21,
    bodyAtr,
    bodyPct: q.bodyPct,
    upperWickPct: q.upperWickPct,
    lowerWickPct: q.lowerWickPct,
    counterWickPct,
    closeLocation: direction === 'LONG' ? closeLong : closeShort,
    candleTime: current.time,
    breakoutCandleTime: current.time,
    resistance: recentResistance,
    support: recentSupport,
    swingLow,
    swingHigh,
    confirmed: true,
    volumePass: true,
    bodyPass: true,
    directionSpecificPass: true,
    early: false,
    retestConfirmed: false,
    pullbackEntryPass: true,
    pullbackTriggerPass: true,
    pullbackType: pullback.type,
    pullbackDepthAtr: pullbackDepth,
    pullbackBarsAgo: pullbackBars,
    resistanceRoomAtr: roomAtr,
    entryMode: '5M_PULLBACK_MOMENTUM_RECLAIM',
    reason: `${direction} closed 5m pullback + momentum reclaim; ${roomAtr.toFixed(2)} ATR room to next S/R`
  };
}

function fastOpportunityScore(candles, stats={}) {
  const breakout = breakoutOpportunityFromCandles(candles);
  const b = (breakout && breakout.signal !== "WAIT") ? breakout : fallbackMomentumOpportunity(candles);
  if (!b) return null;
  const safePrecisionScore = Number.isFinite(Number(b.precisionScore))
    ? Math.max(0, Math.min(100, Number(b.precisionScore)))
    : Math.max(0, Math.min(100, Number(b.score) || 0));
  return {
    direction: b.signal,
    score: b.score,
    precisionScore: safePrecisionScore,
    price: b.price,
    atr: b.atr,
    volumeRatio: b.volumeRatio,
    breakoutLevel: b.breakoutLevel,
    breakoutDistancePct: b.breakoutDistancePct,
    extensionAtr: b.extensionAtr,
    bodyAtr: b.bodyAtr,
    closeLocation: b.closeLocation,
    candleTime: b.candleTime,
    confirmed: b.confirmed,
    reason: b.reason
  };
}

async function getFastCandles(symbol) {
  const key = `${symbol}:FAST5`;
  const ttl = 15 * 1000;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.time < ttl) return cached.data;
  const end = Date.now();
  const bars = 140;
  const start = end - (bars + 5) * 5 * 60 * 1000;
  const data = await mexc("GET", "/api/v1/contract/kline/" + symbol, {
    interval:"Min5", start:Math.floor(start/1000), end:Math.floor(end/1000)
  });
  const candles = normalizeCandles(data).sort((a,b)=>a.time-b.time);
  candleCache.set(key,{time:Date.now(),data:candles});
  return candles;
}

async function fullUniverseFastScan(symbols) {
  const rows = await mapWithConcurrency(symbols, FAST_SCAN_CONCURRENCY, async symbol => {
    const candles = await getFastCandles(symbol);
    const fast = fastOpportunityScore(candles, marketStatsCache.stats[symbol] || {});
    if (!fast) return {symbol,signal:"WAIT",score:0,reason:"insufficient 5m data"};
    return {symbol,signal:fast.direction,score:fast.score,fast};
  });
  return rows.filter(Boolean);
}

async function selectDeepCandidates(symbols) {
  // Full-universe opportunity discovery happens every cycle. Only the most
  // promising 5m structures are promoted to expensive multi-timeframe analysis.
  // This prevents a 1068-symbol universe from becoming a serial 5000+ request
  // bottleneck while still giving every active symbol a chance to surface.
  const fastRows = await fullUniverseFastScan(symbols);
  const errors = fastRows.filter(x => x?.error);
  const ranked = fastRows
    .filter(x => !x?.error && x.signal !== "WAIT" && Number.isFinite(Number(x.score)) && Number(x.score) >= 45)
    .sort((a,b)=>Number(b.score)-Number(a.score));
  const top = ranked.slice(0, DEEP_SCAN_CANDIDATES);
  return {fastRows, top, errorCount:errors.length, errorSamples:errors.slice(0,5).map(x=>x.error)};
}

async function selectScanSymbols() {
  const universe=await refreshActiveSymbols();
  const list=Array.isArray(universe) && universe.length ? universe : CORE_SYMBOLS;
  if(list.length<=SCAN_BATCH_SIZE) {
    scanCycle += 1;
    return list;
  }
  const start=scanCursor % list.length;
  const batch=[];
  for(let i=0;i<SCAN_BATCH_SIZE;i++) batch.push(list[(start+i)%list.length]);
  scanCursor=(start+SCAN_BATCH_SIZE)%list.length;
  scanCycle += 1;
  return batch;
}

async function autoTradeOnce() {
  // Watchdog: full-universe scans are processed in rotating deep-analysis batches.
  // Overlap is blocked, and a stale lock is cleared after the configured watchdog window.
  if (autoBusy) {
    const age = autoBusySince ? (Date.now() - autoBusySince) : 0;
    if (age > AUTO_RUN_STALE_MS) {
      console.log(`AUTO WATCHDOG: stale run lock cleared after ${Math.round(age/60000)}m`);
      autoBusy=false;
      autoBusySince=0;
    } else {
      return {skipped:true, reason:"auto run already in progress", busyAgeMs:age};
    }
  }
  autoBusy=true;
  autoBusySince=Date.now();
  lastAutoRun=new Date().toISOString();

  try {
    const management=await tradeManagerOnce();

    if(!AUTO_TRADING_ENABLED) return {skipped:true,reason:"AUTO_TRADING_ENABLED is false",management};
    if(!REAL_TRADING_ENABLED) return {skipped:true,reason:"REAL_TRADING_ENABLED is false",management};

    const managementBlocked=Array.isArray(management?.results) && management.results.some(r=>
      r?.critical || r?.emergencyClose || r?.action==="MANAGER_ERROR" || r?.action==="MANAGEMENT_ERROR"
    );
    if(managementBlocked) return {skipped:true,reason:"Trade manager protection error; new entry blocked",management};

    const open=await openPositionCount();
    if(open>=MAX_OPEN_POSITIONS) return {skipped:true,reason:`Maximum open positions reached (${MAX_OPEN_POSITIONS})`,management};

    const symbols=await selectScanSymbols();
    const checked=[];

    // Full-universe fast discovery: every active USDT perpetual gets a fresh
    // 5m opportunity check on every cycle. Only the strongest structures are
    // promoted to the expensive 5m/15m/30m/1h/4h confirmation engine.
    const fastScan = await selectDeepCandidates(symbols);
    const candidates=[];
    const signalCacheForCycle=new Map();
    const deepRows = await mapWithConcurrency(fastScan.top, 6, async item => {
      const sig=await getAdvancedSignal(item.symbol);
      signalCacheForCycle.set(item.symbol,sig);
      return {item,sig};
    });
    for (const row of deepRows) {
      if (!row || row.error) {
        checked.push({symbol:row?.item?.symbol || null,error:row?.error || "deep scan failed"});
        continue;
      }
      const {item,sig}=row;
      checked.push({symbol:item.symbol,signal:sig?.signal,score:sig?.score??item.score,reason:sig?.reason??null,candleTime:sig?.candleTime,fastScore:item.score});
      if(sig?.signal!=="WAIT") candidates.push({symbol:item.symbol,signal:sig.signal,score:sig.score||0,precisionScore:sig.precisionScore??sig.score??0,candleTime:sig.candleTime,fastScore:item.score,fastPrecisionScore:item.precisionScore??item.score});
    }
    candidates.sort((a,b)=>Number(b.precisionScore)-Number(a.precisionScore) || Number(b.score)-Number(a.score));

    // Keep the best three opportunities visible even if final live preflight
    // rejects one. The scanner must never manufacture a trade merely to reach 3.

    // Always expose the strongest WAIT setups too. This makes it possible to
    // diagnose a quiet cycle instead of seeing only “No precision signal”.
    const nearCandidates = checked
      .filter(x => Number.isFinite(Number(x.score)) && Number(x.score) > 0)
      .sort((a,b) => (Number(b.score)-Number(a.score)))
      .slice(0,5);

    // Detailed diagnostics are intentionally limited to the strongest 5 setups.
    // The full universe is scanned over rotating batches; diagnostics stay small
    // so the status endpoint remains usable on mobile.
    const top3Diagnostic = nearCandidates.slice(0,3).map(row => {
      const sig=signalCacheForCycle.get(row.symbol);
      const q=sig?.quality || {};
      const direction=sig?.signal === "LONG" || sig?.signal === "SHORT" ? sig.signal : (sig?.directionScores?.LONG >= sig?.directionScores?.SHORT ? "LONG" : "SHORT");
      const b=sig?.breakout || {};
      return {
        symbol:row.symbol, signal:sig?.signal||row.signal, score:sig?.score??row.score, precisionScore:sig?.precisionScore??row.precisionScore??row.score, direction, reason:sig?.reason||row.reason, candleTime:sig?.candleTime,
        checks:{
          breakoutOnly:Boolean(q.breakoutOnly),
          momentumFallback:Boolean(sig?.breakout?.fallbackMomentum || sig?.fallbackMomentum),
          breakoutConfirmed:Boolean(q.breakoutConfirmed),
          breakoutVolumePass:Boolean(q.breakoutVolumePass),
          breakoutBodyPass:Boolean(q.breakoutBodyPass),
          breakoutExtensionPass:Boolean(q.breakoutExtensionPass),
          scoreMin:Number(sig?.score||0) >= BREAKOUT_MIN_SCORE,
          strictTriggerPass:Boolean(q.strictTriggerPass),
          lateEntryRisk:!Boolean(q.lateEntryRisk),
          riskRewardOk:Number(q.riskReward||0) >= Number(q.minRiskReward||MIN_RISK_REWARD),
          stopDistanceOk:Boolean(q.stopDistanceOk),
          volatilityOk:!Boolean(q.volatilitySpike),
          newsOk:!(sig?.newsRisk?.marketBlocked || sig?.newsRisk?.coinCritical)
        },
        values:{
          breakoutLevel:b.level ?? null,
          breakoutDistancePct:b.distancePct ?? null,
          breakoutExtensionAtr:b.extensionAtr ?? null,
          breakoutVolumeRatio:b.volumeRatio ?? null,
          breakoutBodyAtr:b.bodyAtr ?? null,
          closeLocation:b.closeLocation ?? null,
          lookback:b.lookback ?? BREAKOUT_LOOKBACK,
          riskReward:q.riskReward ?? 0,
          minRiskReward:q.minRiskReward ?? MIN_RISK_REWARD
        }
      };
    });

    // Only the strongest candidates reach the expensive live preflight/risk gate.
    const preflightFailures=[];
    for(const candidate of candidates.slice(0,5)){
      try{
        const pf=await preflight(candidate.symbol);
        const signal=pf.signal;
        if (!pf.ready) {
          console.log("ENTRY PREFLIGHT BLOCK", JSON.stringify({
            symbol:candidate.symbol, requestedSignal:candidate.signal, liveSignal:signal?.signal||null,
            readyReason:pf.readyReason, balanceOk:pf.balanceOk, sizingOk:pf.sizingOk,
            openTypeOk:pf.openTypeOk, configuredOpenType:pf.configuredOpenType,
            actualOpenType:pf.actualOpenType, leverageOk:pf.leverageOk,
            positionModeOk:pf.positionModeOk, actualPositionMode:pf.actualPositionMode,
            noOpenPosition:pf.noOpenPosition, noOpenOrders:pf.noOpenOrders, noPlanOrders:pf.noPlanOrders
          }));
        }
        if(!pf.ready || signal?.signal!==candidate.signal){
          preflightFailures.push({symbol:candidate.symbol, signal:candidate.signal, ready:pf.ready, readyReason:pf.readyReason, liveSignal:signal?.signal || null, balanceOk:pf.balanceOk, sizingOk:pf.sizingOk, leverageOk:pf.leverageOk, openTypeOk:pf.openTypeOk, positionModeOk:pf.positionModeOk});
          const row=checked.find(x=>x.symbol===candidate.symbol);
          if(row) row.preflight={ready:pf.ready,readyReason:pf.readyReason,liveSignal:signal?.signal || null};
          continue;
        }

        const riskGate=await entryRiskGate(candidate.symbol,signal.signal);
        if(!riskGate.ok){
          preflightFailures.push({symbol:candidate.symbol, signal:candidate.signal, riskBlocked:riskGate.reason});
          const row=checked.find(x=>x.symbol===candidate.symbol);
          if(row) row.riskBlocked=riskGate.reason;
          continue;
        }

        const candleKey=`${candidate.symbol}:${signal.candleTime}:${signal.signal}`;
        if(lastTradeSignalCandle.get(candidate.symbol)===candleKey) continue;

        // Final direction invariant: the signal that passed preflight must be
        // the exact direction sent to MEXC. Never infer/flip the side here.
        if(signal?.signal !== candidate.signal || !["LONG","SHORT"].includes(signal?.signal)) {
          const row=checked.find(x=>x.symbol===candidate.symbol);
          if(row) row.preflightError="FINAL DIRECTION MISMATCH - ORDER BLOCKED";
          continue;
        }
        const result=await placeMarketOrder(candidate.symbol,signal.signal);
        if(result?.success){
          lastTradeSignalCandle.set(candidate.symbol,candleKey);
          resetDailyRiskState();
          tradeRiskState.tradesToday+=1;
          tradeRiskState.lastEntryAt=Date.now();
          savePersistentState();
        }
        return {
          traded:true,symbol:candidate.symbol,direction:signal.signal,
          candleTime:signal.candleTime,score:signal.score,
          universeSymbols:ALLOWED_SYMBOLS.length,scanBatchSize:SCAN_BATCH_SIZE,scanCycle,
          fastScannedSymbols:fastScan.fastRows.filter(x=>!x?.error).length,fastScanErrorCount:fastScan.errorCount||0,fastScanErrorSamples:fastScan.errorSamples||[],deepScannedSymbols:fastScan.top.length,
          fastTop3:fastScan.top.slice(0,3),
          checked,candidates:candidates.slice(0,10),nearCandidates,top3Diagnostic,management,result
        };
      }catch(e){
        const row=checked.find(x=>x.symbol===candidate.symbol);
        if(row) row.preflightError=e.message;
      }
    }

    const topRows=candidates.slice(0,5).map(c=>checked.find(x=>x.symbol===c.symbol)||c);
    return {
      skipped:true,
      reason:candidates.length ? "Top quality signals failed final preflight/risk gate" : "No quality 5m momentum/breakout candidate passed the scanner",
      preflightFailures:preflightFailures.slice(0,5),
      scannedSymbols:symbols.length,
      universeSymbols:ALLOWED_SYMBOLS.length,
      scanBatchSize:SCAN_BATCH_SIZE,
      scanCycle,
      scanCoveragePct:ALLOWED_SYMBOLS.length ? 100 : 0,
      fastScannedSymbols:fastScan.fastRows.filter(x=>!x?.error).length,fastScanErrorCount:fastScan.errorCount||0,fastScanErrorSamples:fastScan.errorSamples||[],deepScannedSymbols:fastScan.top.length,
      fastTop3:fastScan.top.slice(0,3),
      candidates:candidates.slice(0,10),
      nearCandidates,
      topCandidateChecks:topRows,
      top3Diagnostic,
      checked,
      management
    };
  }catch(e){
    return {error:true,message:e.message};
  }finally{
    autoBusy=false;
    autoBusySince=0;
  }
}


app.get("/", (req,res) => res.json({
  service:"mexc-futures-trading-bot",
  version:BOT_VERSION,
  symbol:SYMBOL,
  realTradingEnabled:REAL_TRADING_ENABLED,
  autoTradingEnabled:AUTO_TRADING_ENABLED
}));

app.get("/health", (req,res) => res.json({
  success:true,
  version:"34.4.14-strict-pullback-risk-guard",
  credentialsConfigured:!!(ACCESS_KEY && SECRET_KEY),
  realTradingEnabled:REAL_TRADING_ENABLED,
  autoTradingEnabled:AUTO_TRADING_ENABLED,
  maxOrderUSDT:MAX_ORDER_USDT,
  adaptiveOrderSize:ADAPTIVE_ORDER_SIZE,
  orderBalanceReserveUSDT:ORDER_BALANCE_RESERVE_USDT,
  minAdaptiveOrderUSDT:MIN_ADAPTIVE_ORDER_USDT,
  targetLeverage:TARGET_LEVERAGE,
  tradeManagerEnabled:TRADE_MANAGER_ENABLED,
  tradeManagerIntervalSeconds:TRADE_MANAGER_INTERVAL_SECONDS,
  allowedSymbols:ALLOWED_SYMBOLS,
  minSignalScore:MIN_SIGNAL_SCORE, minScoreEdge:MIN_SCORE_EDGE, scanSymbols:SCAN_SYMBOLS,
  adaptiveOrderSize:ADAPTIVE_ORDER_SIZE, orderBalanceReserveUSDT:ORDER_BALANCE_RESERVE_USDT,
  analysisTimeframes:ANALYSIS_TIMEFRAMES, breakoutOnly:false, entryMode:ENTRY_MODE_NAME, recoveryProtection:true, positionMode:CONFIGURED_POSITION_MODE, openType:CONFIGURED_OPEN_TYPE,
  symbolLimit:SYMBOL_LIMIT,
  tradingSymbols:CORE_SYMBOLS,
  newsRiskEnabled:NEWS_RISK_ENABLED,
  maxOpenPositions:MAX_OPEN_POSITIONS,
    maxSameDirectionPositions:MAX_SAME_DIRECTION_POSITIONS,
  maxTradesPerDay:MAX_TRADES_PER_DAY,
  dailyDrawdownProtectionEnabled:DAILY_DRAWDOWN_PROTECTION_ENABLED,
  liquidityMin24hUSDT:LIQUIDITY_MIN_24H_USDT,
  maxSpreadPct:MAX_SPREAD_PCT,
  mexcMinRequestGapMs:MEXC_MIN_REQUEST_GAP_MS,
  mexcMaxRetries:MEXC_MAX_RETRIES,
  candleCacheTtlsMs:CANDLE_CACHE_TTL_MS
}));

app.get("/api/signal", async (req,res) => {
  try { res.json({success:true, ...(await getSignal(req.query.symbol || SYMBOL, req.query.interval || INTERVAL))}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/signals", async (req,res) => {
  try {
    await refreshActiveSymbols();
    const results = [];
    for (const symbol of ALLOWED_SYMBOLS) {
      try {
        results.push(await getSignal(symbol, req.query.interval || INTERVAL));
      } catch (e) {
        results.push({ symbol, signal:"ERROR", error:e.message });
      }
    }
    res.json({ success:true, interval:req.query.interval || INTERVAL, symbols:ALLOWED_SYMBOLS, results });
  } catch(e) {
    res.status(500).json({success:false,error:e.message});
  }
});

app.get("/api/preflight", requireAdmin, async (req,res) => {
  try { res.json(await preflight(req.query.symbol || SYMBOL)); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/preflight-all", requireAdmin, async (req,res) => {
  try {
    // Safety/performance: the dynamic universe can contain hundreds of symbols.
    // Running a full preflight for every symbol can exceed Railway's request timeout.
    // By default, check only the first 5 symbols; callers can request specific symbols
    // or a larger bounded batch with ?symbols=A,B,C or ?limit=N (max 20).
    const requested = String(req.query.symbols || "")
      .split(",")
      .map(x => x.trim().toUpperCase())
      .filter(Boolean);

    const parsedLimit = Number.parseInt(req.query.limit || "5", 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 20) : 5;

    let universe = ALLOWED_SYMBOLS;
    if (requested.length) {
      universe = requested.filter(symbol => ALLOWED_SYMBOLS.includes(symbol));
      if (!universe.length) {
        return res.status(400).json({
          success:false,
          error:"No requested symbols are in ALLOWED_SYMBOLS",
          requested,
          allowedSymbolsCount:ALLOWED_SYMBOLS.length
        });
      }
    } else {
      universe = ALLOWED_SYMBOLS.slice(0, limit);
    }

    const results = [];
    for (const symbol of universe.slice(0, limit)) {
      try { results.push(await preflight(symbol)); }
      catch (e) { results.push({ success:false, symbol, error:e.message }); }
    }

    res.json({
      success:true,
      checkedCount:results.length,
      availableSymbolsCount:ALLOWED_SYMBOLS.length,
      truncated:results.length < ALLOWED_SYMBOLS.length,
      results
    });
  } catch(e) {
    res.status(500).json({success:false,error:e.message});
  }
});

app.get("/api/order-preview", async (req,res) => {
  try {
    const symbol = String(req.query.symbol || SYMBOL).toUpperCase();
    const pf = await preflight(symbol);
    // Support both preflight shapes used across v32.x: signal as a string
    // ("LONG"/"SHORT"/"WAIT") or as an object ({signal, atr14, ...}).
    const signalObj = (pf.signal && typeof pf.signal === "object") ? pf.signal : null;
    const direction = String(signalObj?.signal ?? pf.signal ?? "WAIT").toUpperCase();
    const price = num(pf.price ?? signalObj?.price) || 0;
    const contract = pf.contract || {};
    const size = num(contract?.contractSize) || 0.1;
    const volume = num(pf.volume) || 0;
    const atr14 = num(pf.atr14 ?? signalObj?.atr14);

    let stopLossPrice = null;
    let takeProfitPrice = null;
    let targetPlan = null;
    if (price > 0 && (direction === "LONG" || direction === "SHORT")) {
      targetPlan = protectionPricesFor(direction, price, contract, atr14);
      stopLossPrice = targetPlan.stop;
      takeProfitPrice = targetPlan.take;
    }

    const notional = price * size * volume;
    const requiredMargin = pf.leverage ? notional / TARGET_LEVERAGE : notional / TARGET_LEVERAGE;

    res.json({
      success:true,
      symbol,
      liveTradingEnabled:REAL_TRADING_ENABLED,
      autoTradingEnabled:AUTO_TRADING_ENABLED,
      direction,
      reason:pf.signal?.reason || null,
      price,
      contractSize:size,
      minVol:num(contract?.minVol) || 1,
      volume,
      notional,
      requiredMargin,
      leverage:TARGET_LEVERAGE,
      marginMode:pf.isolatedMargin ? "ISOLATED" : "UNKNOWN",
      stopLossPrice,
      takeProfitPrice,
      stopLossPct:targetPlan?.stopPct ?? null,
      takeProfitPct:targetPlan?.tpPct ?? TAKE_PROFIT_PCT,
      riskReward:null,
      protectionPlanReady:Boolean(targetPlan && takeProfitPrice),
      manualStopLoss:MANUAL_STOP_LOSS,
      preflightReady:!!pf.ready,
      willPlaceOrder:false
    });
  } catch(e) {
    res.status(500).json({success:false,error:e.message});
  }
});

app.get("/api/account", requireAdmin, async (req,res) => {
  try { res.json(await getAccount()); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/positions", requireAdmin, async (req,res) => {
  try { res.json({success:true,data:await getPositions(req.query.symbol || SYMBOL)}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/symbols", async (req,res) => {
  await refreshActiveSymbols();
  res.json({success:true, source:symbolUniverseCache.source, updatedAt:symbolUniverseCache.time ? new Date(symbolUniverseCache.time).toISOString() : null, symbols:ALLOWED_SYMBOLS, removedFromCoreSymbols:symbolUniverseCache.removed});
});

app.get("/api/news-risk", async (req,res) => {
  try { res.json({success:true, ...(await refreshNewsRisk(true))}); }
  catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/config", (req,res) => res.json({
  success:true,
  version:"34.4.14-strict-pullback-risk-guard",
  defaults:{
    maxOrderUSDT:MAX_ORDER_USDT,
  adaptiveOrderSize:ADAPTIVE_ORDER_SIZE,
  orderBalanceReserveUSDT:ORDER_BALANCE_RESERVE_USDT,
  minAdaptiveOrderUSDT:MIN_ADAPTIVE_ORDER_USDT,
    targetLeverage:TARGET_LEVERAGE,
    stopLossPct:STOP_LOSS_PCT,
    takeProfitPct:TAKE_PROFIT_PCT,
    targetFirstMode:true,
    adaptiveTpEnabled:ADAPTIVE_TP_ENABLED,
    adaptiveTpStartPct:ADAPTIVE_TP_START_PCT,
    adaptiveTpMaxPct:ADAPTIVE_TP_MAX_PCT,
    adaptiveTpStepPct:ADAPTIVE_TP_STEP_PCT,
    adaptiveTpExtendTriggerPct:ADAPTIVE_TP_EXTEND_TRIGGER_PCT,
    targetFirstTpRangePct:{min:TARGET_FIRST_MIN_TP_PCT,max:TARGET_FIRST_MAX_TP_PCT},
    targetFirstAtrMultiplier:TARGET_FIRST_ATR_MULT,
    targetFirstMinTpPct:TARGET_FIRST_MIN_TP_PCT,
    targetFirstMaxTpPct:TARGET_FIRST_MAX_TP_PCT,
    targetFirstAtrMultiplier:TARGET_FIRST_ATR_MULT,
    interval:INTERVAL,
    autoIntervalMinutes:AUTO_INTERVAL_MINUTES,
    tradeManagerEnabled:TRADE_MANAGER_ENABLED,
    tradeManagerIntervalSeconds:TRADE_MANAGER_INTERVAL_SECONDS,
    breakEvenEnabled:BREAK_EVEN_ENABLED,
    breakEvenTriggerPct:BREAK_EVEN_TRIGGER_PCT,
    breakEvenOffsetPct:BREAK_EVEN_OFFSET_PCT,
    trailingStopEnabled:TRAILING_STOP_ENABLED,
    trailingTriggerPct:TRAILING_TRIGGER_PCT,
    trailingStopPct:TRAILING_STOP_PCT,
    minStopDistancePct:MIN_STOP_DISTANCE_PCT,
    minSignalScore:MIN_SIGNAL_SCORE, minScoreEdge:MIN_SCORE_EDGE, scanSymbols:SCAN_SYMBOLS,
  adaptiveOrderSize:ADAPTIVE_ORDER_SIZE, orderBalanceReserveUSDT:ORDER_BALANCE_RESERVE_USDT,
    analysisTimeframes:ANALYSIS_TIMEFRAMES, breakoutOnly:false, entryMode:ENTRY_MODE_NAME, recoveryProtection:true, positionMode:CONFIGURED_POSITION_MODE, openType:CONFIGURED_OPEN_TYPE,
    volumeMultiplier:VOLUME_MULTIPLIER,
    adxMin:ADX_MIN,
    supportResistanceLookback:SR_LOOKBACK,
    symbolLimit:SYMBOL_LIMIT,
  tradingSymbols:CORE_SYMBOLS,
    newsRiskEnabled:NEWS_RISK_ENABLED,
    newsRiskLookbackMinutes:NEWS_RISK_LOOKBACK_MINUTES,
    maxOpenPositions:MAX_OPEN_POSITIONS,
    maxSameDirectionPositions:MAX_SAME_DIRECTION_POSITIONS,
    maxTradesPerDay:MAX_TRADES_PER_DAY,
    dailyDrawdownProtectionEnabled:DAILY_DRAWDOWN_PROTECTION_ENABLED,
    maxDailyDrawdownPct:MAX_DAILY_DRAWDOWN_PCT,
    entryCooldownAllTrades:ENTRY_COOLDOWN_ALL_TRADES,
    entryCooldownMinutes:ENTRY_COOLDOWN_MINUTES,
    maxLossStreak:MAX_LOSS_STREAK,
    lossStreakCooldownMinutes:LOSS_STREAK_COOLDOWN_MINUTES,
    volatilitySpikeAtrMultiplier:VOLATILITY_SPIKE_ATR_MULTIPLIER,
    liquidityMin24hUSDT:LIQUIDITY_MIN_24H_USDT,
    maxSpreadPct:MAX_SPREAD_PCT,
    minRiskReward:MIN_RISK_REWARD,
    positionMode:CONFIGURED_POSITION_MODE,
    openType:CONFIGURED_OPEN_TYPE,
    botTimezone:BOT_TIMEZONE,
    adminTokenConfigured:Boolean(BOT_ADMIN_TOKEN),
    persistentStateFile:BOT_STATE_FILE,
    mexcMinRequestGapMs:MEXC_MIN_REQUEST_GAP_MS,
    mexcMaxRetries:MEXC_MAX_RETRIES,
    candleCacheTtlsMs:CANDLE_CACHE_TTL_MS,
    advancedSignalCacheTtlMs:ADVANCED_SIGNAL_CACHE_TTL_MS
  },
  allowedSymbols:ALLOWED_SYMBOLS,
  realTradingEnabled:REAL_TRADING_ENABLED,
  autoTradingEnabled:AUTO_TRADING_ENABLED,
  safetyNote:"VERSION 34.4.14-risk-guard-recovery-fixed. LIVE ENTRY: a meaningful pullback/retest plus a closed 5m directional reclaim is required; live/in-progress candles and no-pullback continuation entries are blocked. 15m/1h/1D alignment, score, precision, spread, slippage, liquidity, volatility and minimum R:R gates must pass. Direction is locked at preflight and order time. Structure SL uses swing + ATR buffer with a 0.50%-1.25% maximum distance under the default profile. Break-even activates at +1%, trailing activates at +2% and only moves the stop in the protective direction. No stop-hit probability or profit percentage is guaranteed.",
  targetFirstMode:true,
  symbolUniverse:{source:symbolUniverseCache.source, updatedAt:symbolUniverseCache.time ? new Date(symbolUniverseCache.time).toISOString() : null, count:ALLOWED_SYMBOLS.length, targetCount:null, scanBatchSize:SCAN_BATCH_SIZE, scanCycle, removedFromCoreSymbols:symbolUniverseCache.removed, marketRanked:symbolUniverseCache.marketRanked}
}));

app.get("/api/diagnostic", (req,res) => {
  const result=lastAutoResult || {};
  res.json({
    success:true,
    scannedSymbols:result.scannedSymbols ?? null,
    reason:result.reason ?? null,
    top5Diagnostic:Array.isArray(result.top5Diagnostic) ? result.top5Diagnostic : [],
    settings:{
      botVersion:BOT_VERSION,
      entryMode:ENTRY_MODE_NAME,
      recoveryProtection:true,
      minSignalScore:MIN_SIGNAL_SCORE,
      minScoreEdge:MIN_SCORE_EDGE,
      max15mEma21DistanceAtr:ENTRY_MAX_DISTANCE_E21_ATR,
      triggerMaxDistanceAtr:ENTRY_TRIGGER_MAX_DISTANCE_ATR,
      triggerMaxBars:ENTRY_TRIGGER_MAX_BARS,
      breakoutLookback:BREAKOUT_LOOKBACK,
      breakoutBufferPct:BREAKOUT_BUFFER_PCT,
      breakoutVolumeMultiplier:BREAKOUT_VOLUME_MULTIPLIER,
      breakoutMinBodyAtr:BREAKOUT_MIN_BODY_ATR,
      breakoutCloseLocationMin:BREAKOUT_CLOSE_LOCATION_MIN,
      breakoutMaxExtensionAtr:BREAKOUT_MAX_EXTENSION_ATR,
      earlyBreakoutEnabled:EARLY_BREAKOUT_ENABLED,
      earlyBreakoutVolumeMultiplier:EARLY_BREAKOUT_VOLUME_MULTIPLIER,
      earlyBreakoutMinBodyAtr:EARLY_BREAKOUT_MIN_BODY_ATR,
      earlyBreakoutMinBodyRatio:EARLY_BREAKOUT_MIN_BODY_RATIO,
      earlyBreakoutCloseLocationMin:EARLY_BREAKOUT_CLOSE_LOCATION_MIN,
      earlyBreakoutMaxExtensionAtr:EARLY_BREAKOUT_MAX_EXTENSION_ATR,
      earlyBreakoutMinScore:EARLY_BREAKOUT_MIN_SCORE,
      scanBatchSize:SCAN_BATCH_SIZE,
      universeCount:ALLOWED_SYMBOLS.length,
      scanCycle
    },
    busy:autoBusy,
    busyAgeMs:autoBusySince ? Math.max(0,Date.now()-autoBusySince) : 0,
    lastAutoRun
  });
});

app.get("/api/auto-status", (req,res) => res.json({
  success:true,
  autoTradingEnabled:AUTO_TRADING_ENABLED,
  realTradingEnabled:REAL_TRADING_ENABLED,
  lastAutoRun,
  lastAutoResult,
  busy:autoBusy,
  busyAgeMs:autoBusySince ? Math.max(0,Date.now()-autoBusySince) : 0,
  autoRunStaleMs:AUTO_RUN_STALE_MS,
  lastTradeSignalCandle:Object.fromEntries(lastTradeSignalCandle),
  riskState:resetDailyRiskState()
}));

app.get("/api/trade-manager-status", (req,res) => res.json({
  success:true,
  enabled:TRADE_MANAGER_ENABLED,
  realTradingEnabled:REAL_TRADING_ENABLED,
  intervalSeconds:TRADE_MANAGER_INTERVAL_SECONDS,
  breakEven:{enabled:BREAK_EVEN_ENABLED, triggerPct:BREAK_EVEN_TRIGGER_PCT, offsetPct:BREAK_EVEN_OFFSET_PCT},
  trailing:{enabled:TRAILING_STOP_ENABLED, triggerPct:TRAILING_TRIGGER_PCT, stopPct:TRAILING_STOP_PCT},
  minStopDistancePct:MIN_STOP_DISTANCE_PCT,
  lastRun:lastTradeManagerRun,
  lastResult:lastTradeManagerResult,
  busy:tradeManagerBusy,
  history:tradeManagerHistory
}));

async function getTradeStats(days=7, symbol="") {
  const safeDays=Math.min(90, Math.max(1, Number(days)||7));
  const sym=String(symbol||"").toUpperCase();
  const cacheKey=`${safeDays}:${sym}`;
  if (tradeStatsCache.value && tradeStatsCache.key===cacheKey && Date.now()-tradeStatsCache.time<TRADE_STATS_CACHE_TTL_MS) return tradeStatsCache.value;

  const end=Date.now();
  const start=end-safeDays*24*60*60*1000;
  const baseParams={start_time:start,end_time:end,page_num:1,page_size:100};
  if(sym) baseParams.symbol=sym;

  async function fetchPages(path, extra={}) {
    const out=[];
    let page=1;
    let totalPages=1;
    do {
      const data=await mexc("GET",path,{...baseParams,...extra,page_num:page},true);
      const payload=data?.data;
      const rows=Array.isArray(payload)?payload:(Array.isArray(payload?.resultList)?payload.resultList:[]);
      out.push(...rows);
      totalPages=Math.min(Number(payload?.totalPage)||1,10);
      page++;
    } while(page<=totalPages);
    return out;
  }

  const [positions, stopOrders] = await Promise.all([
    fetchPages("/api/v1/private/position/list/history_positions"),
    fetchPages("/api/v1/private/stoporder/list/orders",{is_finished:1})
  ]);

  const closedPositions=positions.filter(p=>Number(p?.state)===3 || Number(p?.closeVol||0)>0 || Number(p?.closeAvgPrice||0)>0);
  const longCount=closedPositions.filter(p=>Number(p?.positionType)===1).length;
  const shortCount=closedPositions.filter(p=>Number(p?.positionType)===2).length;
  const realizedPnl=closedPositions.reduce((sum,p)=>sum+(num(p?.realised)||0),0);

  // One position can have several protection records because the Trade Manager
  // may replace/update protection. Count only the executed terminal protection
  // per position so TP/SL numbers do not get inflated by old stop orders.
  const executedByPosition=new Map();
  for(const o of stopOrders){
    if(Number(o?.state)!==3 || Number(o?.isFinished)!==1) continue;
    const pid=String(o?.positionId||o?.id||"");
    if(!pid) continue;
    const trigger=Number(o?.triggerSide);
    if(trigger!==1 && trigger!==2) continue;
    const prev=executedByPosition.get(pid);
    const t=Number(o?.updateTime||o?.createTime||0);
    if(!prev || t>prev.time) executedByPosition.set(pid,{time:t,triggerSide:trigger,symbol:o?.symbol||null,positionId:o?.positionId||null});
  }
  const tpPositions=[...executedByPosition.values()].filter(x=>x.triggerSide===1);
  const slPositions=[...executedByPosition.values()].filter(x=>x.triggerSide===2);

  const positionMap=new Map(closedPositions.map(p=>[String(p?.positionId),p]));
  const tpCount=tpPositions.length;
  const slCount=slPositions.length;
  const classified=new Set([...tpPositions,...slPositions].map(x=>String(x.positionId)));
  const otherClosed=Math.max(0,closedPositions.length-classified.size);
  const totalClosed=closedPositions.length;
  const winRate=totalClosed?tpCount/totalClosed*100:0;

  const value={
    success:true,
    period:{days:safeDays,start:new Date(start).toISOString(),end:new Date(end).toISOString(),symbol:sym||"ALL"},
    totalClosed,
    tpCount,
    slCount,
    otherClosed,
    longCount,
    shortCount,
    realizedPnl:Number(realizedPnl.toFixed(8)),
    winRatePct:Number(winRate.toFixed(2)),
    note:"TP/SL counts come from MEXC executed stop-order history and are deduplicated by positionId. Other closes include manual/market/other closure reasons.",
    recent:closedPositions.slice(0,20).map(p=>({
      positionId:p?.positionId, symbol:p?.symbol, direction:Number(p?.positionType)===1?"LONG":Number(p?.positionType)===2?"SHORT":"UNKNOWN",
      realizedPnl:num(p?.realised), openAvgPrice:num(p?.openAvgPrice), closeAvgPrice:num(p?.closeAvgPrice),
      createTime:p?.createTime||null, updateTime:p?.updateTime||null,
      classification:executedByPosition.get(String(p?.positionId))?.triggerSide===1?"TP":executedByPosition.get(String(p?.positionId))?.triggerSide===2?"SL":"OTHER"
    }))
  };
  tradeStatsCache={time:Date.now(),key:cacheKey,value};
  return value;
}

app.get("/api/trade-stats", async (req,res) => {
  try {
    res.json(await getTradeStats(req.query.days||7, req.query.symbol||""));
  } catch(e) {
    res.status(500).json({success:false,error:e.message});
  }
});

app.post("/api/trade-manager-run", requireAdmin, async (req,res) => {
  try {
    const result = await tradeManagerOnce();
    lastTradeManagerResult=result;
    tradeManagerHistory=[{time:new Date().toISOString(),result}, ...tradeManagerHistory].slice(0,20);
    res.json(result);
  } catch(e) {
    res.status(500).json({success:false,error:e.message});
  }
});

app.post("/api/order", requireAdmin, async (req,res) => {
  try {
    const symbol=req.body?.symbol || SYMBOL;
    const side=req.body?.side;
    const result=await placeMarketOrder(symbol,side);
    res.json(result);
  } catch(e) {
    res.status(400).json({success:false,error:e.message});
  }
});

app.post("/api/auto-run", requireAdmin, async (req,res) => {
  const result=await autoTradeOnce();
  lastAutoResult=result;
  res.json(result);
});

loadPersistentState();
resetDailyRiskState();

app.listen(PORT, () => {
  console.log(`MEXC Futures Bot ${BOT_VERSION} listening on ${PORT}`);
  console.log(`Real trading: ${REAL_TRADING_ENABLED}`);
  console.log(`Auto trading: ${AUTO_TRADING_ENABLED}`);
  console.log("SCAN SETTINGS", JSON.stringify({scanBatchSize:SCAN_BATCH_SIZE, universeMin24hUSDT:UNIVERSE_MIN_24H_USDT, universeRefreshMs:SYMBOL_UNIVERSE_TTL_MS}));
  console.log("BREAKOUT SETTINGS", JSON.stringify({
    breakoutOnly: false,
    entryMode: ENTRY_MODE_NAME,
    recoveryProtection: true,
    lookback: BREAKOUT_LOOKBACK,
    bufferPct: BREAKOUT_BUFFER_PCT,
    volumeMultiplier: BREAKOUT_VOLUME_MULTIPLIER,
    minBodyAtr: BREAKOUT_MIN_BODY_ATR,
    minBodyRatio: BREAKOUT_MIN_BODY_RATIO,
    closeLocationMin: BREAKOUT_CLOSE_LOCATION_MIN,
    maxExtensionAtr: BREAKOUT_MAX_EXTENSION_ATR,
    minScore: BREAKOUT_MIN_SCORE
  }));
  refreshActiveSymbols(true).then(list => console.log("SYMBOL UNIVERSE", JSON.stringify({count:list.length, symbols:list}))).catch(e => console.log("SYMBOL UNIVERSE ERROR", e.message));

  // Entry scheduler. New entries still require BOTH auto and real-trading flags.
  setTimeout(async () => {
    const result = await autoTradeOnce();
    lastAutoResult = result;
    if (!result?.skipped) console.log("AUTO RESULT", JSON.stringify(result));
  }, 5000);

  setInterval(async () => {
    const result = await autoTradeOnce();
    lastAutoResult = result;
    if (!result?.skipped) console.log("AUTO RESULT", JSON.stringify(result));
  }, AUTO_INTERVAL_MINUTES * 60 * 1000);

  // Fast position-management loop. It is independent of the 5-minute signal
  // loop so an open trade is watched much more frequently.
  setTimeout(async () => {
    const result = await tradeManagerOnce();
    lastTradeManagerResult = result;
    tradeManagerHistory=[{time:new Date().toISOString(),result}, ...tradeManagerHistory].slice(0,20);
    if (!result?.skipped) console.log("TRADE MANAGER", JSON.stringify(result));
  }, 8000);

  setInterval(async () => {
    const result = await tradeManagerOnce();
    lastTradeManagerResult = result;
    tradeManagerHistory=[{time:new Date().toISOString(),result}, ...tradeManagerHistory].slice(0,20);
    if (!result?.skipped) console.log("TRADE MANAGER", JSON.stringify(result));
  }, TRADE_MANAGER_INTERVAL_SECONDS * 1000);
});
