const SIZE = { BIG:'BIG', SMALL:'SMALL' };
const COLOR = { RED:'RED', GREEN:'GREEN' };

export function classifyNumber(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error(`Invalid WinGo number: ${number}`);
  const size = n >= 5 ? SIZE.BIG : SIZE.SMALL;
  let color;
  if (n === 0) color = 'RED + VIOLET';
  else if (n === 5) color = 'GREEN + VIOLET';
  else color = n % 2 === 0 ? COLOR.RED : COLOR.GREEN;
  return { number:n, size, color, baseColor: color.startsWith('RED') ? COLOR.RED : COLOR.GREEN };
}

function normalizeResults(results) {
  return results.map(r => classifyNumber(r.number ?? r.result ?? r.num));
}

function counts(values) {
  return values.reduce((acc, v) => { acc[v]=(acc[v]||0)+1; return acc; }, {});
}

function markov3gram(sizeSeries) {
  if (sizeSeries.length < 6) return { big: 0, small: 0, strength: 0 };
  const grams = new Map();
  for (let i=0;i<sizeSeries.length-3;i++) {
    const key = sizeSeries.slice(i,i+3).join('');
    const next = sizeSeries[i+3];
    const bucket = grams.get(key) || { BIG:0, SMALL:0 };
    bucket[next]++; grams.set(key,bucket);
  }
  const key = sizeSeries.slice(-3).join('');
  const bucket = grams.get(key) || { BIG:0, SMALL:0 };
  const total = bucket.BIG + bucket.SMALL;
  if (!total) return { big:0, small:0, strength:0 };
  return { big: bucket.BIG/total, small: bucket.SMALL/total, strength: Math.min(1,total/4) };
}

function weightedMovingAverage(numbers) {
  let weighted=0,total=0;
  numbers.slice(-10).forEach((n,i,arr)=>{ const w=i+1; weighted += n*w; total += w; });
  const avg = total ? weighted/total : 4.5;
  const big = Math.max(0, Math.min(1, (avg-2.5)/4));
  return { avg, big, small:1-big };
}

function recentPressure(series, mapper) {
  const vals = series.slice(-8).map(mapper);
  if (!vals.length) return { positive:0.5, strength:0 };
  const wTotal = vals.reduce((s,_,i)=>s+i+1,0);
  const positive = vals.reduce((s,v,i)=>s+(v ? i+1:0),0)/wTotal;
  return { positive, strength:Math.min(1, vals.length/8) };
}

function reversal(values, positiveWhen) {
  if (values.length < 4) return { big:0, small:0, strength:0 };
  const recent = values.slice(-3).map(positiveWhen);
  const previous = values.slice(-6,-3).map(positiveWhen);
  const recentRate = recent.filter(Boolean).length/3;
  const prevRate = previous.filter(Boolean).length/3;
  const delta = recentRate-prevRate;
  if (Math.abs(delta)<0.15) return { big:0, small:0, strength:0 };
  return delta>0 ? { big:Math.min(1,Math.abs(delta)), small:0, strength:Math.min(1,Math.abs(delta)*1.5) } : { big:0, small:Math.min(1,Math.abs(delta)), strength:Math.min(1,Math.abs(delta)*1.5) };
}

export function predict(results) {
  const normalized = normalizeResults(results).slice(-60);
  if (normalized.length < 8) throw new Error('At least 8 results are required for prediction');
  const numbers = normalized.map(r=>r.number);
  const sizeSeries = normalized.map(r=>r.size);
  const colorSeries = normalized.map(r=>r.baseColor);

  const sizeCounts = counts(sizeSeries), colorCounts = counts(colorSeries);
  const sizeFreqBig = sizeCounts.BIG/(normalized.length||1);
  const colorFreqGreen = colorCounts.GREEN/(normalized.length||1);
  const wma = weightedMovingAverage(numbers);
  const gram = markov3gram(sizeSeries);
  const sizeRecent = recentPressure(sizeSeries, v=>v==='BIG');
  const colorRecent = recentPressure(colorSeries, v=>v==='GREEN');
  const sizeRev = reversal(sizeSeries, v=>v==='BIG');
  const colorRev = reversal(colorSeries, v=>v==='GREEN');

  // Fixed weights keep the result deterministic and auditable.
  const sizeBigScore = 0.30*gram.big + 0.20*wma.big + 0.18*sizeRecent.positive + 0.14*sizeFreqBig + 0.10*sizeRev.big + 0.08*0.5;
  const sizeSmallScore = 0.30*gram.small + 0.20*wma.small + 0.18*(1-sizeRecent.positive) + 0.14*(1-sizeFreqBig) + 0.10*sizeRev.small + 0.08*0.5;
  const colorGreenScore = 0.30*colorRecent.positive + 0.18*colorFreqGreen + 0.18*colorRev.big + 0.18*(numbers[numbers.length-1]%2===1?0.65:0.35) + 0.16*0.5;
  const colorRedScore = 0.30*(1-colorRecent.positive) + 0.18*(1-colorFreqGreen) + 0.18*colorRev.small + 0.18*(numbers[numbers.length-1]%2===0?0.65:0.35) + 0.16*0.5;

  const size = sizeBigScore >= sizeSmallScore ? SIZE.BIG : SIZE.SMALL;
  const color = colorGreenScore >= colorRedScore ? COLOR.GREEN : COLOR.RED;
  const sizeMargin = Math.abs(sizeBigScore-sizeSmallScore);
  const colorMargin = Math.abs(colorGreenScore-colorRedScore);
  const structure = (gram.strength + sizeRecent.strength)/2;
  const confidence = Math.round(Math.max(50, Math.min(99, 50 + sizeMargin*120*0.65 + colorMargin*120*0.35 + structure*7)));

  return {
    predictionSize:size,
    predictionColor:color,
    confidence,
    diagnostics:{
      threeGram: Number((size===SIZE.BIG?gram.big:gram.small).toFixed(4)),
      weightedAverage: Number(wma.avg.toFixed(4)),
      recentSizePressure: Number(sizeRecent.positive.toFixed(4)),
      recentColorPressure: Number(colorRecent.positive.toFixed(4)),
      sizeFrequencyBig: Number(sizeFreqBig.toFixed(4)),
      colorFrequencyGreen: Number(colorFreqGreen.toFixed(4)),
    },
  };
}

export function emojiForSize(size) { return size === SIZE.BIG ? '🔺' : '🔻'; }
