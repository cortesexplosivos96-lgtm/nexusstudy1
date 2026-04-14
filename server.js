const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// â”€â”€ Chama DeepSeek para texto, OpenRouter para visÃ£o (foto de comida) â”€â”€â”€â”€â”€â”€â”€â”€â”€
function callAI(body) {
  return new Promise((resolve, reject) => {
    const hasImage = (body.messages || []).some(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
    );

    // Se tem imagem â†’ OpenRouter (modelo com visÃ£o)
    if (hasImage) {
      body.model = 'meta-llama/llama-3.2-11b-vision-instruct:free';
      return callOpenRouter(body, resolve, reject);
    }

    // Texto â†’ DeepSeek (mais preciso e gratuito)
    body.model = 'deepseek-chat';
    return callDeepSeek(body, resolve, reject);
  });
}

function callDeepSeek(body, resolve, reject) {
  const json = JSON.stringify(body);
  const req = https.request({
    hostname: 'api.deepseek.com',
    path: '/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
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
}

function callOpenRouter(body, resolve, reject) {
  const json = JSON.stringify(body);
  const req = https.request({
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
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
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

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
  console.log(`âœ… Nexus Study rodando na porta ${PORT}`);
  console.log(`   IA texto: DeepSeek Chat`);
  console.log(`   IA visÃ£o: OpenRouter (fotos de comida)`);
});
