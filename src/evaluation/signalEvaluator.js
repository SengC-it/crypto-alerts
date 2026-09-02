// Signal-level forward evaluation. This is research output, not account PnL.

export const DEFAULT_HORIZONS_HOURS = [1, 4, 8, 12, 24, 48];

function priceAt(candle, field, fallback) {
  const value = Number(candle?.[field]);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timeAt(candle) {
  const value = candle?.close_time ?? candle?.timestamp ?? candle?.open_time;
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCandles(candles) {
  return [...(candles || [])].sort((a, b) => {
    return (timeAt(a) ?? 0) - (timeAt(b) ?? 0);
  });
}

export function directionReturnPercent(direction, entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice === 0) return null;
  const normalizedDirection = String(direction || '').toUpperCase();
  if (normalizedDirection !== 'BUY' && normalizedDirection !== 'SELL') return null;
  return +((normalizedDirection === 'SELL'
    ? (entryPrice - exitPrice) / entryPrice
    : (exitPrice - entryPrice) / entryPrice) * 100).toFixed(6);
}

function excursion(direction, entryPrice, candle) {
  const high = priceAt(candle, 'high', priceAt(candle, 'close', entryPrice));
  const low = priceAt(candle, 'low', priceAt(candle, 'close', entryPrice));
  const favorable = direction === 'SELL' ? entryPrice - low : high - entryPrice;
  const adverse = direction === 'SELL' ? entryPrice - high : low - entryPrice;
  return {
    mfePercent: +(Math.max(0, favorable) / entryPrice * 100).toFixed(6),
    maePercent: +(Math.min(0, adverse) / entryPrice * 100).toFixed(6),
  };
}

function futureCandleAt(series, index, entryTime, horizonHours) {
  if (entryTime !== null) {
    const targetTime = entryTime + horizonHours * 60 * 60 * 1000;
    return series.slice(index + 1).find(candle => {
      const time = timeAt(candle);
      return time !== null && time >= targetTime;
    }) || null;
  }
  return series[index + horizonHours] || null;
}

export class SignalEvaluator {
  constructor({ roundTripCostPercent = 0, horizons = DEFAULT_HORIZONS_HOURS } = {}) {
    this.roundTripCostPercent = roundTripCostPercent;
    this.horizons = horizons;
  }

  evaluate(signal, candles, { signalIndex, entryPrice = signal?.suggestedEntry } = {}) {
    const series = normalizeCandles(candles);
    const signalTimeValue = signal?.signal_timestamp
      ?? signal?.trigger_time
      ?? signal?.generated_at
      ?? signal?.candle_close_time
      ?? signal?.candle_open_time;
    const signalTime = signalTimeValue === null || signalTimeValue === undefined
      ? null
      : timeAt({ timestamp: signalTimeValue });
    const index = signalIndex ?? (signalTime === null
      ? 0
      : series.findIndex(candle => {
        const time = timeAt(candle);
        return time !== null && time >= signalTime;
      }));
    const entryCandle = series[index];
    const entry = optionalNumber(entryPrice ?? entryCandle?.close);
    const direction = String(signal?.direction || signal?.signal || '').toUpperCase() || null;
    const result = {
      symbol: signal?.symbol,
      strategy: signal?.strategy,
      direction,
      signal_timestamp: signal?.signal_timestamp
        ?? signal?.candle_close_time
        ?? signal?.generated_at
        ?? null,
      entry_price: Number.isFinite(entry) ? entry : null,
      fee_slippage_cost_percent: this.roundTripCostPercent,
      forward_returns: {},
      net_forward_returns: {},
      mfe_percent: null,
      mae_percent: null,
      time_to_mfe_hours: null,
      time_to_mae_hours: null,
      tp_first: false,
      sl_first: false,
      neither: null,
      ambiguous: null,
      ambiguous_same_candle_hit: null,
      conservative_barrier_outcome: null,
      barrier_outcome: null,
      barriers_defined: false,
      target_price: null,
      stop_loss: null,
      barrier_version: signal?.barrier?.barrier_version
        ?? signal?.barrier_version
        ?? null,
      tp_sl_outcome: 'insufficient_horizon',
      signal_decay: null,
    };

    if (!entryCandle || !Number.isFinite(entry) || !direction) return result;

    const entryTime = timeAt(entryCandle);
    let maxMfe = 0;
    let maxMae = 0;
    let mfeCandle = null;
    let maeCandle = null;
    let tpIndex = null;
    let slIndex = null;
    let observedFuture = false;
    const target = optionalNumber(signal.targetPrice ?? signal.target_price);
    const stop = optionalNumber(signal.stopLoss ?? signal.stop_loss);
    const barriersDefined = target !== null && stop !== null;
    result.barriers_defined = barriersDefined;
    result.target_price = target;
    result.stop_loss = stop;
    const finiteHorizons = this.horizons.filter(Number.isFinite);
    const maxHorizonHours = finiteHorizons.length ? Math.max(...finiteHorizons) : 0;
    const excursionDeadline = entryTime === null
      ? null
      : entryTime + maxHorizonHours * 60 * 60 * 1000;

    for (let offset = 1; offset < series.length - index; offset++) {
      const candle = series[index + offset];
      const candleTime = timeAt(candle);
      const withinHorizon = excursionDeadline !== null && candleTime !== null
        ? candleTime <= excursionDeadline
        : offset <= maxHorizonHours;
      if (!withinHorizon) break;
      observedFuture = true;
      const move = excursion(direction, entry, candle);
      if (move.mfePercent > maxMfe) {
        maxMfe = move.mfePercent;
        mfeCandle = candle;
      }
      if (move.maePercent < maxMae) {
        maxMae = move.maePercent;
        maeCandle = candle;
      }

      const high = priceAt(candle, 'high', priceAt(candle, 'close', entry));
      const low = priceAt(candle, 'low', priceAt(candle, 'close', entry));
      const tpHit = Number.isFinite(target) && (direction === 'BUY' ? high >= target : low <= target);
      const slHit = Number.isFinite(stop) && (direction === 'BUY' ? low <= stop : high >= stop);
      if (tpHit && tpIndex === null) tpIndex = offset;
      if (slHit && slIndex === null) slIndex = offset;
    }

    result.mfe_percent = observedFuture ? +maxMfe.toFixed(6) : null;
    result.mae_percent = observedFuture ? +maxMae.toFixed(6) : null;
    result.time_to_mfe_hours = mfeCandle && entryTime !== null && timeAt(mfeCandle) !== null
      ? +(((timeAt(mfeCandle) - entryTime) / (60 * 60 * 1000)).toFixed(6))
      : null;
    result.time_to_mae_hours = maeCandle && entryTime !== null && timeAt(maeCandle) !== null
      ? +(((timeAt(maeCandle) - entryTime) / (60 * 60 * 1000)).toFixed(6))
      : null;
    if (observedFuture && barriersDefined) {
      result.tp_first = tpIndex !== null && (slIndex === null || tpIndex < slIndex);
      result.sl_first = slIndex !== null && (tpIndex === null || slIndex < tpIndex);
      result.neither = tpIndex === null && slIndex === null;
      result.ambiguous_same_candle_hit = tpIndex !== null && slIndex !== null && tpIndex === slIndex;
      result.ambiguous = result.ambiguous_same_candle_hit;
      if (result.ambiguous_same_candle_hit) {
        result.barrier_outcome = 'ambiguous_same_candle';
        result.conservative_barrier_outcome = 'sl_first';
        result.tp_sl_outcome = 'ambiguous_same_candle';
      } else if (result.tp_first) {
        result.barrier_outcome = 'tp_first';
        result.conservative_barrier_outcome = 'tp_first';
        result.tp_sl_outcome = 'tp_first';
      } else if (result.sl_first) {
        result.barrier_outcome = 'sl_first';
        result.conservative_barrier_outcome = 'sl_first';
        result.tp_sl_outcome = 'sl_first';
      } else if (result.neither) {
        result.barrier_outcome = 'neither';
        result.conservative_barrier_outcome = 'neither';
        result.tp_sl_outcome = 'neither';
      }
    } else if (observedFuture && !barriersDefined) {
      // Preserve the legacy evaluator label for V1 signals without research
      // barriers; the explicit barriers_defined flag prevents it being counted
      // as a V2 barrier outcome.
      result.tp_sl_outcome = 'neither';
    }

    for (const horizon of this.horizons) {
      const futureCandle = futureCandleAt(series, index, entryTime, horizon);
      const close = futureCandle ? priceAt(futureCandle, 'close', NaN) : NaN;
      const gross = directionReturnPercent(direction, entry, close);
      result.forward_returns[horizon + 'h'] = gross;
      result.net_forward_returns[horizon + 'h'] = gross === null
        ? null
        : +(gross - this.roundTripCostPercent).toFixed(6);
    }

    const first = result.forward_returns['1h'];
    const last = result.forward_returns['48h'];
    result.signal_decay = first === null || last === null ? null : +(last - first).toFixed(6);
    return result;
  }

  evaluateMany(signals, candlesBySymbol, options = {}) {
    return (signals || []).map(signal => {
      const candles = Array.isArray(candlesBySymbol)
        ? candlesBySymbol
        : candlesBySymbol?.[signal.symbol] || [];
      return this.evaluate(signal, candles, options);
    });
  }
}

export function evaluateSignal(signal, candles, options) {
  return new SignalEvaluator(options).evaluate(signal, candles, options);
}
