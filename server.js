const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT           = process.env.PORT             || 8080;
const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// ── Modelos válidos e estáveis (verificados abril 2026) ───────────────────────
const MODEL_TEXTO = 'meta-llama/llama-3.3-70b-instruct:free';
const MODEL_VISAO = 'meta-llama/llama-3.2-11b-vision-instruct:free'; // único free com visão estável

// ── Rate limit simples: máx 1 req/seg ─────────────────────────────────────────
let ultimaReq = 0;
async function aguardarRateLimit() {
  const agora = Date.now();
  const espera = Math.max(0, 1100 - (agora - ultimaReq));
  if (espera > 0) await new Promise(r => setTimeout(r, espera));
  ultimaReq = Date.now();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function temImagem(body) {
  return (body.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'image_url')
  );
}

// ── Chamada HTTP genérica ─────────────────────────────────────────────────────
function httpPost(hostname, path, headers, json) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(json, 'utf8');
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────
async function chamarDeepSeek(body) {
  const payload = { ...body, model: 'deepseek-chat' };
  // Remove campos que a DeepSeek não aceita
  delete payload['HTTP-Referer'];
  delete payload['X-Title'];
  const json = JSON.stringify(payload);
  return httpPost('api.deepseek.com', '/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${DEEPSEEK_KEY}`,
  }, json);
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
async function chamarOpenRouter(body, modelo) {
  const payload = { ...body, model: modelo };
  const json = JSON.stringify(payload);
  return httpPost('openrouter.ai', '/api/v1/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_KEY}`,
    'HTTP-Referer': 'https://nexusstudy1-production-f223.up.railway.app',
    'X-Title': 'Nexus Study',
  }, json);
}

// ── Roteador principal com fallback ───────────────────────────────────────────
async function chamarIA(body) {
  await aguardarRateLimit();

  // Limpa campos que o frontend manda mas a API não precisa
  const payload = { ...body };
  delete payload.model; // servidor decide o modelo, ignora o do frontend

  // Com imagem → OpenRouter com modelo de visão
  if (temImagem(payload)) {
    if (!OPENROUTER_KEY) throw new Error('Configure OPENROUTER_API_KEY no Railway para análise de imagens.');
    const r = await chamarOpenRouter(payload, MODEL_VISAO);
    if (r.status === 200) return r;
    // Fallback: tenta sem imagem com descrição
    console.error('Visão falhou:', r.raw.slice(0, 200));
    throw new Error('Análise de imagem indisponível no momento. Tente descrever o prato em texto.');
  }

  // Texto → DeepSeek (prioridade se tiver chave)
  if (DEEPSEEK_KEY) {
    try {
      const r = await chamarDeepSeek(payload);
      if (r.status === 200) return r;
      console.error('DeepSeek falhou status', r.status, '— tentando OpenRouter...');
    } catch (e) {
      console.error('DeepSeek erro:', e.message, '— tentando OpenRouter...');
    }
  }

  // OpenRouter como fallback (ou principal se não tiver DeepSeek)
  if (OPENROUTER_KEY) {
    const r = await chamarOpenRouter(payload, MODEL_TEXTO);
    if (r.status === 200) return r;
    // Tenta modelo alternativo se 429 ou 404
    const parsed = JSON.parse(r.raw || '{}');
    const msg = parsed?.error?.message || '';
    console.error('OpenRouter falhou:', r.status, msg);
    if (r.status === 429 || r.status === 404) {
      console.log('Tentando modelo alternativo...');
      await new Promise(res => setTimeout(res, 2000));
      const r2 = await chamarOpenRouter(payload, 'google/gemma-3-27b-it:free');
      if (r2.status === 200) return r2;
    }
    return r; // retorna o erro para o frontend mostrar
  }

  throw new Error('Nenhuma chave de IA configurada. Adicione DEEPSEEK_API_KEY ou OPENROUTER_API_KEY no Railway → Variables.');
}

// ── Servidor HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Proxy de IA ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/chat') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const { status, raw } = await chamarIA(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(raw);
      } catch (e) {
        console.error('Erro na IA:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }

  // ── Arquivos estáticos ─────────────────────────────────────────────────────
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('✅ Nexus Study rodando na porta', PORT);
  console.log('   DeepSeek:', DEEPSEEK_KEY ? '✅ configurado' : '❌ não configurado');
  console.log('   OpenRouter:', OPENROUTER_KEY ? '✅ configurado' : '❌ não configurado');
  console.log('   Modelo texto:', DEEPSEEK_KEY ? 'deepseek-chat' : MODEL_TEXTO);
  console.log('   Modelo visão:', MODEL_VISAO);
  console.log('');
  if (!DEEPSEEK_KEY && !OPENROUTER_KEY) {
    console.error('⚠️  ATENÇÃO: Nenhuma chave configurada! O site não vai funcionar.');
    console.error('   Adicione DEEPSEEK_API_KEY ou OPENROUTER_API_KEY no Railway → Variables');
  }
});
