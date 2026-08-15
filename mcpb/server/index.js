#!/usr/bin/env node
/**
 * MCPB launcher for the Vecline MCP server.
 *
 * Why a launcher rather than a vendored `node_modules`: Vecline's image path
 * uses sharp and resvg, which ship prebuilt *native* binaries chosen per
 * platform and architecture. Baking those into the bundle would mean publishing
 * a separate .mcpb per OS/arch — and shipping the wrong one silently breaks
 * decoding instead of failing loudly. Resolving at launch lets npm pick the
 * right binaries for the machine actually running it.
 *
 * Order of preference:
 *   1. a `vecline` already on PATH (global or local install) — instant, offline
 *   2. `npx -y vecline@<pinned>` — fetched once, then served from npm's cache
 *
 * The child speaks JSON-RPC over stdio, so stdio is inherited untouched: this
 * process adds no framing, no buffering, and never writes to stdout itself.
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');

// Pinned so a bundle always launches the version it was tested against.
const VERSION = '1.39.0';

const isWindows = process.platform === 'win32';

/**
 * Build the real argv for a command.
 *
 * On Windows `npx` and `vecline` are `.cmd` shims, and Node refuses to spawn
 * those directly (the CVE-2024-27980 hardening) — while `shell: true` is
 * deprecated for arg-bearing calls (DEP0190), because a shell concatenates
 * arguments instead of escaping them. Invoking the interpreter explicitly
 * satisfies both: the shim runs, and argv stays a real array.
 */
function argvFor(command, args) {
  if (!isWindows) return { file: command, argv: args };
  return {
    file: process.env.ComSpec || 'cmd.exe',
    // /d skips AutoRun scripts, /s normalises quoting, /c runs and exits.
    argv: ['/d', '/s', '/c', command, ...args],
  };
}

/** Is this command runnable right now? Probes stay silent on both streams. */
function isAvailable(command, args) {
  try {
    const { file, argv } = argvFor(command, args);
    const probe = spawnSync(file, argv, {
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true,
    });
    return probe.status === 0;
  } catch {
    // ENOENT means "not installed"; anything else is equally unusable.
    return false;
  }
}

function resolveLaunch() {
  // An installed copy is strictly better: no network, no npx resolution delay.
  if (isAvailable('vecline', ['--version'])) {
    return argvFor('vecline', ['mcp']);
  }
  if (isAvailable('npx', ['--version'])) {
    return argvFor('npx', ['-y', `vecline@${VERSION}`, 'mcp']);
  }
  return null;
}

const launch = resolveLaunch();

if (!launch) {
  // stderr, never stdout: stdout is the JSON-RPC channel, and a stray byte
  // there corrupts the stream for the client.
  process.stderr.write(
    'Vecline MCP: could not start.\n' +
      'Node.js 18.17+ with npm is required, and neither `vecline` nor `npx` could be run.\n' +
      'Install Node.js from https://nodejs.org, or install the CLI directly:\n' +
      '  npm install -g vecline\n',
  );
  process.exit(1);
}

const child = spawn(launch.file, launch.argv, {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (err) => {
  process.stderr.write(`Vecline MCP: failed to launch — ${err.message}\n`);
  process.exit(1);
});

// Mirror the child's fate so the host sees an accurate exit reason.
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

// Pass shutdown through rather than orphaning the server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
