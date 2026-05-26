const express = require('express');
const admin = require('firebase-admin');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const BACKEND_SECRET = process.env.BACKEND_SECRET;

let fcmTokens = [];
let previousRsi = null;
let alertCooldown = {};
let closePrices = [];
const MAX_CLOSES = 200;

const OVERBOUGHT_LEVELS = [70];
const OVERSOLD_LEVELS = [35, 30, 25, 20];

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

async function sendPush(title, body) {
  if (!fcmTokens.length) {
    console.log('[FCM] Sem tokens registados.');
    return;
  }
  for (const token of [...fcmTokens]) {
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'rsi_alerts' } }
      });
      console.log('[FCM] Enviado: ' + title);
    } catch (e) {
      console.error('[FCM] Erro: ' + e.message);
      if (e.code === 'messaging/registration-token-not-registered')
        fcmTokens = fcmTokens.filter(t => t !== token);
    }
  }
}

function checkAlerts(rsi) {
  if (previousRsi === null) { previousRsi = rsi; return; }
  const now = Date.now();
  const COOLDOWN = 5 * 60 * 1000;
  for (const lvl of OVERBOUGHT_LEVELS) {
    const key = 'ob_' + lvl;
    if (previousRsi < lvl && rsi >= lvl && (!alertCooldown[key] || now - alertCooldown[key] > COOLDOWN)) {
      alertCooldown[key] = now;
      sendPush('XAUUSD RSI SOBRECOMPRA', 'RSI 14 subiu acima de ' + lvl + ' -> Atual: ' + rsi.toFixed(2));
    }
  }
  for (const lvl of OVERSOLD_LEVELS) {
    const key = 'os_' + lvl;
    if (previousRsi > lvl && rsi <= lvl && (!alertCooldown[key] || now - alertCooldown[key] > COOLDOWN)) {
      alertCooldown[key] = now;
      sendPush('XAUUSD RSI SOBREVENDA', 'RSI 14 desceu abaixo de ' + lvl + ' -> Atual: ' + rsi.toFixed(2));
    }
  }
  previousRsi = rsi;
}

function connectFinnhub() {
  const ws = new WebSocket('wss://ws.finnhub.io?token=' + FINNHUB_API_KEY);

  ws.on('open', () => {
    console.log('[WS] Ligado ao Finnhub');
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:XAU/USD' }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'trade' && msg.data) {
        for (const trade of msg.data) {
          const price = trade.p;
          closePrices.push(price);
          if (closePrices.length > MAX_CLOSES) closePrices.shift();
          const rsi = calculateRSI(closePrices);
          if (rsi !== null) {
            console.log('[RSI] ' + rsi.toFixed(2) + ' | Preco: ' + price);
            checkAlerts(rsi);
          }
        }
      }
    } catch (e) {
      console.error('[WS] Erro ao processar mensagem: ' + e.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Ligacao fechada. A reconectar em 5s...');
    setTimeout(connectFinnhub, 5000);
  });

  ws.on('error', (e) => {
    console.error('[WS] Erro: ' + e.message);
  });
}

app.post('/register', (req, res) => {
  const { token, secret } = req.body;
  if (secret !== BACKEND_SECRET) return res.status(401).json({ error: 'Nao autorizado' });
  if (!token) return res.status(400).json({ error: 'Token em falta' });
  if (!fcmTokens.includes(token)) fcmTokens.push(token);
  console.log('[REG] Token registado. Total: ' + fcmTokens.length);
  res.json({ success: true, message: 'Token registado com sucesso' });
});

app.get('/health', (req, res) => res.json({
  ok: true,
  tokens: fcmTokens.length,
  rsi: previousRsi ? previousRsi.toFixed(2) : null,
  time: new Date().toISOString()
}));

app.post('/test-push', (req, res) => {
  if (req.body.secret !== BACKEND_SECRET) return res.status(401).json({ error: 'Nao autorizado' });
  sendPush('Teste XAUUSD RSI', 'Notificacao de teste recebida com sucesso!');
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('[SERVER] Backend XAUUSD RSI a correr na porta ' + PORT);
  connectFinnhub();
});
