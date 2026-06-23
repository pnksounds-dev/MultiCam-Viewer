'use strict';

/**
 * vcam-native.js — UnityCapture shared memory frame writer using Koffi FFI
 *
 * Implements the actual UnityCapture protocol from shared.inl:
 *   - Named shared memory: "UnityCapture_Data0" (slot 0), "UnityCapture_Data1", etc.
 *   - Named mutex: "UnityCapture_Mutx0", "UnityCapture_Mutx1", etc.
 *   - Named events: "UnityCapture_Want0" / "UnityCapture_Sent0", etc.
 *   - SharedMemHeader: maxSize(DWORD), width, height, stride, format, resizemode, mirrormode, timeout, then pixel data
 *   - Sender writes RGBA8 data (format=0), DirectShow filter converts to BGRA internally
 *   - Synchronization: lock mutex → write header+data → release mutex → set Sent event
 */

const koffi = require('koffi');

// Load kernel32.dll
const kernel32 = koffi.load('kernel32.dll');

// Function declarations using built-in Koffi types
const OpenFileMappingA = kernel32.func('void *OpenFileMappingA(uint32 dwDesiredAccess, int32 bInheritHandle, const char *lpName)');
const CreateFileMappingA = kernel32.func('void *CreateFileMappingA(void *hFile, void *lpFileMappingAttributes, uint32 flProtect, uint32 dwMaximumSizeHigh, uint32 dwMaximumSizeLow, const char *lpName)');
const MapViewOfFile = kernel32.func('void *MapViewOfFile(void *hFileMappingObject, uint32 dwDesiredAccess, uint32 dwFileOffsetHigh, uint32 dwFileOffsetLow, ulong dwNumberOfBytesToMap)');
const UnmapViewOfFile = kernel32.func('int32 UnmapViewOfFile(void *lpBaseAddress)');
const CloseHandle = kernel32.func('int32 CloseHandle(void *hObject)');
const OpenMutexA = kernel32.func('void *OpenMutexA(uint32 dwDesiredAccess, int32 bInheritHandle, const char *lpName)');
const CreateMutexA = kernel32.func('void *CreateMutexA(void *lpMutexAttributes, int32 bInitialOwner, const char *lpName)');
const ReleaseMutex = kernel32.func('int32 ReleaseMutex(void *hMutex)');
const WaitForSingleObject = kernel32.func('uint32 WaitForSingleObject(void *hHandle, uint32 dwMilliseconds)');
const OpenEventA = kernel32.func('void *OpenEventA(uint32 dwDesiredAccess, int32 bInheritHandle, const char *lpName)');
const CreateEventA = kernel32.func('void *CreateEventA(void *lpEventAttributes, int32 bManualReset, int32 bInitialState, const char *lpName)');
const SetEvent = kernel32.func('int32 SetEvent(void *hEvent)');

// Constants
const FILE_MAP_WRITE = 0x0002;
const FILE_MAP_ALL_ACCESS = 0x000F001F;
const PAGE_READWRITE = 0x04;
const SYNCHRONIZE = 0x00100000;
const EVENT_MODIFY_STATE = 0x0002;
const INFINITE = 0xFFFFFFFF;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const INVALID_HANDLE_VALUE = koffi.as(-1, koffi.pointer(koffi.types.void));

// UnityCapture constants from shared.inl
const MAX_SHARED_IMAGE_SIZE = 3840 * 2160 * 4 * 2; // matches #define in shared.inl (RGBA max 16bit)
const SHARED_MEM_HEADER_SIZE = 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4; // maxSize + width + height + stride + format + resizemode + mirrormode + timeout = 32 bytes
const FORMAT_UINT8 = 0;
const TOTAL_SHARED_SIZE = SHARED_MEM_HEADER_SIZE + MAX_SHARED_IMAGE_SIZE;

class VcamNative {
  constructor() {
    this._hMapFile = null;
    this._pShared = null;
    this._hMutex = null;
    this._hWantEvent = null;
    this._hSentEvent = null;
    this._width = 0;
    this._height = 0;
    this._slot = 0;
    this._available = true;
    this._headerArrayType = null;
  }

  get available() {
    return this._available;
  }

  _getNames(slot) {
    const ch = slot === 0 ? '\0' : String('0'.charCodeAt(0) + slot);
    // When slot=0, the char is null terminator (compatible with old DLLs)
    // For slot>0, replace the last char with the slot digit
    const base = slot === 0 ? '' : String(slot);
    return {
      mutex:  'UnityCapture_Mutx' + base,
      want:   'UnityCapture_Want' + base,
      sent:   'UnityCapture_Sent' + base,
      data:   'UnityCapture_Data' + base,
    };
  }

  init(slot, width, height) {
    if (width <= 0 || height <= 0 || width > 3840 || height > 2160) return false;

    this.close();

    const names = this._getNames(slot);

    // 1. Open or create the mutex (sender opens, receiver creates)
    this._hMutex = OpenMutexA(SYNCHRONIZE, 0, names.mutex);
    if (!this._hMutex) {
      this._hMutex = CreateMutexA(null, 0, names.mutex);
    }
    if (!this._hMutex) return false;

    // 2. Create the Want event (sender creates, receiver opens)
    this._hWantEvent = CreateEventA(null, 0, 0, names.want);
    if (!this._hWantEvent) {
      this._hWantEvent = OpenEventA(EVENT_MODIFY_STATE, 0, names.want);
    }
    if (!this._hWantEvent) { this.close(); return false; }

    // 3. Open or create the Sent event (sender opens, receiver creates)
    this._hSentEvent = OpenEventA(EVENT_MODIFY_STATE, 0, names.sent);
    if (!this._hSentEvent) {
      this._hSentEvent = CreateEventA(null, 0, 0, names.sent);
    }
    if (!this._hSentEvent) { this.close(); return false; }

    // 4. Open or create the shared file mapping (sender opens, receiver creates)
    this._hMapFile = OpenFileMappingA(FILE_MAP_WRITE, 0, names.data);
    if (!this._hMapFile) {
      this._hMapFile = CreateFileMappingA(INVALID_HANDLE_VALUE, null, PAGE_READWRITE, 0, TOTAL_SHARED_SIZE, names.data);
    }
    if (!this._hMapFile) { this.close(); return false; }

    // 5. Map the shared memory
    this._pShared = MapViewOfFile(this._hMapFile, FILE_MAP_ALL_ACCESS, 0, 0, 0);
    if (!this._pShared) { this.close(); return false; }

    this._width = width;
    this._height = height;
    this._slot = slot;
    this._headerArrayType = koffi.array(koffi.types.uint8, TOTAL_SHARED_SIZE);

    return true;
  }

  writeFrame(rgbaBuffer) {
    if (!this._pShared) return false;

    const stride = this._width; // stride in pixels (not bytes), per UnityCapture protocol
    const dataSize = this._width * this._height * 4;
    if (rgbaBuffer.length < dataSize) return false;

    // Lock mutex
    const waitResult = WaitForSingleObject(this._hMutex, INFINITE);
    if (waitResult !== WAIT_OBJECT_0) return false;

    try {
      // Build the SharedMemHeader + pixel data
      const header = Buffer.alloc(SHARED_MEM_HEADER_SIZE);
      header.writeUInt32LE(MAX_SHARED_IMAGE_SIZE, 0);  // maxSize
      header.writeInt32LE(this._width, 4);              // width
      header.writeInt32LE(this._height, 8);             // height
      header.writeInt32LE(stride, 12);                  // stride (in pixels)
      header.writeInt32LE(FORMAT_UINT8, 16);            // format (0 = RGBA8)
      header.writeInt32LE(1, 20);                       // resizemode (1 = linear resize)
      header.writeInt32LE(0, 24);                       // mirrormode (0 = disabled)
      header.writeInt32LE(0, 28);                       // timeout

      const combined = Buffer.concat([header, rgbaBuffer.subarray(0, dataSize)]);
      koffi.encode(this._pShared, this._headerArrayType, combined);
    } finally {
      // Release mutex
      ReleaseMutex(this._hMutex);
    }

    // Signal that a frame has been sent
    SetEvent(this._hSentEvent);

    return true;
  }

  close() {
    if (this._pShared) {
      try { UnmapViewOfFile(this._pShared); } catch {}
      this._pShared = null;
    }
    if (this._hMapFile) {
      try { CloseHandle(this._hMapFile); } catch {}
      this._hMapFile = null;
    }
    if (this._hSentEvent) {
      try { CloseHandle(this._hSentEvent); } catch {}
      this._hSentEvent = null;
    }
    if (this._hWantEvent) {
      try { CloseHandle(this._hWantEvent); } catch {}
      this._hWantEvent = null;
    }
    if (this._hMutex) {
      try { CloseHandle(this._hMutex); } catch {}
      this._hMutex = null;
    }
    this._width = 0;
    this._height = 0;
    this._headerArrayType = null;
  }

  isReady() {
    return this._pShared !== null;
  }
}

module.exports = VcamNative;
