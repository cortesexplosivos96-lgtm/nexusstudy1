const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY   || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// Modelos gratuitos estáveis (sem rate limit 429)
const MODEL_TEXTO  = 'meta-llama/llama-3.3-70b-instruct:free';
const MODEL_VISAO  = 'google/gemini-2.0-flash-thinking-exp:free';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

function hasImage(body) {
  return (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
  );
}

function callDeepSeek(body) {
  body = { ...body, model: 'deepseek-chat' };
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
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    req.write(json); req.end();
  });
}

function callOpenRouter(body, model) {
  body = { ...body, model: model || MODEL_TEXTO };
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
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, raw: data }));
    });
    req.on('error', reject);
    req.write(json); req.end();
  });
}

async function callAI(body) {
  const imagem = hasImage(body);

  // Com imagem → OpenRouter com modelo de visão
  if (imagem) {
    if (!OPENROUTER_KEY) throw new Error('Chave OpenRouter não configurada para análise de imagens.');
    return callOpenRouter(body, MODEL_VISAO);
  }

  // Texto → DeepSeek se tiver chave, senão OpenRouter com llama gratuito
  if (DEEPSEEK_KEY) return callDeepSeek(body);
  if (OPENROUTER_KEY) return callOpenRouter(body, MODEL_TEXTO);

  throw new Error('Nenhuma chave de IA configurada. Adicione DEEPSEEK_API_KEY ou OPENROUTER_API_KEY no Railway.');
}

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

  // Estáticos
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
  const modo = DEEPSEEK_KEY ? 'DeepSeek Chat' : OPENROUTER_KEY ? `OpenRouter (${MODEL_TEXTO})` : '⚠️ SEM CHAVE';
  console.log(`✅ Nexus Study — porta ${PORT} — IA: ${modo}`);
});
