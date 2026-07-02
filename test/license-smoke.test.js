'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { signLicense, verifyLicenseKey, generateLicenseId } = require('../lib/license');

describe('license signing', () => {
  it('signs and verifies a license key', () => {
    const payload = { id: generateLicenseId(), cameras: 4, created: new Date().toISOString() };
    const key = signLicense(payload);
    const result = verifyLicenseKey(key);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.cameras, 4);
  });

  it('rejects a tampered license key', () => {
    const payload = { id: generateLicenseId(), cameras: 2, created: new Date().toISOString() };
    const key = signLicense(payload);
    const tampered = key.slice(0, -5) + 'AAAAA';
    const result = verifyLicenseKey(tampered);
    assert.strictEqual(result.valid, false);
  });
});
