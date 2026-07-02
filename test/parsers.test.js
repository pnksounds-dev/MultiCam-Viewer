'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adbIssueMessage,
  parseAdbDevices,
  parseScrcpyCameras,
  slotLabel,
  clampInt,
  isValidSerial,
  isValidCameraId,
  isValidWindowTitle,
  isValidResolution,
  ringNextIndex,
  frameSlotBytes,
} = require('../lib/parsers');

// ─── parseAdbDevices ───────────────────────────────────────────────────────────
test('parseAdbDevices: parses a ready device with model', () => {
  const out = [
    'List of devices attached',
    'ABC123XYZ              device usb:1-2 product:redfin model:Pixel_5 device:redfin transport_id:1',
  ].join('\n');
  const { phones, issues } = parseAdbDevices(out);
  assert.equal(phones.length, 1);
  assert.deepEqual(phones[0], { serial: 'ABC123XYZ', model: 'Pixel 5' });
  assert.equal(issues.length, 0);
});

test('parseAdbDevices: falls back to serial when no model present', () => {
  const out = 'List of devices attached\nSERIAL001   device\n';
  const { phones } = parseAdbDevices(out);
  assert.deepEqual(phones[0], { serial: 'SERIAL001', model: 'SERIAL001' });
});

test('parseAdbDevices: reports unauthorized/offline as issues, not phones', () => {
  const out = [
    'List of devices attached',
    'AAAA   unauthorized',
    'BBBB   offline',
  ].join('\n');
  const { phones, issues } = parseAdbDevices(out);
  assert.equal(phones.length, 0);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].state, 'unauthorized');
  assert.equal(issues[1].state, 'offline');
});

test('parseAdbDevices: handles "no permissions" state', () => {
  const out = 'List of devices attached\nCCCC   no permissions (user in plugdev group)\n';
  const { phones, issues } = parseAdbDevices(out);
  assert.equal(phones.length, 0);
  assert.equal(issues[0].state, 'no permissions');
});

test('parseAdbDevices: tolerates empty / CRLF / junk input', () => {
  assert.deepEqual(parseAdbDevices(''), { phones: [], issues: [] });
  assert.deepEqual(parseAdbDevices(undefined), { phones: [], issues: [] });
  const crlf = 'List of devices attached\r\nDEV1\tdevice\r\n\r\n';
  const { phones } = parseAdbDevices(crlf);
  assert.equal(phones.length, 1);
});

test('parseAdbDevices: parses multiple mixed devices', () => {
  const out = [
    'List of devices attached',
    'S1   device model:OnePlus_9',
    'S2   unauthorized',
    'S3   device model:Galaxy_S21',
  ].join('\n');
  const { phones, issues } = parseAdbDevices(out);
  assert.equal(phones.length, 2);
  assert.equal(issues.length, 1);
  assert.equal(phones[1].model, 'Galaxy S21');
});

// ─── parseScrcpyCameras ────────────────────────────────────────────────────────
test('parseScrcpyCameras: extracts id/facing/maxRes', () => {
  const out = [
    '[server] INFO: List of cameras:',
    '    --camera-id=0    (back, 4000x3000, fps=[...])',
    '    --camera-id=1    (front, 3264x2448, fps=[...])',
  ].join('\n');
  const cams = parseScrcpyCameras(out);
  assert.deepEqual(cams, [
    { id: '0', facing: 'back', maxRes: '4000x3000' },
    { id: '1', facing: 'front', maxRes: '3264x2448' },
  ]);
});

test('parseScrcpyCameras: returns empty on no matches / bad input', () => {
  assert.deepEqual(parseScrcpyCameras('no cameras here'), []);
  assert.deepEqual(parseScrcpyCameras(''), []);
  assert.deepEqual(parseScrcpyCameras(null), []);
});

// ─── slotLabel ─────────────────────────────────────────────────────────────────
test('slotLabel: slot 0 is "MultiCam", others are 1-indexed', () => {
  assert.equal(slotLabel(0), 'MultiCam');
  assert.equal(slotLabel(1), 'MultiCam 2');
  assert.equal(slotLabel(3), 'MultiCam 4');
});

// ─── clampInt ──────────────────────────────────────────────────────────────────
test('clampInt: clamps within range and uses fallback for NaN', () => {
  assert.equal(clampInt('50', 0, 100, 0), 50);
  assert.equal(clampInt(-10, 0, 100, 0), 0);
  assert.equal(clampInt(999, 0, 100, 0), 100);
  assert.equal(clampInt('abc', 0, 100, 7), 7);
  assert.equal(clampInt(undefined, 1, 240, 30), 30);
});

// ─── validators ────────────────────────────────────────────────────────────────
test('isValidSerial: accepts valid serials, rejects injection', () => {
  assert.ok(isValidSerial('ABC123'));
  assert.ok(isValidSerial('192.168.1.5:5555'));
  assert.ok(isValidSerial('emulator-5554'));
  assert.ok(!isValidSerial('foo; rm -rf /'));
  assert.ok(!isValidSerial(''));
  assert.ok(!isValidSerial(42));
  assert.ok(!isValidSerial('a'.repeat(129)));
});

test('isValidCameraId: 1-4 digits only', () => {
  assert.ok(isValidCameraId('0'));
  assert.ok(isValidCameraId(3));
  assert.ok(!isValidCameraId('12345'));
  assert.ok(!isValidCameraId('1a'));
});

test('isValidWindowTitle: safe charset only', () => {
  assert.ok(isValidWindowTitle('MultiCamCap1_SERIAL_0_0'));
  assert.ok(!isValidWindowTitle('bad\ntitle'));
  assert.ok(!isValidWindowTitle('"; quote'));
});

test('isValidResolution: WxH digits only', () => {
  assert.ok(isValidResolution('1280x720'));
  assert.ok(isValidResolution('1920x1080'));
  assert.ok(!isValidResolution('1280X720')); // capital X not allowed
  assert.ok(!isValidResolution('abcxdef'));
  assert.ok(!isValidResolution(''));
});

// ─── ring-buffer math ──────────────────────────────────────────────────────────
test('ringNextIndex: wraps around slot count', () => {
  assert.equal(ringNextIndex(0, 3), 1);
  assert.equal(ringNextIndex(2, 3), 0);
  assert.equal(ringNextIndex(5, 1), 0);
  assert.equal(ringNextIndex(0, 0), 0); // guard against div-by-zero
});

test('frameSlotBytes: RGBA8 size, guards negatives', () => {
  assert.equal(frameSlotBytes(1280, 720), 1280 * 720 * 4);
  assert.equal(frameSlotBytes(0, 720), 0);
  assert.equal(frameSlotBytes(-5, 720), 0);
});
