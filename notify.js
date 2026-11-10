// 事件通知：把「同學完成作答」「老師批改完成」這類事件用 webhook 送給 n8n，由 n8n 負責寄 email。
// 只在伺服器端送出，失敗只記 log，不影響學生交卷或老師批改。
//
// 環境變數：
//   N8N_WEBHOOK_URL     n8n Webhook 節點的 Production URL；沒設就整個功能關閉
//   N8N_WEBHOOK_SECRET  選填；有設的話每個請求會帶 x-webhook-secret 標頭，n8n 端可以驗證
//   N8N_FOR_DEMO        設成 on 才會替示範帳號（@demo.com）送通知；預設關閉，避免對不存在的信箱寄信

const TIMEOUT_MS = 10000;

const notifyEnabled = () => Boolean(process.env.N8N_WEBHOOK_URL);
const isDemoEmail = (email) => /@demo\.com$/i.test(String(email || ''));

async function notify(event, data) {
  if (!notifyEnabled()) return;
  if (isDemoEmail(data.student && data.student.email) && String(process.env.N8N_FOR_DEMO || '').toLowerCase() !== 'on') return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (process.env.N8N_WEBHOOK_SECRET) headers['x-webhook-secret'] = process.env.N8N_WEBHOOK_SECRET;
    const res = await fetch(process.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: JSON.stringify({ event, sentAt: new Date().toISOString(), ...data }),
    });
    if (!res.ok) console.error(`n8n webhook 回應 ${res.status}（事件 ${event}）`);
  } catch (e) {
    console.error(`n8n webhook 送出失敗（事件 ${event}）：`, e.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { notify, notifyEnabled };
