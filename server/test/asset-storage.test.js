// Tests for services/asset-storage.js — the low-level download/path-safety
// layer. Every HTTP call is a fake fetchImpl injected per test; nothing
// here makes a real network request or talks to EvoLink.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('node:stream');

const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.ASSET_MAX_BYTES = String(1024); // 1KB, so the size-limit tests stay fast/small

const assetStorage = require('../services/asset-storage');

const ASSET_ID = '11111111-1111-1111-1111-111111111111';

function fakeResponse({ ok = true, status = 200, headers = {}, bodyBytes = Buffer.from('fake video bytes') } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok,
    status,
    headers: { get: (key) => headerMap.get(key.toLowerCase()) || null },
    body: bodyBytes === null ? null : Readable.toWeb(Readable.from([bodyBytes])),
  };
}

// --- 1. Valid remote URL accepted / 2. invalid URL rejected ---------------

test('1. a valid http(s) URL is accepted', () => {
  assert.equal(assetStorage.isValidRemoteUrl('https://files.evolink.ai/video.mp4'), true);
  assert.equal(assetStorage.isValidRemoteUrl('http://example.com/x.mp4'), true);
});

test('2. an invalid or non-http(s) URL is rejected', () => {
  assert.equal(assetStorage.isValidRemoteUrl('not a url'), false);
  assert.equal(assetStorage.isValidRemoteUrl('ftp://example.com/x.mp4'), false);
  assert.equal(assetStorage.isValidRemoteUrl('file:///etc/passwd'), false);
  assert.equal(assetStorage.isValidRemoteUrl(''), false);
  assert.equal(assetStorage.isValidRemoteUrl(null), false);
});

test('downloadAsset rejects an invalid URL before ever calling fetch', async () => {
  let called = false;
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('not-a-url', ASSET_ID, {
        fetchImpl: async () => {
          called = true;
          return fakeResponse();
        },
      }),
    /AssetStorageError|invalid_url/
  );
  assert.equal(called, false, 'fetch must never be called for an invalid URL');
});

test('downloadAsset rejects an invalid asset id', async () => {
  await assert.rejects(
    () => assetStorage.downloadAsset('https://example.com/x.mp4', 'not-a-uuid', { fetchImpl: async () => fakeResponse() }),
    (err) => {
      assert.equal(err.code, 'invalid_asset_id');
      return true;
    }
  );
});

// --- 3. HTTP error handled --------------------------------------------------

test('3. a non-200 HTTP response is handled with a clear error', async () => {
  const id = '22222222-2222-2222-2222-222222222222';
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/missing.mp4', id, {
        fetchImpl: async () => fakeResponse({ ok: false, status: 404 }),
      }),
    (err) => {
      assert.equal(err.code, 'http_error');
      assert.equal(err.httpStatus, 404);
      return true;
    }
  );
});

// --- 4. Network error handled -----------------------------------------------

test('4. a network error (fetch throws) is handled with a clear error', async () => {
  const id = '33333333-3333-3333-3333-333333333333';
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/x.mp4', id, {
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    (err) => {
      assert.equal(err.code, 'network_error');
      return true;
    }
  );
});

// --- 5. Empty response handled ----------------------------------------------

test('5. an empty response body is rejected, and no file is left behind', async () => {
  const id = '44444444-4444-4444-4444-444444444444';
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/empty.mp4', id, {
        fetchImpl: async () => fakeResponse({ bodyBytes: Buffer.alloc(0) }),
      }),
    (err) => {
      assert.equal(err.code, 'empty_response');
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(assetsTempDir, `${id}.mp4`)), false);
  assert.equal(fs.existsSync(path.join(assetsTempDir, `${id}.mp4.download`)), false, 'temp file must be cleaned up');
});

test('5b. a response with no body at all is rejected', async () => {
  const id = '55555555-5555-5555-5555-555555555555';
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/nobody.mp4', id, {
        fetchImpl: async () => fakeResponse({ bodyBytes: null }),
      }),
    (err) => {
      assert.equal(err.code, 'empty_response');
      return true;
    }
  );
});

// --- 6. File-size limit handled ---------------------------------------------

test('6. a Content-Length over the limit is rejected without downloading', async () => {
  const id = '66666666-6666-6666-6666-666666666666';
  let bodyRead = false;
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/huge.mp4', id, {
        fetchImpl: async () => {
          const res = fakeResponse({ headers: { 'content-length': '999999' } });
          const originalGetReader = res.body.getReader.bind(res.body);
          res.body.getReader = (...args) => {
            bodyRead = true;
            return originalGetReader(...args);
          };
          return res;
        },
      }),
    (err) => {
      assert.equal(err.code, 'too_large');
      return true;
    }
  );
  assert.equal(bodyRead, false, 'the body must never be streamed once Content-Length already exceeds the limit');
});

test('6b. a stream that exceeds the limit without a Content-Length header is caught mid-download', async () => {
  const id = '77777777-7777-7777-7777-777777777777';
  const bigBuffer = Buffer.alloc(2048, 'a'); // bigger than the 1024-byte test limit
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://example.com/big.mp4', id, {
        fetchImpl: async () => fakeResponse({ bodyBytes: bigBuffer }),
      }),
    (err) => {
      assert.equal(err.code, 'too_large');
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(assetsTempDir, `${id}.mp4`)), false, 'an oversized download must not be kept');
});

// --- 7. Path traversal prevented --------------------------------------------

test('7. resolveStoredPath rejects path traversal attempts', () => {
  const isInvalidPath = (err) => {
    assert.equal(err.code, 'invalid_path');
    return true;
  };
  assert.throws(() => assetStorage.resolveStoredPath('../../etc/passwd'), isInvalidPath);
  assert.throws(() => assetStorage.resolveStoredPath('/etc/passwd'), isInvalidPath);
  assert.throws(() => assetStorage.resolveStoredPath('a/../../b'), isInvalidPath);
});

test('7b. the stored filename is always built from assetId + a whitelisted extension, never from the URL path', async () => {
  const id = '88888888-8888-8888-8888-888888888888';
  // The URL's own path traversal segments (which the WHATWG URL parser
  // normalizes away) must have no bearing on where the file actually gets
  // saved — only assetId + the whitelisted extension matter.
  const result = await assetStorage.downloadAsset('https://example.com/../../evil.mp4?x=1#frag', id, {
    fetchImpl: async () => fakeResponse(),
  });
  assert.equal(result.relativePath, `${id}.mp4`);
});

test('7c. an unrecognized extension falls back to a safe generic one', async () => {
  const id = '99999999-9999-9999-9999-999999999999';
  const result = await assetStorage.downloadAsset('https://example.com/thing.exe', id, {
    fetchImpl: async () => fakeResponse(),
  });
  assert.equal(result.relativePath, `${id}.bin`);
});

// --- successful download + never-overwrite idempotency ---------------------

test('a successful download is saved under ASSETS_DIR and reported correctly', async () => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const result = await assetStorage.downloadAsset('https://example.com/video.mp4', id, {
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'video/mp4' }, bodyBytes: Buffer.from('hello') }),
  });

  assert.equal(result.alreadyExisted, false);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(result.sizeBytes, 5);
  assert.ok(fs.existsSync(path.join(assetsTempDir, `${id}.mp4`)));
});

test('a second download for the same assetId never overwrites the existing file', async () => {
  const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return fakeResponse({ bodyBytes: Buffer.from('original content') });
  };

  const first = await assetStorage.downloadAsset('https://example.com/video.mp4', id, { fetchImpl });
  const second = await assetStorage.downloadAsset('https://example.com/DIFFERENT-URL.mp4', id, { fetchImpl });

  assert.equal(callCount, 1, 'fetch must only be called once — the second call must reuse the existing file');
  assert.equal(second.alreadyExisted, true);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'original content');
});
