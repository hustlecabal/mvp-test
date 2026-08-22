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

// --- P0 Golden Run Blocker Repair, Blocker A — authenticated downloads -----
//
// asset-storage.js stays provider-agnostic: it never inspects `url` to
// decide what to send, it only forwards whatever `headers` the caller
// (who already knows which provider issued this URL) supplies.

test('P0-A.1 a public URL with no headers option calls fetchImpl with just the URL, unchanged from before', async () => {
  const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  let receivedArgs;
  await assetStorage.downloadAsset('https://example.com/public.mp4', id, {
    fetchImpl: async (...args) => {
      receivedArgs = args;
      return fakeResponse({ bodyBytes: Buffer.from('public bytes') });
    },
  });
  assert.equal(receivedArgs.length, 1, 'no second argument should be passed to fetchImpl when no headers are given');
});

test('P0-A.2 an authenticated (e.g. Apify) URL forwards the supplied headers to fetchImpl', async () => {
  const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  let receivedHeaders;
  await assetStorage.downloadAsset('https://api.apify.com/v2/key-value-stores/x/records/y.mp4', id, {
    fetchImpl: async (url, options) => {
      receivedHeaders = options && options.headers;
      return fakeResponse({ bodyBytes: Buffer.from('authenticated bytes') });
    },
    headers: { Authorization: 'Bearer real-apify-token' },
  });
  assert.deepEqual(receivedHeaders, { Authorization: 'Bearer real-apify-token' });
});

test('P0-A.3 a failed authenticated download (e.g. wrong/expired token) still fails structurally with the HTTP status, headers are never swallowed into a false success', async () => {
  const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  await assert.rejects(
    () =>
      assetStorage.downloadAsset('https://api.apify.com/v2/key-value-stores/x/records/y.mp4', id, {
        fetchImpl: async () => fakeResponse({ ok: false, status: 403 }),
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    (err) => {
      assert.equal(err.code, 'http_error');
      assert.equal(err.httpStatus, 403);
      return true;
    }
  );
  assert.ok(!fs.existsSync(path.join(assetsTempDir, `${id}.mp4`)), 'no file should be left behind after a failed authenticated download');
});

test('P0-A.4 a missing/undefined headers option (e.g. no token available) behaves exactly like no headers were ever passed, never throws', async () => {
  const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  let receivedArgs;
  const result = await assetStorage.downloadAsset('https://example.com/no-auth-needed.mp4', id, {
    fetchImpl: async (...args) => {
      receivedArgs = args;
      return fakeResponse({ bodyBytes: Buffer.from('bytes') });
    },
    headers: undefined,
  });
  assert.equal(receivedArgs.length, 1);
  assert.equal(result.alreadyExisted, false);
});

// --- Stage 13D, Part 6 — storeUploadedImage / sniffImageFormat (human-upload ingestion) -----

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = Buffer.from('GIF89a' + '\x00\x00\x00\x00', 'ascii');
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')]);

test('sniffImageFormat recognizes PNG/JPEG/GIF/WEBP purely from magic bytes', () => {
  assert.deepEqual(assetStorage.sniffImageFormat(PNG_BYTES), { ext: '.png', contentType: 'image/png' });
  assert.deepEqual(assetStorage.sniffImageFormat(JPEG_BYTES), { ext: '.jpg', contentType: 'image/jpeg' });
  assert.deepEqual(assetStorage.sniffImageFormat(GIF_BYTES), { ext: '.gif', contentType: 'image/gif' });
  assert.deepEqual(assetStorage.sniffImageFormat(WEBP_BYTES), { ext: '.webp', contentType: 'image/webp' });
});

test('sniffImageFormat rejects unsupported bytes, never guessing from a filename', () => {
  assert.equal(assetStorage.sniffImageFormat(Buffer.from('not an image, just text')), null);
  assert.equal(assetStorage.sniffImageFormat(Buffer.from([0x25, 0x50, 0x44, 0x46])), null); // %PDF
  assert.equal(assetStorage.sniffImageFormat(Buffer.alloc(0)), null);
  assert.equal(assetStorage.sniffImageFormat('not-a-buffer'), null);
});

test('storeUploadedImage writes a valid image under assetId + the sniffed extension, ignoring any claimed filename', () => {
  const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const result = assetStorage.storeUploadedImage(PNG_BYTES, id);
  assert.equal(result.relativePath, `${id}.png`);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.sizeBytes, PNG_BYTES.length);
  assert.ok(fs.existsSync(path.join(assetsTempDir, `${id}.png`)));
});

test('storeUploadedImage rejects an unsupported format (Part 12: unsupported image rejection)', () => {
  const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  assert.throws(
    () => assetStorage.storeUploadedImage(Buffer.from('just some text, not an image'), id),
    (err) => {
      assert.equal(err.code, 'unsupported_format');
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(assetsTempDir, `${id}.png`)), false);
});

test('storeUploadedImage rejects an oversized upload (Part 12: file-size limit)', () => {
  const id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2048, 'a')]); // bigger than the 1024-byte test limit
  assert.throws(
    () => assetStorage.storeUploadedImage(big, id, { maxBytes: 1024 }),
    (err) => {
      assert.equal(err.code, 'too_large');
      return true;
    }
  );
});

test('storeUploadedImage rejects an empty buffer', () => {
  const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  assert.throws(
    () => assetStorage.storeUploadedImage(Buffer.alloc(0), id),
    (err) => {
      assert.equal(err.code, 'empty_upload');
      return true;
    }
  );
});

test('storeUploadedImage refuses an invalid (non-server-generated) asset id — never accepts an arbitrary id', () => {
  assert.throws(
    () => assetStorage.storeUploadedImage(PNG_BYTES, 'not-a-uuid'),
    (err) => {
      assert.equal(err.code, 'invalid_asset_id');
      return true;
    }
  );
  assert.throws(
    () => assetStorage.storeUploadedImage(PNG_BYTES, '../../etc/passwd'),
    (err) => {
      assert.equal(err.code, 'invalid_asset_id');
      return true;
    }
  );
});

test('storeUploadedImage never overwrites an existing file for the same assetId', () => {
  const id = '12121212-1212-1212-1212-121212121212';
  const otherPng = Buffer.concat([PNG_BYTES, Buffer.from('first upload')]);
  assetStorage.storeUploadedImage(otherPng, id);
  assert.throws(
    () => assetStorage.storeUploadedImage(PNG_BYTES, id), // same sniffed extension (.png) -> same path
    (err) => {
      assert.equal(err.code, 'already_exists');
      return true;
    }
  );
  // the original bytes must be untouched
  assert.deepEqual(fs.readFileSync(path.join(assetsTempDir, `${id}.png`)), otherPng);
});
