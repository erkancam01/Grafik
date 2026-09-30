/**
 * Pine dilinde yazılmış yerleşikler: TradingView başvuru kılavuzundaki tanımların aynısı. Yorumlayıcı bunları
 * kullanıcı fonksiyonu gibi derler (çağrı yeri başına durum otomatik).
 */
export const PRELUDE = `
ta.vwma(source, length) =>
    ta.sma(source * volume, length) / ta.sma(volume, length)

ta.hma(source, length) =>
    ta.wma(2 * ta.wma(source, length / 2) - ta.wma(source, length), math.floor(math.sqrt(length)))

ta.wpr(length) =>
    hh = ta.highest(high, length)
    ll = ta.lowest(low, length)
    100 * (close - hh) / (hh - ll)

ta.mfi(series, length) =>
    ch = ta.change(series)
    upper = math.sum(volume * (ch <= 0 ? 0 : series), length)
    lower = math.sum(volume * (ch >= 0 ? 0 : series), length)
    lower == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + upper / lower))

ta.bbw(series, length, mult) =>
    basis = ta.sma(series, length)
    dev = mult * ta.stdev(series, length)
    ((basis + dev) - (basis - dev)) / basis * 100

ta.kc(series, length, mult, useTrueRange = true) =>
    basis = ta.ema(series, length)
    span = useTrueRange ? ta.tr(true) : high - low
    rangeEma = ta.ema(span, length)
    [basis, basis + rangeEma * mult, basis - rangeEma * mult]

ta.kcw(series, length, mult, useTrueRange = true) =>
    [kb, ku, kl] = ta.kc(series, length, mult, useTrueRange)
    (ku - kl) / kb

ta.tsi(source, short_length, long_length) =>
    pc = ta.change(source)
    dsp = ta.ema(ta.ema(pc, long_length), short_length)
    dsa = ta.ema(ta.ema(math.abs(pc), long_length), short_length)
    dsp / dsa

ta.cmo(series, length) =>
    mom = ta.change(series)
    sm1 = math.sum(mom >= 0 ? mom : 0.0, length)
    sm2 = math.sum(mom >= 0 ? 0.0 : -mom, length)
    100 * (sm1 - sm2) / (sm1 + sm2)

ta.dmi(diLength, adxSmoothing) =>
    up = ta.change(high)
    down = -ta.change(low)
    plusDM = na(up) ? na : (up > down and up > 0 ? up : 0)
    minusDM = na(down) ? na : (down > up and down > 0 ? down : 0)
    trur = ta.rma(ta.tr(false), diLength)
    plus = fixnan(100 * ta.rma(plusDM, diLength) / trur)
    minus = fixnan(100 * ta.rma(minusDM, diLength) / trur)
    sum = plus + minus
    adx = 100 * ta.rma(math.abs(plus - minus) / (sum == 0 ? 1 : sum), adxSmoothing)
    [plus, minus, adx]

ta.supertrend(factor, atrPeriod) =>
    src = hl2
    atr = ta.atr(atrPeriod)
    upperBand = src + factor * atr
    lowerBand = src - factor * atr
    prevLowerBand = nz(lowerBand[1])
    prevUpperBand = nz(upperBand[1])
    lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand ? lowerBand : prevLowerBand
    upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand ? upperBand : prevUpperBand
    int direction = na
    float superTrend = na
    prevSuperTrend = superTrend[1]
    if na(atr[1])
        direction := 1
    else if prevSuperTrend == prevUpperBand
        direction := close > upperBand ? -1 : 1
    else
        direction := close < lowerBand ? 1 : -1
    superTrend := direction == -1 ? lowerBand : upperBand
    [superTrend, direction]

ta.sar(start, inc, max) =>
    var float result = na
    var float maxMin = na
    var float acceleration = na
    var bool isBelow = false
    bool isFirstTrendBar = false
    if bar_index == 1
        if close > close[1]
            isBelow := true
            maxMin := high
            result := low[1]
        else
            isBelow := false
            maxMin := low
            result := high[1]
        isFirstTrendBar := true
        acceleration := start
    result := result + acceleration * (maxMin - result)
    if isBelow
        if result > low
            isFirstTrendBar := true
            isBelow := false
            result := math.max(high, maxMin)
            maxMin := low
            acceleration := start
    else
        if result < high
            isFirstTrendBar := true
            isBelow := true
            result := math.min(low, maxMin)
            maxMin := high
            acceleration := start
    if not isFirstTrendBar
        if isBelow
            if high > maxMin
                maxMin := high
                acceleration := math.min(acceleration + inc, max)
        else
            if low < maxMin
                maxMin := low
                acceleration := math.min(acceleration + inc, max)
    if isBelow
        result := math.min(result, low[1])
        if bar_index > 1
            result := math.min(result, low[2])
    else
        result := math.max(result, high[1])
        if bar_index > 1
            result := math.max(result, high[2])
    result
`;
