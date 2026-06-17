// Technical Indicators Library

/**
 * Calculate Simple Moving Average (SMA)
 */
export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Exponential Moving Average (EMA)
 */
export function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = (values[i] - emaVal) * multiplier + emaVal;
  }
  return emaVal;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Calculate MACD
 * Returns: { macd, signal, histogram }
 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;

  const macdLineValues = [];
  for (let i = slow; i <= closes.length; i++) {
    const fEma = ema(closes.slice(0, i), fast);
    const sEma = ema(closes.slice(0, i), slow);
    if (fEma !== null && sEma !== null) {
      macdLineValues.push(fEma - sEma);
    }
  }

  if (macdLineValues.length < signalPeriod) return null;

  const currentMacd = macdLineValues[macdLineValues.length - 1];
  const signalLine = ema(macdLineValues, signalPeriod);

  if (signalLine === null) return null;

  return {
    macd: currentMacd,
    signal: signalLine,
    histogram: currentMacd - signalLine,
  };
}

/**
 * Calculate Bollinger Bands
 * Returns: { upper, middle, lower, bandwidth, percentB }
 */
export function bollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const sd = Math.sqrt(variance);

  const upper = mean + stdDev * sd;
  const lower = mean - stdDev * sd;
  const bandwidth = mean !== 0 ? (upper - lower) / mean : 0;
  const currentPrice = closes[closes.length - 1];
  const percentB = upper !== lower ? (currentPrice - lower) / (upper - lower) : 0.5;

  return { upper, middle: mean, lower, bandwidth, percentB };
}

/**
 * Calculate ATR (Average True Range)
 */
export function atr(ohlcs, period = 14) {
  if (ohlcs.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < ohlcs.length; i++) {
    const high = parseFloat(ohlcs[i].high);
    const low = parseFloat(ohlcs[i].low);
    const prevClose = parseFloat(ohlcs[i - 1].close);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;
  return trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Donchian Channel
 * Returns: { upper, middle, lower }
 */
export function donchianChannel(ohlcs, period = 20) {
  if (ohlcs.length < period) return null;

  const slice = ohlcs.slice(-period);
  const highestHigh = Math.max(...slice.map(c => parseFloat(c.high)));
  const lowestLow = Math.min(...slice.map(c => parseFloat(c.low)));

  return {
    upper: highestHigh,
    middle: (highestHigh + lowestLow) / 2,
    lower: lowestLow,
  };
}

/**
 * Calculate Volume MA
 */
export function volumeMA(volumes, period = 20) {
  if (volumes.length < period) return null;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Stochastic Oscillator
 */
export function stochastic(ohlcs, period = 14) {
  if (ohlcs.length < period) return null;

  const recent = ohlcs.slice(-period);
  const currentClose = parseFloat(ohlcs[ohlcs.length - 1].close);
  const highestHigh = Math.max(...recent.map(c => parseFloat(c.high)));
  const lowestLow = Math.min(...recent.map(c => parseFloat(c.low)));

  if (highestHigh === lowestLow) return { k: 50, d: 50 };

  const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;

  // Calculate %D as SMA of %K
  const kValues = [];
  for (let i = period - 1; i < ohlcs.length; i++) {
    const histSlice = ohlcs.slice(i - period + 1, i + 1);
    const hh = Math.max(...histSlice.map(c => parseFloat(c.high)));
    const ll = Math.min(...histSlice.map(c => parseFloat(c.low)));
    const cl = parseFloat(ohlcs[i].close);
    kValues.push(hh !== ll ? ((cl - ll) / (hh - ll)) * 100 : 50);
  }

  const d = kValues.slice(-period).reduce((a, b) => a + b, 0) / period;

  return { k, d };
}

/**
 * Compute all indicators for a given candlestick dataset
 */
export function computeAllIndicators(candles) {
  const closes = candles.map(c => parseFloat(c.close));
  const volumes = candles.map(c => parseFloat(c.volume));

  return {
    rsi_14: rsi(closes, 14),
    rsi_7: rsi(closes, 7),
    rsi_21: rsi(closes, 21),
    macd: macd(closes),
    bollinger: bollingerBands(closes, 20, 2),
    atr_14: atr(candles, 14),
    donchian: donchianChannel(candles, 20),
    stochastic: stochastic(candles, 14),
    ema_9: ema(closes, 9),
    ema_21: ema(closes, 21),
    ema_50: ema(closes, 50),
    sma_20: sma(closes, 20),
    sma_50: sma(closes, 50),
    volume_ma_20: volumeMA(volumes, 20),
    currentPrice: closes[closes.length - 1],
    currentVolume: volumes[volumes.length - 1],
  };
}
