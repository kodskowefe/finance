// Провайдер-агностичный AI-ассистент. Работает с OpenAI / Anthropic / Gemini.
// Без ключа возвращает { enabled: false } — остальное приложение не зависит от AI.

const PROVIDER = (process.env.AI_PROVIDER || '').toLowerCase();
const API_KEY = process.env.AI_API_KEY || '';

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-2.5-flash',
};

export function aiEnabled() {
  return !!(PROVIDER && API_KEY && DEFAULT_MODELS[PROVIDER]);
}

export function aiStatus() {
  return { enabled: aiEnabled(), provider: aiEnabled() ? PROVIDER : null };
}

function buildSystemPrompt(context) {
  return [
    'Ты — спокойный, прагматичный финансовый ассистент в приложении для планирования будущей зарплаты.',
    'Пользователь — 18-летний студент финансов в Киеве, живёт с родителями, доход ~25 000 грн/мес.',
    'Твоя задача: помочь заранее распределить зарплату по приоритетам, дедлайнам и долгосрочным целям.',
    'Правила: сначала обязательные расходы и резерв на страховку / чёрный день; must-have важнее nice-to-have; покупки с дедлайном важнее; ',
    'эмоциональное желание само по себе не должно перевешивать приоритет и долгосрочную ценность (trajectory).',
    'Отвечай кратко, по делу, на русском. Давай конкретные рекомендации: что купить первым, что отложить, какие trade-off.',
    'Все суммы — в гривнах (грн).',
    '',
    'Текущий контекст плана (JSON):',
    JSON.stringify(context),
  ].join('\n');
}

async function callOpenAI(system, messages, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function callAnthropic(system, messages, model) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function callGemini(system, messages, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function askAssistant(messages, context) {
  if (!aiEnabled()) {
    return { enabled: false, reply: 'AI-ассистент не настроен. Добавьте AI_PROVIDER и AI_API_KEY в окружении.' };
  }
  const model = process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER];
  const system = buildSystemPrompt(context);

  let reply;
  if (PROVIDER === 'openai') reply = await callOpenAI(system, messages, model);
  else if (PROVIDER === 'anthropic') reply = await callAnthropic(system, messages, model);
  else if (PROVIDER === 'gemini') reply = await callGemini(system, messages, model);
  else throw new Error(`Неизвестный провайдер: ${PROVIDER}`);

  return { enabled: true, reply };
}

export async function askAssistantText(prompt, context) {
  return askAssistant([{ role: 'user', content: prompt }], context);
}
