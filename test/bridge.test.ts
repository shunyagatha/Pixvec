/**
 * The local bridge is the one part of vecline that opens a socket, so its
 * tests are mostly about what it *refuses*. Each case below corresponds to a
 * control in the file's threat model; if one of these ever goes green-to-red,
 * a real attack surface has opened.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { isAllowedOrigin, isLoopbackHost, safeExtension, startBridge, type BridgeHandle } from '../src/io/bridge.js';

/** A GET that can set headers `fetch` forbids — notably `Host`. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('origin allowlist', () => {
  it('permits the Studio and its GitHub Pages origin', () => {
    expect(isAllowedOrigin('https://vecline.xyz')).toBe(true);
    expect(isAllowedOrigin('https://www.vecline.xyz')).toBe(true);
    expect(isAllowedOrigin('https://shunyagatha.github.io')).toBe(true);
  });

  it('does NOT wave through loopback origins by default', () => {
    // An earlier version allowed any localhost origin on any port so a local
    // Studio build would just work. A security review pointed out that this
    // hands full bridge access to every other page served from localhost —
    // a much larger set than "the Studio". Developers opt in per port instead.
    expect(isAllowedOrigin('http://localhost:5173')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(false);
  });

  it('permits a loopback origin the user named explicitly', () => {
    expect(isAllowedOrigin('http://localhost:5173', ['http://localhost:5173'])).toBe(true);
    // …and only that one, not its neighbours on other ports.
    expect(isAllowedOrigin('http://localhost:9999', ['http://localhost:5173'])).toBe(false);
  });

  it('refuses everything else', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://evil.example')).toBe(false);
  });

  it('is not fooled by an origin that merely contains an allowed one', () => {
    // The whole point of comparing whole origins rather than substrings.
    expect(isAllowedOrigin('https://vecline.xyz.evil.example')).toBe(false);
    expect(isAllowedOrigin('https://evil.example/vecline.xyz')).toBe(false);
    expect(isAllowedOrigin('https://notvecline.xyz')).toBe(false);
    expect(isAllowedOrigin('https://localhost.evil.example:80')).toBe(false);
  });

  it('allows an explicitly configured extra origin, and only that one', () => {
    expect(isAllowedOrigin('https://staging.example', ['https://staging.example'])).toBe(true);
    expect(isAllowedOrigin('https://other.example', ['https://staging.example'])).toBe(false);
  });

  it('allows a request with no Origin — no browser sent it', () => {
    // A page cannot omit `Origin` on a cross-origin request, so this only ever
    // admits local tooling, which already has the user's own privileges.
    expect(isAllowedOrigin(undefined)).toBe(true);
  });
});

describe('DNS-rebinding defence', () => {
  it('accepts only loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1:7654')).toBe(true);
    expect(isLoopbackHost('localhost:7654')).toBe(true);
    expect(isLoopbackHost('[::1]:7654')).toBe(true);
  });

  it('rejects an attacker domain pointed at 127.0.0.1', () => {
    expect(isLoopbackHost('evil.example:7654')).toBe(false);
    expect(isLoopbackHost('localhost.evil.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('extension handling', () => {
  it('reduces a filename to its extension', () => {
    expect(safeExtension('Q3 report.xlsx', 'docx')).toBe('xlsx');
    expect(safeExtension('.pptx', 'docx')).toBe('pptx');
    expect(safeExtension('ODT', 'docx')).toBe('odt');
  });

  it('falls back for anything not on the allowlist', () => {
    expect(safeExtension('payload.exe', 'docx')).toBe('docx');
    expect(safeExtension(undefined, 'pdf')).toBe('pdf');
    expect(safeExtension('', 'pdf')).toBe('pdf');
  });

  it('cannot be used to escape a directory', () => {
    // Even a deliberate traversal reduces to an allowlisted token or the
    // fallback — there is no way to get a separator out of this function.
    for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32\\cmd.exe', 'a/b/c.docx/../../x']) {
      const out = safeExtension(hostile, 'docx');
      expect(out).not.toMatch(/[/\\.]/);
      expect(['docx', 'pdf', 'txt', 'html', 'csv', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp']).toContain(out);
    }
  });
});

describe('the running server', () => {
  let bridge: BridgeHandle;
  let base: string;

  beforeAll(async () => {
    // Port 0 lets the OS pick a free one, so the suite never collides with a
    // bridge the developer happens to be running.
    bridge = await startBridge({ port: 0, allowOrigin: ['http://localhost:5173'] });
    base = `http://127.0.0.1:${bridge.port}`;
  });

  afterAll(async () => { await bridge.close(); });

  it('answers a capability probe from an allowed origin', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://vecline.xyz' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://vecline.xyz');

    const body = await res.json() as { name: string; capabilities: { office: boolean; formats: string[] } };
    expect(body.name).toBe('vecline');
    // Reports what is actually installed rather than what is supported — the
    // Studio uses this to decide whether to offer Office conversion at all.
    expect(typeof body.capabilities.office).toBe('boolean');
    expect(body.capabilities.formats).toContain('pdf');
  });

  it('refuses a hostile origin outright', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('opts in to Private Network Access only for allowed origins', async () => {
    const ok = await fetch(`${base}/office`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://vecline.xyz',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');

    const bad = await fetch(`${base}/office`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-private-network')).toBeNull();
  });

  it('rejects a rebound Host even when the origin would pass', async () => {
    // `fetch` cannot express this: `Host` is a forbidden header name, so the
    // browser/undertaking silently drops it and the request arrives looking
    // perfectly normal. A rebinding attacker is not using fetch's rules — the
    // Host arrives as whatever their DNS made the browser believe — so the test
    // has to speak HTTP directly to reproduce the real condition.
    const status = await rawGet(bridge.port, '/health', {
      Host: 'evil.example',
      Origin: 'https://vecline.xyz',
    });
    expect(status).toBe(421);
  });

  it('still accepts a legitimate loopback Host over the same raw path', async () => {
    // Guards against the previous test passing for the wrong reason — a broken
    // raw request would also "reject".
    const status = await rawGet(bridge.port, '/health', {
      Host: `127.0.0.1:${bridge.port}`,
      Origin: 'https://vecline.xyz',
    });
    expect(status).toBe(200);
  });

  it('has no endpoint but the two it documents', async () => {
    for (const path of ['/', '/etc/passwd', '/../../secret', '/convert']) {
      const res = await fetch(`${base}${path}`, { headers: { Origin: 'https://vecline.xyz' } });
      expect(res.status).toBe(404);
    }
  });

  it('answers an oversize body with 413 instead of dropping the connection', async () => {
    // The first implementation destroyed the socket the moment the cap was
    // exceeded, which protected memory but left the client with a truncated
    // response — a bare `100 Continue` — and no idea what had happened. The
    // stream is now paused so a real status can be written first.
    const tooBig = new Uint8Array(65 * 1024 * 1024);
    const res = await fetch(`${base}/office?to=pdf`, {
      method: 'POST',
      headers: { Origin: 'https://vecline.xyz', 'X-Vecline-Filename': 'big.docx' },
      body: tooBig,
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/64 MB/);
  }, 60_000);

  it('rejects an empty document rather than invoking LibreOffice', async () => {
    const res = await fetch(`${base}/office?to=pdf`, {
      method: 'POST',
      headers: { Origin: 'https://vecline.xyz' },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });
});

describe('token authentication', () => {
  let bridge: BridgeHandle;
  let base: string;

  beforeAll(async () => {
    bridge = await startBridge({ port: 0, token: 'correct-horse-battery-staple' });
    base = `http://127.0.0.1:${bridge.port}`;
  });

  afterAll(async () => { await bridge.close(); });

  it('refuses a request with no token', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://vecline.xyz' } });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token, including one of a different length', async () => {
    for (const wrong of ['nope', 'correct-horse-battery-stapl', 'correct-horse-battery-staplex']) {
      const res = await fetch(`${base}/health`, {
        headers: { Origin: 'https://vecline.xyz', 'X-Vecline-Token': wrong },
      });
      expect(res.status).toBe(401);
    }
  });

  it('accepts the right token', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'https://vecline.xyz', 'X-Vecline-Token': 'correct-horse-battery-staple' },
    });
    expect(res.status).toBe(200);
  });

  it('still answers a preflight, which cannot carry the token', async () => {
    // A browser sends no custom headers on the preflight itself, so demanding
    // the token there would make every real request fail before it started.
    const res = await fetch(`${base}/office`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://vecline.xyz', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
  });
});
