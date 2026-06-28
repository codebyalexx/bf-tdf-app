import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session-manager.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 80);
const publicDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public',
);
const manager = new SessionManager({
  rootDirectory: process.env.SESSIONS_DIRECTORY || '.browser-sessions',
  clubQuery: process.env.CLUB_NAME?.trim() || 'Lamballe-Armor',
});

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

let managerReady = false;
let managerError = null;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Corps de requête trop volumineux');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('JSON invalide');
  }
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(publicDirectory, relativePath);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    sendJson(response, 403, { error: 'Accès refusé' });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
    });
    response.end(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 404, { error: 'Ressource introuvable' });
      return;
    }
    throw error;
  }
}

function statusPayload() {
  return {
    state: managerError ? 'error' : managerReady ? 'ready' : 'initializing',
    message: managerError || (managerReady ? 'Sessions opérationnelles' : 'Initialisation'),
    ...manager.snapshot(),
  };
}

async function sendScreenshot(response, sessionId) {
  const image = await manager.screenshot(sessionId);
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="basicfit-session-${sessionId}.png"`,
    'Content-Type': 'image/png',
  });
  response.end(image);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, statusPayload());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/config') {
      const config = await readJsonBody(request);
      const result = await manager.configure(config);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/ranking/refresh') {
      await manager.refreshRanking();
      sendJson(response, 200, manager.snapshot().ranking);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (request.method === 'GET' && sessionMatch) {
      const entry = manager.getEntry(Number(sessionMatch[1]));
      if (!entry) {
        sendJson(response, 404, { error: 'Session introuvable' });
        return;
      }
      sendJson(response, 200, manager.sessionSnapshot(entry));
      return;
    }

    const screenshotMatch = url.pathname.match(
      /^\/api\/sessions\/(\d+)\/screenshot$/,
    );
    if (request.method === 'POST' && screenshotMatch) {
      await sendScreenshot(response, Number(screenshotMatch[1]));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/screenshot') {
      await sendScreenshot(response, 1);
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(response, url.pathname);
      return;
    }

    sendJson(response, 405, { error: 'Méthode non autorisée' });
  } catch (error) {
    console.error(error.stack || error.message);
    if (!response.headersSent) {
      sendJson(response, 500, { error: error.message });
    } else {
      response.end();
    }
  }
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.race([
    manager.close(),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

server.listen(port, host, () => {
  console.log(`Interface disponible sur http://${host}:${port}`);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network?.family === 'IPv4' && !network.internal)
    .map((network) => network.address);
  for (const address of addresses) {
    console.log(`Accès téléphone : http://${address}:${port}`);
  }
});

manager
  .initialize()
  .then(() => {
    managerReady = true;
    console.log('Gestionnaire multi-session prêt');
  })
  .catch((error) => {
    managerError = error.message;
    console.error(`Initialisation : ${error.stack || error.message}`);
  });
