import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureThought } from './shared/ai-calls/brainCapture.js';
import { selectBrainContext } from './shared/ai-calls/brainSelector.js';
import { listGames } from './shared/ai-calls/gameLibrary.js';
import { listPrompts, readPrompt, writePrompt } from './shared/ai-calls/promptFiles.js';
import { readHandoff, writeHandoff } from './shared/ai-calls/beatPicks.js';
import { removeAsset, replaceAsset } from './shared/ai-calls/assetSelection.js';
import { fetchAsset, parseAssetProxyPath } from './shared/ai-calls/assetProxy.js';
import { generateUgcScript } from './shared/ai-calls/ugcScriptWriter.js';
import { answerWikiQuestion } from './shared/ai-calls/wikiResponder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8790);
const distDir = path.resolve(__dirname, process.env.DIST_DIR || 'dist');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
};

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(data));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/storage/brain-files/')) {
    const filePath = path.resolve(__dirname, pathname.slice(1));
    const storageRoot = path.resolve(__dirname, 'storage');

    if (!filePath.startsWith(storageRoot)) {
      sendJson(response, 403, { error: 'Forbidden.' });
      return;
    }

    try {
      const file = await readFile(filePath);

      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      });
      response.end(file);
    } catch {
      sendJson(response, 404, { error: 'File not found.' });
    }

    return;
  }

  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(distDir, cleanPath.slice(1));
  const root = distDir;

  if (!filePath.startsWith(root)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    const file = await readFile(filePath);

    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
    });
    response.end(file);
  } catch {
    try {
      const file = await readFile(path.join(distDir, 'index.html'));

      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(file);
    } catch {
      sendJson(response, 404, { error: 'File not found.' });
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  if (url.pathname === '/api/games' && request.method === 'GET') {
    sendJson(response, 200, { games: await listGames() });
    return;
  }

  // Asset bytes for the browser. The finder's routes need ASSET_ACCESS_TOKEN, which must never
  // reach the client, so the token is attached here instead.
  const assetProxy = parseAssetProxyPath(url.pathname);

  if (assetProxy && request.method === 'GET') {
    try {
      const asset = await fetchAsset({
        ...assetProxy,
        download: url.searchParams.get('download') === '1',
      });
      const headers = {
        'Content-Type': asset.contentType,
        'Cache-Control': 'private, max-age=300',
      };

      if (asset.contentDisposition) {
        headers['Content-Disposition'] = asset.contentDisposition;
      }

      response.writeHead(200, headers);
      response.end(asset.body);
    } catch (error) {
      sendJson(response, error.statusCode || 502, { error: error.message });
    }

    return;
  }

  // The downstream UGC-ad agent reads this: script + exactly one asset per scene.
  if (/^\/api\/runs\/[^/]+\/handoff$/.test(url.pathname) && request.method === 'GET') {
    try {
      sendJson(response, 200, await readHandoff(url.pathname.split('/')[3], { cwd: __dirname }));
    } catch (error) {
      sendJson(response, 404, { error: error.message });
    }

    return;
  }

  // Choose / remove / replace happen on the ad-level asset pool; the survivors are what ship.
  if (/^\/api\/runs\/[^/]+\/assets\/(remove|replace)$/.test(url.pathname) && request.method === 'POST') {
    const [, , , runId, , verb] = url.pathname.split('/');

    try {
      const body = await readJsonBody(request);
      const action = verb === 'remove' ? removeAsset : replaceAsset;
      const result = await action({ runId, assetId: body.assetId, cwd: __dirname });

      // Keep handoff.json in step so the downstream always reads the current set.
      const runDir = path.join(__dirname, 'storage', 'outputs', path.basename(runId));
      let script = { scenes: [] };
      let beats = [];

      try {
        script = JSON.parse(await readFile(path.join(runDir, 'ugc-script.json'), 'utf8'));
      } catch { /* handoff still writes, without scene prose */ }

      try {
        beats = JSON.parse(await readFile(path.join(runDir, 'asset-beats.json'), 'utf8')).beats || [];
      } catch { /* no beats file when sourcing was off */ }

      await writeHandoff({
        runId,
        gameId: body.gameId,
        game: body.game,
        script,
        beats,
        selection: result.selection,
        cwd: __dirname,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/prompts' && request.method === 'GET') {
    sendJson(response, 200, { prompts: await listPrompts({ cwd: __dirname }) });
    return;
  }

  if (url.pathname.startsWith('/api/prompts/') && request.method === 'GET') {
    try {
      sendJson(response, 200, await readPrompt(url.pathname.slice('/api/prompts/'.length), {
        cwd: __dirname,
      }));
    } catch (error) {
      sendJson(response, 404, { error: error.message });
    }

    return;
  }

  if (url.pathname.startsWith('/api/prompts/') && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      sendJson(response, 200, await writePrompt(url.pathname.slice('/api/prompts/'.length), body.text, {
        cwd: __dirname,
      }));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/brain' && request.method === 'GET') {
    try {
      sendJson(response, 200, JSON.parse(await readFile(path.join(__dirname, 'storage', 'brain.json'), 'utf8')));
    } catch {
      sendJson(response, 200, {});
    }

    return;
  }

  if (url.pathname === '/api/brain' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      await mkdir(path.join(__dirname, 'storage'), { recursive: true });
      await writeFile(path.join(__dirname, 'storage', 'brain.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      sendJson(response, 200, { saved: true });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/brain/upload' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);
      const safeName = path.basename(String(body.name || 'file')).replace(/[^\w.\- ()]+/g, '_');
      const safeThought = String(body.thoughtId || 'misc').replace(/[^\w-]+/g, '_');
      const dir = path.join(__dirname, 'storage', 'brain-files', safeThought);

      await mkdir(dir, { recursive: true });

      const absolutePath = path.join(dir, safeName);

      await writeFile(absolutePath, Buffer.from(body.dataBase64 || '', 'base64'));
      sendJson(response, 200, {
        name: safeName,
        path: path.relative(__dirname, absolutePath).split(path.sep).join('/'),
      });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/brain/capture' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      sendJson(response, 200, await captureThought({ text: body.text, brain: body.brain }));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/brain/select' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      sendJson(response, 200, await selectBrainContext({
        brief: body.brief,
        model: body.model,
        rootDir: __dirname,
      }));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/ask-wiki' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      sendJson(response, 200, await answerWikiQuestion({
        gameId: body.gameId,
        question: body.question,
      }));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  if (url.pathname === '/api/write-script' && request.method === 'POST') {
    try {
      const body = await readJsonBody(request);

      sendJson(response, 200, await generateUgcScript({
        gameId: body.gameId || undefined,
        userBrief: body.userBrief,
        // Off for the UGC ad; the storytelling ad opts in.
        sourceAssets: body.sourceAssets === true,
      }));
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }

    return;
  }

  await serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Tamatem Wiki running at http://${host}:${port}`);
});
