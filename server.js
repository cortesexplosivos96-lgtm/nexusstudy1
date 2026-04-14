const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ── Pega qualquer chave disponível ────────────────────────────────────────────
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ── Detecta se a requisição tem imagem ───────────────────────────────────────
function hasImage(body) {
  return (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
  );
}

// ── Chama DeepSeek ────────────────────────────────────────────────────────────
function callDeepSeek(body) {
  body.model = 'deepseek-chat';
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
        'Content-Length': Buffer.byteLength(json),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

// ── Chama OpenRouter ──────────────────────────────────────────────────────────
function callOpenRouter(body) {
  if (!body.model || body.model === '') body.model = 'openrouter/auto';
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://nexusstudy1-production-f223.up.railway.app',
        'X-Title': 'Nexus Study',
        'Content-Length': Buffer.byteLength(json),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

// ── Escolhe qual IA usar ──────────────────────────────────────────────────────
async function callAI(body) {
  const temImagem = hasImage(body);

  // Com imagem → sempre OpenRouter (tem visão)
  if (temImagem) {
    body.model = 'meta-llama/llama-3.2-11b-vision-instruct:free';
    return callOpenRouter(body);
  }

  // Sem imagem → tenta DeepSeek primeiro, cai no OpenRouter se não tiver chave
  if (DEEPSEEK_KEY) {
    return callDeepSeek(body);
  }

  return callOpenRouter(body);
}

// ── Servidor ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const { status, raw } = await callAI(parsed);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(raw);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // Arquivos estáticos
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const modo = DEEPSEEK_KEY ? 'DeepSeek Chat' : 'OpenRouter/auto';
  console.log(`✅ Nexus Study rodando na porta ${PORT}`);
  console.log(`   IA ativa: ${modo}`);
});
