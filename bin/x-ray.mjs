#!/usr/bin/env node
// The `x-ray` command.
//
// X-Ray is a static web app with no backend, so this command does the one thing
// it cannot do for itself: serve the built files over http://localhost and open
// a browser at them.
//
// It has to be http://localhost rather than opening index.html from disk,
// because browsers only allow the File System Access API (the folder picker) in
// a *secure context* — and localhost counts as one while file:// does not. The
// server is read-only, bound to the loopback interface, and stops with Ctrl+C.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist');
const DEFAULT_PORT = 4720;
const LOOPBACK = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.razor': 'text/plain; charset=utf-8',
  '.csproj': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
};

// --- arguments -------------------------------------------------------------

const HELP = `
  x-ray — see how your codebase works, in your browser.

  Usage
    $ x-ray [options]

  Options
    -p, --port <number>   Port to serve on (default ${DEFAULT_PORT}; the next free one is used if it is busy)
        --host <address>  Interface to bind (default ${LOOPBACK}, loopback only)
        --no-open         Do not open a browser automatically
    -h, --help            Show this message
    -v, --version         Show the version

  Then: open the URL it prints, choose a folder (or "Explore sample project")
  and X-Ray maps it. Your files are read, never changed, and never uploaded.

  Nothing leaves this machine unless you configure an AI endpoint in Settings.
`;

function parseArgs(argv) {
  const options = { port: null, host: LOOPBACK, open: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--open') options.open = true;
    else if (arg === '-p' || arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        fail(`--port needs a number between 1 and 65535 (got "${argv[i]}").`);
      }
      options.port = value;
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`--port needs a number between 1 and 65535.`);
      options.port = value;
    } else if (arg === '--host') {
      options.host = argv[++i] ?? LOOPBACK;
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else {
      fail(`Unknown option "${arg}".\n${HELP}`);
    }
  }
  return options;
}

function fail(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

// --- static files ----------------------------------------------------------

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = normalize(join(DIST, relative));
  // Never serve anything outside the built app.
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  // SPA fallback: unknown paths without a file extension are the app's routes.
  if (!extname(relative)) return join(DIST, 'index.html');
  return null;
}

function serve(options) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('X-Ray only serves files.\n');
      return;
    }

    const file = resolveRequestPath(req.url ?? '/');
    if (!file || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found.\n');
      return;
    }

    let body;
    try {
      body = readFileSync(file);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Could not read ${file}.\n${err.message}\n`);
      return;
    }

    const name = file.slice(DIST.length + 1).split(sep).join('/');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // Hashed asset names are content-addressed, so they can be cached hard;
      // index.html must always be re-checked or an update would go unnoticed.
      'Cache-Control': name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });

  let attempt = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && options.port === null && attempt < 20) {
      attempt++;
      server.listen(DEFAULT_PORT + attempt, options.host);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      fail(
        `Port ${options.port ?? server.address()?.port} is already in use.\n` +
          `  Pick another one:  x-ray --port ${(options.port ?? DEFAULT_PORT) + 1}`,
      );
    }
    fail(`Could not start the local server: ${err.message}`);
  });

  server.listen(options.port ?? DEFAULT_PORT, options.host, () => {
    const { port } = server.address();
    const url = `http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}/`;
    banner(url, options);
    if (options.open) openBrowser(url);
  });

  const shutdown = () => {
    process.stdout.write('\n  X-Ray stopped. Your files were never modified.\n\n');
    server.close(() => process.exit(0));
    // Do not wait forever for a keep-alive connection.
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function banner(url, options) {
  const lines = [
    '',
    '  X-Ray is running',
    `  ▸ ${url}`,
    '',
    '  Open that address if the browser did not. Choose a folder there — X-Ray',
    '  reads it, never writes to it, and nothing is uploaded.',
    '',
    '  Ctrl+C to stop.',
  ];
  if (options.host !== LOOPBACK && options.host !== 'localhost') {
    lines.splice(4, 0, `  ⚠  Bound to ${options.host}, so other machines on this network can reach it too.`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stdout.write(`  (Could not open a browser automatically — open ${url} yourself.)\n`);
    });
    child.unref();
  } catch {
    process.stdout.write(`  (Could not open a browser automatically — open ${url} yourself.)\n`);
  }
}

// --- main ------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.version) {
    const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (!existsSync(join(DIST, 'index.html'))) {
    fail(
      'The built app is missing, so there is nothing to serve.\n' +
        '  From a checkout, run:  npm install && npm run build\n' +
        `  Expected:             ${DIST}`,
    );
  }

  serve(options);
}

main();
