MEXC Futures Auto Trading Bot v34.4.14 — STRICT PULLBACK + RISK GUARD

دا نسخه د ناوخته Pump/Top Entry د کمولو او د احتمالي تاوان د محدودولو لپاره سخت Entry او Risk Guard لري.

اصلي Entry شرطونه:
- یوازې د CLOSED 5m candle له تایید وروسته Entry؛ live/in-progress candle هېڅکله Entry نه جوړوي.
- Pullback/Retest REQUIRED دی؛ یوازې لوړ score، trend یا breakout د Entry لپاره کافي نه دی.
- د Pullback وروسته باید د 5m CLOSED candle کې directional momentum/reclaim تایید شي.
- د trigger candle حجم، body، close-location او volatility باید د safety thresholds پوره کړي.
- د نږدې Support/Resistance لپاره کافي ATR room باید موجود وي.
- له EMA21 څخه ډېر غځېدلی Entry بندېږي.
- breakout continuation پرته له pullback/retest څخه Entry نه شي جوړولی.
- 15m، 1h او 1D alignment د default profile له مخې REQUIRED دی.
- Minimum Signal Score = 80، Minimum Precision Score = 80، Minimum R:R = 1.60.

Position / Profit settings:
- Max Open Positions = 6
- Max Same Direction Positions = 6
- Initial TP = 2%
- Adaptive TP = فعال؛ د قوي momentum په صورت کې تر 4% پورې غځېدای شي.
- Leverage = 20x هدف؛ MEXC د contract د max leverage له مخې actual leverage محدودولای شي.

Automatic Stop Protection:
- Automatic structure-based SL اجباري دی.
- Default minimum structure SL distance = 0.50%.
- Default maximum structure SL distance = 1.25%.
- Break-even د +1% profit وروسته فعالېږي.
- Break-even offset = 0.20% د Entry په خوندي لوري.
- Trailing SL د +2% profit وروسته فعالېږي.
- Trailing distance = 0.80%.
- SL یوازې د ګټې/خوندیتوب په لوري حرکت کوي؛ شاته نه راګرځي.

Account-level Risk Guard:
- Daily Drawdown Protection = ENABLED by default.
- که د ورځې له پیل equity څخه 3% drawdown ته ورسېږي، نوي Tradeونه بندېږي.
- موجود positions نه force-close کېږي؛ هغوی د خپل automatic SL/Trade Manager لاندې پاتې کېږي.
- Max Trades Per Day = 12.
- Max Loss Streak = 2 مسلسل تاوانونه.
- Loss-streak cooldown = 60 دقیقې.
- Entry cooldown = 20 دقیقې د هر نوي Entry ترمنځ.
- Spread protection = 0.15%.
- Entry slippage protection = 0.25%.
- Liquidity، volatility او news-risk filters هم فعال دي.

Railway:
- Dockerfile د Node 20 Alpine کاروي.
- Runtime secrets/config باید د Railway Variables له لارې ورکړل شي.
- .env.example یوازې template دی؛ secrets پکې مه اچوئ.

مهمه یادونه:
دا safety guards د تاوان یا ګټې تضمین نه کوي. هدف یې د کم‌کیفیته، ناوخته، ډېر غځېدلي او له حده ډېر risk لرونکو Entries کمول دي.
