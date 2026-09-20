import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNumber, predict } from '../server/services/predictionEngine.mjs';

const sample = [0,1,2,7,8,9,4,6,5,3,2,8,7,1,9,4,6,0,2,7,8,3,1,6,9,5,4,8,2,7];

test('WinGo classification follows size and color rules', () => {
  assert.deepEqual(classifyNumber(0), {number:0,size:'SMALL',color:'RED + VIOLET',baseColor:'RED'});
  assert.deepEqual(classifyNumber(5), {number:5,size:'BIG',color:'GREEN + VIOLET',baseColor:'GREEN'});
  assert.deepEqual(classifyNumber(2), {number:2,size:'SMALL',color:'RED',baseColor:'RED'});
  assert.deepEqual(classifyNumber(7), {number:7,size:'BIG',color:'GREEN',baseColor:'GREEN'});
});

test('prediction is deterministic and bounded', () => {
  const a = predict(sample.map(number => ({number})));
  const b = predict(sample.map(number => ({number})));
  assert.deepEqual(a, b);
  assert.ok(['BIG','SMALL'].includes(a.predictionSize));
  assert.ok(['RED','GREEN'].includes(a.predictionColor));
  assert.ok(a.confidence >= 50 && a.confidence <= 99);
});

test('prediction requires sufficient history', () => {
  assert.throws(() => predict(sample.slice(0,7).map(number=>({number}))), /At least 8 results/);
});
