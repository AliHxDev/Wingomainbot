import { emojiForSize } from '../services/predictionEngine.mjs';

export function signalMessage({ issue, predictionSize, predictionColor, confidence, time }) {
  return `🎯 WinGo 1M Signal\n━━━━━━━━━━━━━━━━\n📊 Period: ${issue}\n🎲 Prediction: ${predictionSize} ${emojiForSize(predictionSize)}\n🎨 Color: ${predictionColor}\n📈 Confidence: ${confidence}%\n⏱️ Time: ${time}\n━━━━━━━━━━━━━━━━\n⚠️ Play responsibly`;
}

export function resultMessage({ outcome, issue, result, signal }) {
  const prefix = outcome === 'WIN' ? '✅ WIN!' : '❌ LOSS';
  const mark = outcome === 'WIN' ? '✅' : '❌';
  return `${prefix}\nPeriod: ${issue}\nResult: ${result.number} (${result.size}, ${result.color})\nOur Signal: ${signal.predictionSize} ${signal.predictionColor} ${mark}`;
}
