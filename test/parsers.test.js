'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adbIssueMessage,
  parseAdbDevices,
  parseScrcpyCameras,
  parseScrcpyCameraSizes,
  computeAspectRatio,
  slotLabel,
  clampInt,
  isValidSerial,
  isValidCameraId,
  isValidWindowTitle,
  isValidResolution,
  buildScrcpyArgs,
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

// ─── parseScrcpyCameraSizes ───────────────────────────────────────────────────
test('parseScrcpyCameraSizes: extracts cameras with supported sizes', () => {
  const out = [
    '[server] INFO: List of camera sizes:',
    '    --camera-id=0    (back, 4080x3060, fps=[15, 20, 24, 30])',
    '        - 4080x3060',
    '        - 1920x1080',
    '        - 1280x720',
    '        - 640x480',
    '      High speed capture (--camera-high-speed):',
    '        - 1920x1080 (fps=[120, 240])',
    '    --camera-id=1    (front, 4128x3096, fps=[10, 15, 20, 30])',
    '        - 4128x3096',
    '        - 1920x1080',
    '        - 1280x720',
  ].join('\n');
  const cams = parseScrcpyCameraSizes(out);
  assert.equal(cams.length, 2);
  assert.equal(cams[0].id, '0');
  assert.equal(cams[0].facing, 'back');
  assert.equal(cams[0].maxRes, '4080x3060');
  assert.deepEqual(cams[0].sizes, ['4080x3060', '1920x1080', '1280x720', '640x480']);
  assert.equal(cams[1].id, '1');
  assert.deepEqual(cams[1].sizes, ['4128x3096', '1920x1080', '1280x720']);
});

test('parseScrcpyCameraSizes: returns empty on bad input', () => {
  assert.deepEqual(parseScrcpyCameraSizes(''), []);
  assert.deepEqual(parseScrcpyCameraSizes(null), []);
  assert.deepEqual(parseScrcpyCameraSizes('no cameras'), []);
});

test('parseScrcpyCameraSizes: handles camera with no sizes listed', () => {
  const out = '    --camera-id=0    (back, 4000x3000, fps=[15, 30])';
  const cams = parseScrcpyCameraSizes(out);
  assert.equal(cams.length, 1);
  assert.equal(cams[0].id, '0');
  assert.deepEqual(cams[0].sizes, []);
});

// ─── computeAspectRatio ───────────────────────────────────────────────────────
test('computeAspectRatio: reduces common resolutions', () => {
  assert.equal(computeAspectRatio('1920x1080'), '16:9');
  assert.equal(computeAspectRatio('1280x720'), '16:9');
  assert.equal(computeAspectRatio('854x480'), '427:240'); // 854/2=427, 480/2=240
  assert.equal(computeAspectRatio('640x360'), '16:9');
  assert.equal(computeAspectRatio('1080x1920'), '9:16');
  assert.equal(computeAspectRatio('720x1280'), '9:16');
  assert.equal(computeAspectRatio('1080x1080'), '1:1');
  assert.equal(computeAspectRatio('720x720'), '1:1');
  assert.equal(computeAspectRatio('640x480'), '4:3');
});

test('computeAspectRatio: returns null on invalid input', () => {
  assert.equal(computeAspectRatio(''), null);
  assert.equal(computeAspectRatio(null), null);
  assert.equal(computeAspectRatio('abc'), null);
  assert.equal(computeAspectRatio('0x0'), null);
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

test('isValidResolution: WxH digits only, "auto" accepted', () => {
  assert.ok(isValidResolution('1280x720'));
  assert.ok(isValidResolution('1920x1080'));
  assert.ok(isValidResolution('auto'));
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

// ─── buildScrcpyArgs ──────────────────────────────────────────────────────────
const baseArgs = { serial: 'SER123', cameraId: '0', fps: 30, windowTitle: 'Win', winW: 1280, winH: 720, offX: -10000, offY: -10000 };

test('buildScrcpyArgs: uses --camera-size for exact resolution', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: '1920x1080', useMaxSize: false, maxDim: 1920 });
  assert.ok(args.includes('--camera-size=1920x1080'), 'should include --camera-size=1920x1080');
  assert.ok(!args.some(a => a.startsWith('--max-size')), 'should NOT include --max-size');
});

test('buildScrcpyArgs: uses --max-size when useMaxSize fallback is set', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: null, useMaxSize: true, maxDim: 1280 });
  assert.ok(args.includes('--max-size=1280'), 'should include --max-size=1280');
  assert.ok(!args.some(a => a.startsWith('--camera-size')), 'should NOT include --camera-size');
});

test('buildScrcpyArgs: includes --camera-ar when aspectRatio is provided with --max-size', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: null, useMaxSize: true, maxDim: 1280, aspectRatio: '16:9' });
  assert.ok(args.includes('--max-size=1280'), 'should include --max-size=1280');
  assert.ok(args.includes('--camera-ar=16:9'), 'should include --camera-ar=16:9');
});

test('buildScrcpyArgs: omits --camera-ar when no aspectRatio provided', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: null, useMaxSize: true, maxDim: 1280 });
  assert.ok(!args.some(a => a.startsWith('--camera-ar')), 'should NOT include --camera-ar when not provided');
});

test('buildScrcpyArgs: portrait resolution passed as --camera-size', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: '1080x1920', useMaxSize: false, maxDim: 1080 });
  assert.ok(args.includes('--camera-size=1080x1920'), 'should include portrait --camera-size');
});

test('buildScrcpyArgs: includes core flags, omits --camera-fps at Android default 30', () => {
  const args = buildScrcpyArgs({ ...baseArgs, resolution: '1280x720', useMaxSize: false, maxDim: 1280 });
  assert.ok(args.includes('-s'), 'should include serial flag');
  assert.ok(args.includes('--video-source=camera'));
  assert.ok(args.includes('--camera-id=0'));
  assert.ok(!args.some(a => a.startsWith('--camera-fps')), 'should NOT include --camera-fps at default 30');
  assert.ok(args.includes('--window-borderless'));
});

test('buildScrcpyArgs: includes --camera-fps for non-default frame rates', () => {
  const args = buildScrcpyArgs({ ...baseArgs, fps: 60, resolution: '1280x720', useMaxSize: false, maxDim: 1280 });
  assert.ok(args.includes('--camera-fps=60'), 'should include --camera-fps=60 for non-default fps');
});
