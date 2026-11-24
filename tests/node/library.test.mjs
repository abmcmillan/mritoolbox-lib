// A dependency-free check of the built package with node:test, so that every
// Node version the package supports is tested. Vitest 5 (the main suite in
// tests/*.test.ts) needs Node 22.12 or later; the package supports Node 20.
// Run it after `npm run build`: npm run test:node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DATABASE,
  InvalidInputError,
  RAW_DATABASE,
  createFitter,
  ernstAngleDeg,
  fitCurve,
  fitVoxels,
  optimiseContrast,
  searchDatabase,
  simulateMprageImage,
} from '../../dist/index.js';

const close = (actual, expected, digits) =>
  assert.ok(
    Math.abs(actual - expected) < 10 ** -digits / 2,
    `${actual} is not ${expected} to ${digits} decimals`,
  );

test('Ernst angle matches the previous site', () => {
  close(ernstAngleDeg(750, 10), 9.336, 3);
  close(ernstAngleDeg(1450, 10), 6.721, 3);
});

test('GRE contrast reproduces the previous site', () => {
  const r = optimiseContrast({
    mode: 'gre',
    tissues: [
      { pd: 0.92, t1: 750, t2: 75 },
      { pd: 1, t1: 1450, t2: 100 },
    ],
    te: 5,
    tr: 100,
  });
  close(r.optimum, 45, 0);
  close(r.signals[0], 0.199, 3);
});

test('MP-RAGE EPG reproduces the reference implementation on the previous site', () => {
  const r = simulateMprageImage(
    { pd: 1, t1: 1450, t2: 100 },
    { pd: 0.92, t1: 750, t2: 75 },
    { flipAngle: 9, spoilIncrement: 50, tr: 7, td1: 330, td2: 830, np: 160 },
  );
  close(r.signalA, 0.024424690025312324, 12);
  close(r.signalB, 0.047124053975078295, 12);
});

test('curve fitting and pixel-wise mapping recover T2', () => {
  const x = [10, 20, 40, 60, 80, 120, 160, 240];
  const y = x.map((te) => 1000 * Math.exp(-te / 85));
  close(fitCurve({ model: 't2', x, y }).value, 85, 4);
  const data = Float32Array.from([...y, ...y.map((v) => v / 2)]);
  const out = fitVoxels(createFitter({ model: 't2', x, options: {} }), data, 2);
  close(out[0], 85, 3);
  close(out[5], 85, 3);
  close(out[6] / out[1], 0.5, 4);
  assert.throws(
    () => fitCurve({ model: 't2', x: [-10, 20, 40], y: [9, 8, 7] }),
    InvalidInputError,
  );
});

test('the database ships every record of its source file', () => {
  const file = JSON.parse(readFileSync('data/parameter-database.json', 'utf8'));
  assert.deepEqual(RAW_DATABASE, file);
  assert.equal(DATABASE.length, 232);
  assert.ok(searchDatabase('liver', 3).length > 0);
});
