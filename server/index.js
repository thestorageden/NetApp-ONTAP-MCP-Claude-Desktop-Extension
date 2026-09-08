#!/usr/bin/env node
'use strict';

/**
 * Desktop Extension wrapper for NetApp's ONTAP-MCP server.
 *
 * ONTAP-MCP (https://github.com/NetApp/ontap-mcp) only speaks Streamable HTTP
 * and ships as a Docker image — it has no stdio mode. Claude Desktop's local
 * MCP Extensions, on the other hand, only know how to talk to a local process
 * over stdio. This script bridges the two:
 *
 *   1. Writes an ontap.yaml credentials file from the user's extension
 *      settings.
 *   2. Ensures the ghcr.io/netapp/ontap-mcp Docker container is running,
 *      published only to 127.0.0.1 on this machine.
 *   3. Waits for it to become healthy, then loads `mcp-remote` (bundled in
 *      node_modules) directly into this process — not as a child process —
 *      so it takes over this process's real stdin/stdout and bridges them
 *      to that local HTTP server.
 *
 * IMPORTANT: Claude Desktop can start a separate instance of this process per
 * session/surface (e.g. Cowork and Code each get their own), and all of them
 * share the same container name and port. So this script never assumes it
 * owns the container: it checks whether one is already running and reuses it,
 * only removes containers that are genuinely stopped, tolerates another
 * instance winning a startup race, and never stops the container on its own
 * exit (another instance may still be using it).
 *
 * All of Docker's own output is written to a log file under
 * ~/.ontap-mcp-desktop-extension/ rather than to stdout/stderr, since stdio
 * is reserved for MCP protocol traffic once mcp-remote takes over.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CONTAINER_NAME = 'ontap-mcp-desktop-extension';
const CONFIG_DIR = path.join(os.homedir(), '.ontap-mcp-desktop-extension');
const CONFIG_PATH = path.join(CONFIG_DIR, 'ontap.yaml');
const LOG_PATH = path.join(CONFIG_DIR, 'container.log');

// ---- Logging (never write to stdout/stderr once mcp-remote owns them) ----
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function log(msg) {
  logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}
log('--- ontap-mcp desktop extension starting ---');

function fail(msg) {
  log(`FATAL: ${msg}`);
  // Also surface on stderr in case mcp-remote/stdio bridging hasn't started
  // yet — Claude Desktop captures extension stderr into its own logs.
  process.stderr.write(`ontap-mcp extension: ${msg}\nSee ${LOG_PATH} for details.\n`);
  process.exit(1);
}

// Claude Desktop's ${user_config.KEY} substitution can leave the literal,
// unresolved template text in place for an optional string field with no
// default when the user leaves it blank (observed in practice), rather than
// substituting an empty string. Treat anything that still looks like a
// template placeholder as "not set".
function resolveOptionalString(raw, fallback) {
  const v = (raw || '').trim();
  if (!v || v.includes('${user_config.')) return fallback;
  return v;
}

// ---- Read settings from the environment (populated by manifest.json's user_config) ----
const ADDRESS = resolveOptionalString(process.env.ONTAP_ADDRESS, '');
const USERNAME = resolveOptionalString(process.env.ONTAP_USERNAME, 'admin');
const PASSWORD = resolveOptionalString(process.env.ONTAP_PASSWORD, '');
const INSECURE_TLS = String(process.env.ONTAP_INSECURE_TLS || 'true').toLowerCase() === 'true';
const READ_ONLY = String(process.env.ONTAP_READ_ONLY || 'true').toLowerCase() === 'true';
const DOCKER_IMAGE = resolveOptionalString(process.env.ONTAP_MCP_DOCKER_IMAGE, 'ghcr.io/netapp/ontap-mcp:latest');
const LOCAL_PORT = parseInt(process.env.ONTAP_MCP_LOCAL_PORT, 10) || 8083;
const ADDITIONAL_POLLERS_YAML = resolveOptionalString(process.env.ONTAP_MCP_ADDITIONAL_POLLERS_YAML, '');

if (!ADDRESS) fail('ONTAP Cluster Address is not configured.');
if (!PASSWORD) fail('ONTAP Password is not configured.');

// ---- Build ontap.yaml ----
function yamlString(v) {
  return JSON.stringify(String(v)); // double-quoted YAML scalar; safe for special chars
}

let yaml = 'Pollers:\n';
yaml += '  primary:\n';
yaml += `    addr: ${yamlString(ADDRESS)}\n`;
yaml += `    username: ${yamlString(USERNAME)}\n`;
yaml += `    password: ${yamlString(PASSWORD)}\n`;
yaml += `    use_insecure_tls: ${INSECURE_TLS ? 'true' : 'false'}\n`;

if (ADDITIONAL_POLLERS_YAML) {
  const indented = ADDITIONAL_POLLERS_YAML
    .split('\n')
    .map((line) => (line.length ? '  ' + line : line))
    .join('\n');
  yaml += indented + '\n';
}

// NOTE: this file is shared by every instance of this extension running on
// the machine (Cowork, Code, etc. each launch their own process). Whichever
// instance started (or last reconfigured) most recently wins; that's fine
// since they all point at the same cluster credentials.
fs.writeFileSync(CONFIG_PATH, yaml, { mode: 0o600 });
try {
  fs.chmodSync(CONFIG_PATH, 0o600); // enforce even if umask affected the initial write
} catch (e) {
  /* best effort */
}
log(`Wrote config to ${CONFIG_PATH}`);

// ---- Verify Docker is available ----
const dockerCheck = spawnSync('docker', ['--version']);
if (dockerCheck.error || dockerCheck.status !== 0) {
  fail(
    'Docker was not found (or is not running). Install Docker Desktop from ' +
      'https://www.docker.com/products/docker-desktop/, make sure it is running, then restart this extension.'
  );
}

function getContainerState() {
  const res = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', CONTAINER_NAME], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null; // container doesn't exist
  return (res.stdout || '').trim(); // e.g. "running", "exited", "created"
}

function raceLost(stderrText) {
  // Another concurrently-starting instance of this extension won the race to
  // create/bind the shared container — not an error, just proceed to wait
  // for health against what the other instance is bringing up.
  return /already in use|already allocated|port is already allocated/i.test(stderrText || '');
}

const existingState = getContainerState();
if (existingState === 'running') {
  log('Found an existing running container — reusing it instead of starting a new one.');
} else {
  if (existingState) {
    log(`Removing stale container (state=${existingState}) before starting a fresh one.`);
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME]);
  }

  log(`Pulling ${DOCKER_IMAGE} ...`);
  const pull = spawnSync('docker', ['pull', DOCKER_IMAGE], { encoding: 'utf8' });
  if (pull.stdout) logStream.write(pull.stdout);
  if (pull.stderr) logStream.write(pull.stderr);
  if (pull.status !== 0) {
    log('WARNING: docker pull failed; continuing in case the image is already cached locally.');
  }

  const runArgs = [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `127.0.0.1:${LOCAL_PORT}:8083`,
    '-v',
    `${CONFIG_PATH}:/opt/mcp/ontap.yaml:ro`,
    DOCKER_IMAGE,
    'start',
    '--port',
    '8083',
    '--host',
    '0.0.0.0',
  ];
  if (READ_ONLY) runArgs.push('--read-only');

  log(`Starting container: docker ${runArgs.join(' ')}`);
  // Runs detached and returns immediately — the container's lifetime is not
  // tied to this wrapper process, since other sessions' wrapper processes
  // may depend on it staying up after this one exits.
  const run = spawnSync('docker', runArgs, { encoding: 'utf8' });
  if (run.stdout) logStream.write(run.stdout);
  if (run.stderr) logStream.write(run.stderr);

  if (run.status !== 0) {
    if (raceLost(run.stderr)) {
      log('Another instance appears to be starting the container concurrently — waiting for it to become healthy.');
    } else {
      fail(`Failed to start the ONTAP-MCP container: ${(run.stderr || '').trim() || 'unknown docker error'}`);
    }
  }
}

// ---- Wait for the container's HTTP endpoint to come up ----
function waitForHealth(timeoutMs, intervalMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const req = http.get(
        { host: '127.0.0.1', port: LOCAL_PORT, path: '/health', timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else if (Date.now() - start > timeoutMs) {
            reject(new Error('Timed out waiting for ONTAP-MCP health check'));
          } else {
            setTimeout(attempt, intervalMs);
          }
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              `Timed out waiting for ONTAP-MCP on 127.0.0.1:${LOCAL_PORT}. ` +
                `If that port is used by something else on your machine, change the "Local Port" setting.`
            )
          );
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    }
    attempt();
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

(async () => {
  try {
    await waitForHealth(60000, 500);
  } catch (err) {
    fail(err.message);
    return;
  }

  log('ONTAP-MCP is healthy — starting mcp-remote bridge');

  const mcpRemoteBin = path.join(__dirname, '..', 'node_modules', 'mcp-remote', 'dist', 'proxy.js');
  const targetUrl = `http://127.0.0.1:${LOCAL_PORT}`;

  // NOTE: this deliberately does NOT spawn mcp-remote as a child process.
  // Two different spawn strategies (stdio: 'inherit', then manual
  // process.stdin/stdout piping to a fully 'pipe'-based child) both produced
  // the identical failure in practice: the child exited within ~50-100ms
  // with Windows exit code 0xFFFFFFFF (-1), no 'error' event, and not a
  // single byte of stderr output — even though we were explicitly capturing
  // it. That points at spawning a *second* node.exe process itself being the
  // problem on this machine/runtime, not how its stdio was wired.
  //
  // mcp-remote's CLI entrypoint (dist/proxy.js) is plain top-level code that
  // reads `process.argv` and talks to the real global `process.stdin` /
  // `process.stdout` (via the MCP SDK's StdioServerTransport, which defaults
  // to those). So instead of spawning it, we load it directly into this
  // already-running process: temporarily present the argv it expects, then
  // dynamically import it. It then takes over *our* real stdin/stdout —
  // the same pipes Claude Desktop gave this process directly — with no
  // second process and no relaying involved at all.
  process.argv = [process.execPath, mcpRemoteBin, targetUrl, '--allow-http', '--transport', 'http-only'];

  try {
    await import(require('url').pathToFileURL(mcpRemoteBin).href);
  } catch (err) {
    fail(`mcp-remote bridge failed to load: ${err && err.stack ? err.stack : err}`);
  }
})();
