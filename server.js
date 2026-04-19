const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT           = process.env.PORT             || 8080;
const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

// ── Modelos com fallback automático ──────────────────────────────────────────
// Atualizado em Abril/2026 — modelos verificados como ativos no OpenRouter
const MODELOS_TEXTO = [
  'google/gemma-3-12b-it:free',           // Gemma 3 12B — estável
  'google/gemma-3-27b-it:free',           // Gemma 3 27B — fallback (pode ter 429)
  'mistralai/mistral-small-3.1-24b-instruct:free', // Mistral Small 3.1 — multimodal
  'meta-llama/llama-3.3-70b-instruct:free',        // Llama 3.3 70B
  'qwen/qwen2.5-72b-instruct:free',       // Qwen 2.5 72B
];

// Modelos de visão em ordem de fallback
const MODELOS_VISAO = [
  'qwen/qwen2.5-vl-7b-instruct:free',     // Qwen VL — visão gratuita ativa
  'qwen/qwen2.5-vl-32b-instruct:free',    // Qwen VL 32B — fallback maior
  'google/gemma-3-12b-it:free',           // Gemma 3 suporta visão
  'mistralai/mistral-small-3.1-24b-instruct:free', // Mistral Small suporta visão
];

// ── Rate limit simples: máx 1 req/seg ────────────────────────────────────────
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

// ── Tenta lista de modelos com fallback ───────────────────────────────────────
async function tentarModelos(payload, listaModelos, tipoLog = 'texto') {
  for (const modelo of listaModelos) {
    try {
      console.log(`[${tipoLog}] Tentando:`, modelo);
      const r = await chamarOpenRouter(payload, modelo);
      if (r.status === 200) {
        console.log(`[${tipoLog}] ✅ Sucesso:`, modelo);
        return r;
      }
      let msg = '';
      try { msg = JSON.parse(r.raw)?.error?.message || ''; } catch {}
      console.error(`[${tipoLog}] ❌ ${modelo} falhou (${r.status}): ${msg.slice(0, 120)}`);
      // 429 = sobrecarga, espera um pouco mais antes de tentar próximo
      await new Promise(res => setTimeout(res, r.status === 429 ? 1500 : 500));
    } catch (e) {
      console.error(`[${tipoLog}] Erro em ${modelo}:`, e.message);
    }
  }
  return null;
}

// ── Roteador principal com fallback ───────────────────────────────────────────
async function chamarIA(body) {
  await aguardarRateLimit();

  const payload = { ...body };
  delete payload.model;

  // ── Com imagem → modelos de visão com fallback ──────────────────────────────
  if (temImagem(payload)) {
    if (!OPENROUTER_KEY) throw new Error('Configure OPENROUTER_API_KEY no Railway para análise de imagens.');
    const r = await tentarModelos(payload, MODELOS_VISAO, 'visão');
    if (r) return r;
    throw new Error('Análise de imagem indisponível no momento. Tente descrever o prato em texto.');
  }

  // ── DeepSeek primeiro se tiver chave ───────────────────────────────────────
  if (DEEPSEEK_KEY) {
    try {
      const r = await chamarDeepSeek(payload);
      if (r.status === 200) return r;
      console.error('DeepSeek falhou status', r.status, '— tentando OpenRouter...');
    } catch (e) {
      console.error('DeepSeek erro:', e.message, '— tentando OpenRouter...');
    }
  }

  // ── OpenRouter com fallback automático entre modelos ───────────────────────
  if (OPENROUTER_KEY) {
    const r = await tentarModelos(payload, MODELOS_TEXTO, 'texto');
    if (r) return r;
    throw new Error('Todos os modelos falharam. Tente novamente em alguns segundos.');
  }

  throw new Error('Nenhuma chave de IA configurada. Adicione OPENROUTER_API_KEY no Railway → Variables.');
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
  console.log('   Modelos texto (em ordem de tentativa):');
  MODELOS_TEXTO.forEach((m, i) => console.log(`     ${i + 1}. ${m}`));
  console.log('   Modelos visão (em ordem de tentativa):');
  MODELOS_VISAO.forEach((m, i) => console.log(`     ${i + 1}. ${m}`));
  console.log('');
  if (!DEEPSEEK_KEY && !OPENROUTER_KEY) {
    console.error('⚠️  ATENÇÃO: Nenhuma chave configurada! O site não vai funcionar.');
    console.error('   Adicione DEEPSEEK_API_KEY ou OPENROUTER_API_KEY no Railway → Variables');
  }
});
