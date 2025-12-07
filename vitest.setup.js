import { vi } from "vitest";

// Mock chrome.storage.local API
global.chrome = {
  storage: {
    local: {
      get: vi.fn((keys, callback) => {
        // Default empty response
        if (callback) callback({});
        return Promise.resolve({});
      }),
      set: vi.fn((data, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: vi.fn((keys, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
    },
  },
  runtime: {
    getManifest: vi.fn(() => ({
      version: "0.1.1",
      name: "LeetTracker Dev",
    })),
    getURL: vi.fn((path) => `chrome-extension://fake-extension-id/${path}`),
  },
};

// Mock window.crypto for Web Crypto API (sha256)
if (!global.crypto) {
  global.crypto = {
    subtle: {
      digest: async (algorithm, data) => {
        // Simple mock implementation for testing
        // In real tests, happy-dom should provide this
        const encoder = new TextEncoder();
        const dataArray =
          data instanceof Uint8Array ? data : encoder.encode(data);

        // Create a simple hash for testing (not cryptographically secure)
        let hash = 0;
        for (let i = 0; i < dataArray.length; i++) {
          hash = (hash << 5) - hash + dataArray[i];
          hash |= 0;
        }

        // Return ArrayBuffer with 32 bytes (SHA-256 size)
        const buffer = new ArrayBuffer(32);
        const view = new DataView(buffer);
        view.setUint32(0, hash);
        return buffer;
      },
    },
  };
}

// Mock IndexedDB (will be overridden in specific tests if needed)
if (!global.indexedDB) {
  global.indexedDB = {
    open: vi.fn(() => {
      const request = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: null,
        error: null,
      };
      // Simulate async success
      setTimeout(() => {
        if (request.onsuccess) {
          request.onsuccess({ target: request });
        }
      }, 0);
      return request;
    }),
  };
}

// Mock localStorage for tests that need it
if (!global.localStorage) {
  const localStorageMock = (() => {
    let store = {};
    return {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => {
        store[key] = value.toString();
      },
      removeItem: (key) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };
  })();
  global.localStorage = localStorageMock;
}

// Clear mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  if (global.localStorage) {
    global.localStorage.clear();
  }
});
