/**
 * The local conversion bridge — `vecline serve`.
 *
 * Some conversions genuinely cannot happen in a browser tab. Office documents
 * need a real office engine, and vecline's answer has always been "drive the
 * LibreOffice you already have" rather than bundling one or uploading your
 * files. That works from the CLI, and left Vecline Studio unable to offer it at
 * all.
 *
 * This is the third option: the CLI, running on your machine, exposing a tiny
 * HTTP endpoint that the Studio can hand a document to. The document goes from
 * your browser to your own process and back. Nothing is uploaded, the privacy
 * claim stays literally true, and you get full LibreOffice fidelity.
 *
 * ---
 *
 * **Threat model, because a localhost server that converts files is a real
 * attack surface.** The danger is not another program running *as you* — that
 * process can already invoke `soffice` itself, so this grants it nothing new.
 * The danger is *a web page you happen to visit* reaching in and driving your
 * machine. Every control below exists for that one attacker:
 *
 * - **Loopback only.** Bound to 127.0.0.1, so nothing off-machine can connect.
 * - **Origin allowlist.** A browser always attaches `Origin` to a cross-origin
 *   request, so a page from anywhere but the allowlist is refused. This is the
 *   primary control. The list is the Studio's own origins plus whatever the user
 *   names with `--allow-origin` — nothing else, not even other loopback ports.
 * - **Host check.** Defeats DNS rebinding, where an attacker's domain is made
 *   to resolve to 127.0.0.1 so their page looks same-origin to the network.
 * - **Private Network Access.** Chrome preflights public→loopback requests and
 *   requires the server to opt in explicitly. Answered only for allowed origins.
 * - **No paths, ever.** The API takes *bytes* and returns *bytes*. No request
 *   field names a file, so there is nothing to traverse or overwrite; temporary
 *   files are ours, in our own temp directory. Error text is filtered too — the
 *   OS message from a failed conversion carries absolute paths and the account
 *   name, so only messages written for a person are sent.
 * - **Bounded input, per request and in aggregate.** One body is capped, and
 *   `MAX_INFLIGHT` bounds how many can be in flight at once.
 * - **Opt-in.** Nothing starts this but the user typing `vecline serve`.
 *
 * Two allowances worth stating rather than leaving to be discovered:
 *
 * - **A request with no `Origin` is allowed.** Only a non-browser client can
 *   omit it, and such a client already has the user's own privileges. See
 *   {@link isAllowedOrigin}.
 * - **Document content is not sandboxed.** LibreOffice resolves external
 *   references in HTML and ODF as it normally would. The output returns only to
 *   whoever sent the bytes, so this is no worse than opening the file yourself —
 *   but it is not a sandbox, and should not be read as one.
 *
 * Request timeouts are Node's defaults; this file sets none of its own.
 *
 * An optional shared secret — `--token-file`, `VECLINE_TOKEN`, or `--token` —
 * adds authentication on top. That one *does* fence out other accounts on a
 * shared host, which is why it should not be passed as a bare argument: the
 * process table is world-readable.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { convertOffice, findSoffice, OFFICE_FORMATS } from './office.js';
import { VERSION } from '../core.js';

/** Where the hosted Studio lives, plus any local build of it. */
const DEFAULT_ORIGINS = [
  'https://vecline.xyz',
  'https://www.vecline.xyz',
  'https://shunyagatha.github.io',
];

/** 64 MB per request. Large enough for a real deck; small enough to bound one body. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Conversions allowed at once.
 *
 * Two rather than a queue, because LibreOffice serialises on a single user
 * profile anyway — piling up children just makes them detect each other and
 * exit. Without this, 32 simultaneous posts were all accepted, and six
 * concurrent 60 MB bodies took resident memory from 100 MB to 722 MB, because
 * the per-request cap has no global accounting behind it.
 */
const MAX_INFLIGHT = 2;
let inflight = 0;

export interface BridgeOptions {
  port?: number;
  /** Extra origins to allow, beyond the Studio's own. */
  allowOrigin?: string[];
  /** Optional shared secret; when set, every request must present it. */
  token?: string;
  /** Path to a LibreOffice binary, when it is not on PATH. */
  soffice?: string;
}

/** Is this origin permitted to talk to the bridge? */
export function isAllowedOrigin(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) {
    // No `Origin` means no browser sent it — a curl or a script, which already
    // has whatever access the user has. The attacker this server defends
    // against is a web page, and a web page cannot omit the header.
    return true;
  }
  // Everything else must be named explicitly with `--allow-origin`. An earlier
  // version waved through *any* loopback origin on *any* port so that a local
  // Studio build would work — which quietly granted full bridge access to every
  // other page served from localhost, a materially larger set than "the Studio".
  // A developer running the studio locally opts in for their own port instead.
  return DEFAULT_ORIGINS.includes(origin) || extra.includes(origin);
}

/**
 * Reject a `Host` that is not loopback.
 *
 * DNS rebinding works by pointing an attacker-controlled name at 127.0.0.1;
 * the connection is local but the browser still believes it is talking to
 * `evil.example`. The `Origin` allowlist already refuses that page, and this
 * closes the door a second time at the transport level.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** Constant-time compare, so a token cannot be guessed one character at a time. */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length, so unequal lengths are compared against a copy of `a` and fail.
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Thrown when a body exceeds the cap, so the handler can answer 413 rather than 500. */
class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`The document exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * Read a request body, bounded.
 *
 * Memory is capped by what is *kept*, not by what arrives, so a sender that
 * declares a small `Content-Length` and then streams gigabytes gets nowhere.
 */
function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  // Past the cap we stop *keeping* chunks but keep *consuming* them, and only
  // reject once the client has finished sending. Answering mid-upload is what a
  // strict reading of the limit suggests, and it does not work: the response
  // races the still-arriving body, and while curl coped, undici reported
  // ECONNRESET and never saw the 413 at all. Draining costs time on a hostile
  // upload but never memory — the bytes are discarded as they arrive — and
  // every client gets a real status. ABORT_MULTIPLE caps the patience.
  const ABORT_MULTIPLE = 4;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (!over && total > limit) {
        over = true;
        chunks.length = 0; // release what was buffered; it is not going to be used
      }
      if (over) {
        // A sender that keeps going far past the cap is not a browser making a
        // mistake, so patience ends here.
        if (total > limit * ABORT_MULTIPLE) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(new BodyTooLarge(limit)) : resolve(Buffer.concat(chunks))));
    req.on('error', (err) => reject(over ? new BodyTooLarge(limit) : err));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // Nothing here is cacheable, and a stale capability probe would be worse
    // than none: the Studio would offer a conversion that is no longer possible.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** CORS + Private Network Access headers, applied only for permitted origins. */
function applyCors(req: IncomingMessage, res: ServerResponse, extra: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, extra)) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Vecline-Filename, X-Vecline-Token');
  // Chrome will not let a public page reach a loopback server without this.
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return true;
}

/**
 * Reduce caller-supplied text to one extension from a fixed allowlist.
 *
 * Accepts a bare extension (`xlsx`, `.xlsx`) or a whole filename
 * (`Q3 report.xlsx`) and keeps only what follows the final dot. Anything not on
 * the list becomes the fallback — so this can never return a path fragment, a
 * traversal sequence, or an extension LibreOffice was not asked about.
 */
export function safeExtension(value: string | undefined, fallback: string): string {
  const raw = String(value ?? '').toLowerCase();
  const ext = (raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw).trim();
  return (OFFICE_FORMATS as readonly string[]).includes(ext) ? ext : fallback;
}

/** Build the request handler. Exported so tests can drive it without a socket. */
export function createBridgeHandler(opts: BridgeOptions = {}) {
  const extraOrigins = opts.allowOrigin ?? [];

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 421, { error: 'This server only answers on localhost.' });
      return;
    }
    if (!applyCors(req, res, extraOrigins)) {
      sendJson(res, 403, { error: 'That origin is not allowed to use the local bridge.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (opts.token && !tokenMatches(opts.token, req.headers['x-vecline-token'] as string | undefined)) {
      sendJson(res, 401, { error: 'Missing or incorrect token.' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    // The capability probe. The Studio calls this to decide whether to offer
    // Office conversion at all, so it reports what is *actually* available
    // rather than what is theoretically supported.
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        name: 'vecline',
        version: VERSION,
        capabilities: {
          office: Boolean(opts.soffice ?? findSoffice()),
          formats: [...OFFICE_FORMATS],
        },
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/office') {
      if (inflight >= MAX_INFLIGHT) {
        res.setHeader('Retry-After', '2');
        sendJson(res, 503, { error: 'The bridge is already converting. Try again in a moment.' });
        return;
      }
      inflight++;

      let dir: string | null = null;
      try {
        const to = safeExtension(url.searchParams.get('to') ?? undefined, 'pdf');
        const from = safeExtension(req.headers['x-vecline-filename'] as string | undefined, 'docx');
        const body = await readBody(req);
        // Spawning LibreOffice for a client that has already gone is pure waste,
        // and the result would have nowhere to be written.
        //
        // The test is on the *response*, deliberately. `req.destroyed` also
        // becomes true on the ordinary happy path once the body has been fully
        // consumed, so checking it here rejected every legitimate request —
        // caught immediately by the empty-document test going red.
        if (res.destroyed || res.writableEnded) return;
        if (body.length === 0) {
          sendJson(res, 400, { error: 'No document was sent.' });
          return;
        }

        // Both filenames are ours, in a directory we just made. Nothing the
        // caller sent is used to construct a path — only to choose an extension
        // from a fixed list — so there is no traversal to defend against.
        dir = await mkdtemp(join(tmpdir(), 'vecline-bridge-'));
        const input = join(dir, `input.${from}`);
        const output = join(dir, `output.${to}`);
        await writeFile(input, body);
        await convertOffice(input, output, { soffice: opts.soffice });
        const converted = await readFile(output);

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': converted.length,
          'Content-Disposition': `attachment; filename="converted.${to}"`,
          'Cache-Control': 'no-store',
        });
        res.end(converted);
      } catch (err) {
        const e = err as Error;
        if (e.name === 'BodyTooLarge') {
          sendJson(res, 413, { error: e.message });
        } else if (e.name === 'OfficeUserError') {
          // Written for a person and safe to send: "install LibreOffice", or
          // "that conversion is unsupported".
          sendJson(res, 500, { error: e.message });
        } else {
          // Everything else — execFile output, fs errno strings — names paths on
          // this machine. An adversarial review caught this reaching an
          // allowlisted page: the OS username, both temp directory layouts and
          // the soffice install path, all readable by script. Detail goes to the
          // operator's own console; the wire gets a flat sentence.
          console.error('[vecline] /office failed:', e);
          sendJson(res, 500, { error: 'The document could not be converted.' });
        }
      } finally {
        inflight--;
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }

    sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
  };
}

export interface BridgeHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Start the bridge on loopback. Resolves once it is actually listening. */
export function startBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const handler = createBridgeHandler(opts);
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // '127.0.0.1' rather than the default wildcard: binding every interface
    // would put a document converter on the local network.
    server.listen(opts.port ?? 7654, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 7654);
      resolve({
        server,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
