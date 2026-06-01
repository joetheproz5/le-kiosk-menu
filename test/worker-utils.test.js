import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  deliveryZoneForPoint,
  normalizePhone,
  priceNumber,
  publicConfig,
  safeCompare,
} from '../worker/utils.js';

test('normalizes Lebanese phone numbers used by order intake', () => {
  assert.equal(normalizePhone('76 840 244'), '76840244');
  assert.equal(normalizePhone('+961 76 840 244'), '76840244');
  assert.equal(normalizePhone('123'), '');
});

test('parses menu prices safely', () => {
  assert.equal(priceNumber('$6'), 6);
  assert.equal(priceNumber('$0.60'), 0.6);
  assert.equal(priceNumber('bad'), 0);
});

test('removes private driver pin fields from public config', () => {
  const cfg = publicConfig({ testingMode: true, driverPin: '1234', driverPinHash: 'secret' });
  assert.deepEqual(cfg, { testingMode: true });

  const adminCfg = publicConfig({ driverPinHash: 'secret' }, true);
  assert.deepEqual(adminCfg, { driverPinSet: true });
});

test('classifies delivery zones around Le Kiosk', () => {
  assert.deepEqual(deliveryZoneForPoint({ lat: 33.821091538427524, lng: 35.56496110422372 }), { label: 'Zone A', fee: 0.5 });
  assert.equal(deliveryZoneForPoint({ lat: 34.1, lng: 35.1 }).outside, true);
});

test('cleans text and compares tokens', () => {
  assert.equal(cleanText('  hello   kiosk  ', 20), 'hello kiosk');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(safeCompare('abc', 'abc'), true);
  assert.equal(safeCompare('abc', 'abd'), false);
  assert.equal(safeCompare('abc', 'abcd'), false);
});
