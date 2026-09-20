const { deriveSize, deriveColor } = require('./wingo-api');

function weightedMajority(values, recentWeight = true) {
  let bigWeight = 0;
  let smallWeight = 0;
  const startWeight = recentWeight ? 1 : 1;
  values.forEach((value, index) => {
    const weight = startWeight + index;
    if (value === 'BIG') bigWeight += weight;
    else smallWeight += weight;
  });
  const total = bigWeight + smallWeight || 1;
  return {
    choice: bigWeight >= smallWeight ? 'BIG' : 'SMALL',
    ratio: Math.max(bigWeight, smallWeight) / total,
    bigWeight,
    smallWeight
  };
}

function detectThreeGram(sequence) {
  if (sequence.length < 5) return { prediction: null, probability: 0, matches: 0 };
  const lastThree = sequence.slice(-3).join('|');
  const counts = { BIG: 0, SMALL: 0, GREEN: 0, RED: 0 };
  let matches = 0;
  for (let i = 0; i <= sequence.length - 4; i += 1) {
    const gram = sequence.slice(i, i + 3).join('|');
    if (gram !== lastThree) continue;
    const next = sequence[i + 3];
    if (next) counts[next] = (counts[next] || 0) + 1;
    matches += 1;
  }
  if (!matches) return { prediction: null, probability: 0, matches: 0 };
  const choices = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return {
    prediction: choices[0]?.[0] || null,
    probability: choices[0] ? choices[0][1] / matches : 0,
    matches
  };
}

function trendReversal(sequence) {
  if (sequence.length < 4) return { prediction: null, strength: 0 };
  const last = sequence[sequence.length - 1];
  let run = 0;
  for (let i = sequence.length - 1; i >= 0 && sequence[i] === last; i -= 1) run += 1;
  if (run < 4) return { prediction: null, strength: 0 };
  const opposite = last === 'BIG' ? 'SMALL' : last === 'SMALL' ? 'BIG' : last === 'GREEN' ? 'RED' : 'GREEN';
  return { prediction: opposite, strength: Math.min(1, 0.55 + (run - 4) * 0.1), run };
}

function predictDimension(sequence, dimension) {
  const ngram = detectThreeGram(sequence);
  const trend = trendReversal(sequence);
  const recent = sequence.slice(-10);
  const wma = dimension === 'size'
    ? weightedMajority(recent.map((x) => x === 'BIG' ? 'BIG' : 'SMALL'))
    : weightedMajority(recent.map((x) => x === 'GREEN' ? 'BIG' : 'SMALL'));
  const wmaChoice = dimension === 'size' ? wma.choice : (wma.choice === 'BIG' ? 'GREEN' : 'RED');

  const votes = new Map();
  function addVote(choice, weight) {
    if (!choice) return;
    votes.set(choice, (votes.get(choice) || 0) + weight);
  }
  addVote(ngram.prediction, 45 * Math.max(0, ngram.probability));
  addVote(trend.prediction, 35 * Math.max(0, trend.strength));
  addVote(wmaChoice, 20 * Math.max(0, (wma.ratio - 0.5) * 2));
  if (votes.size === 0) {
    return { prediction: wmaChoice, confidence: 50, components: { ngram, trend, wma } };
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0][0];
  const totalVote = ranked.reduce((sum, [, value]) => sum + value, 0) || 1;
  const voteAgreement = ranked[0][1] / totalVote;
  let confidence = 50 + voteAgreement * 32;
  if (ngram.prediction === winner && ngram.matches >= 2 && ngram.probability >= 0.6) confidence += 8;
  if (trend.prediction === winner) confidence += 7;
  if (wmaChoice === winner && wma.ratio >= 0.6) confidence += 6;
  confidence = Math.min(99, Math.max(0, confidence));

  return {
    prediction: winner,
    confidence: Number(confidence.toFixed(2)),
    components: { ngram, trend, wma, voteAgreement }
  };
}

function predict(results) {
  if (!Array.isArray(results) || results.length < 10) {
    throw new Error('At least 10 WinGo results are required for a stable prediction');
  }
  const recent = results.slice(-30);
  const enriched = recent.map((item) => ({
    ...item,
    size: deriveSize(item.number),
    normalizedColor: deriveColor(item.number)
  }));

  const sizeSequence = enriched.map((item) => item.size);
  const colorSequence = enriched.map((item) => item.normalizedColor);
  const sizePrediction = predictDimension(sizeSequence, 'size');
  const colorPrediction = predictDimension(colorSequence, 'color');
  const confidence = Number((sizePrediction.confidence * 0.55 + colorPrediction.confidence * 0.45).toFixed(2));

  return {
    size: sizePrediction.prediction,
    color: colorPrediction.prediction,
    confidence,
    analysisWindow: recent.length,
    details: {
      size: sizePrediction.components,
      color: colorPrediction.components
    }
  };
}

module.exports = { predict };
