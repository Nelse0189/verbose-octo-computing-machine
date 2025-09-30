import { GoogleGenerativeAI } from '@google/generative-ai';

export type ScheduledItem = {
  id: string;
  date: string; // ISO date (YYYY-MM-DD)
  title: string;
  type?: 'exam' | 'assignment' | 'lecture' | 'study' | 'other';
  details?: string;
  sourceTitle?: string;
  sourceLink?: string;
  confidence?: 'high' | 'medium' | 'low';
};

export type SchedulePlan = {
  generatedAt: string;
  items: ScheduledItem[];
};

export function computeDocsHash(docs: { title: string; text?: string; base64?: string; mimeType?: string }[]): string {
  const sig = docs.map(d => ({ t: d.title, s: (d.text ? d.text.slice(0, 2048) : ''), b: (d.base64 ? d.base64.slice(0, 2048) : ''), m: d.mimeType || ''}));
  const raw = JSON.stringify(sig);
  let h = 0;
  for (let i = 0; i < raw.length; i++) { h = ((h << 5) - h) + raw.charCodeAt(i); h |= 0; }
  return `h${Math.abs(h)}`;
}

function chunkText(input: string, max = 12000): string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    parts.push(input.slice(cursor, cursor + max));
    cursor += max;
  }
  return parts;
}

const FN_URL: string | undefined = (import.meta as any).env?.VITE_SCHEDULE_FUNCTION_URL;

export async function generateScheduleFromDocs(
  docs: { title: string; text?: string; base64?: string; mimeType?: string }[],
  startDateISO: string
): Promise<SchedulePlan> {
  // Prefer Cloud Function if configured
  if (FN_URL) {
    console.log('[Scheduler] Using function URL for schedule:', FN_URL);
    const resp = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs, startDate: startDateISO }),
    });
    if (!resp.ok) throw new Error(`Schedule function error: ${resp.status}`);
    const data = await resp.json();
    console.log('[Scheduler] Function response keys:', Object.keys(data || {}));
    if (!data || !data.items) throw new Error('Invalid schedule response');
    return data as SchedulePlan;
  }

  const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing VITE_GEMINI_API_KEY');
  const genAI = new GoogleGenerativeAI(apiKey);

  const modelName = (import.meta as any).env?.VITE_GEMINI_MODEL || 'gemini-2.5-pro';
  console.log('[Scheduler] Using Gemini model:', modelName);
  let model = genAI.getGenerativeModel({ model: modelName });

  const sys = `You are an academic planning assistant. From course documents (syllabi, assignments, lecture notes), derive a semester plan.
STRICT RULES:
- If explicit dates exist in the documents, USE THEM EXACTLY. Do not shift or guess.
- If a week table shows "Exam 1" next to a specific date (e.g., Oct 2), use that exact calendar day.
- If unsure, prefer leaving an item unscheduled instead of guessing.
- Provide provenance by including sourceTitle and, if present in text, sourceLink.
- Keep items in the proper semester window.
Return ONLY JSON as {"generatedAt":"ISO","items":[{"id":"string","date":"YYYY-MM-DD","title":"string","type":"exam|assignment|lecture|study|other","details":"string","sourceTitle":"string","sourceLink":"string","confidence":"high|medium|low"}...]}.`;

  const start = new Date(startDateISO);
  const header = `Start date: ${start.toISOString().slice(0,10)}.`;

  const parts: any[] = [{ text: `${sys}\n\n${header}` }];
  const titles = docs.map(d => d.title).slice(0, 20);
  console.log('[Scheduler] Gemini call prep:', { totalDocs: docs.length, firstTitles: titles });
  docs.forEach((d, i) => {
    parts.push({ text: `\n\n# Document ${i + 1}: ${d.title}` });
    if (d.text && d.text.trim().length > 0) {
      const chunks = chunkText(d.text, 15000);
      console.log(`[Scheduler] Doc ${i+1} text chunks:`, chunks.length);
      chunks.forEach((c, idx) => parts.push({ text: `\n[chunk ${idx + 1}]\n${c}` }));
    } else if (d.base64) {
      const pure = d.base64.includes(',') ? d.base64.split(',')[1] : d.base64;
      parts.push({ inlineData: { data: pure, mimeType: d.mimeType || 'application/pdf' } });
      console.log(`[Scheduler] Doc ${i+1} sent as inlineData mime=`, d.mimeType || 'application/pdf');
    }
  });

  console.log('[Scheduler] Gemini request parts count:', parts.length);
  let res;
  try {
    res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  } catch (err) {
    console.warn('[Scheduler] Primary model failed, falling back to gemini-1.5-flash:', err);
    model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  }
  const txt = res.response.text();
  console.log('[Scheduler] Gemini raw text length:', (txt || '').length);

  try {
    const parsed = JSON.parse(txt) as SchedulePlan;
    return parsed;
  } catch (err) {
    console.warn('[Scheduler] JSON parse failed, attempting salvage. Raw start:', (txt || '').slice(0, 200));
    // Try to salvage JSON substring
    const startIdx = txt.indexOf('{');
    const endIdx = txt.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      const sub = txt.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(sub) as SchedulePlan;
      return parsed;
    }
    console.error('[Scheduler] Gemini did not return valid JSON', err);
    throw new Error('Gemini did not return valid JSON');
  }
}

export async function reconcileScheduleWithDocs(
  docs: { title: string; text?: string; base64?: string; mimeType?: string }[],
  initialPlan: SchedulePlan
): Promise<SchedulePlan> {
  const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing VITE_GEMINI_API_KEY');
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = (import.meta as any).env?.VITE_GEMINI_MODEL || 'gemini-2.5-pro';
  console.log('[Scheduler] Reconcile using model:', modelName);
  let model = genAI.getGenerativeModel({ model: modelName });

  const sys = `You are validating a semester schedule plan against source documents.
RULES:
- If a document explicitly specifies a date for an item (e.g., exams, lectures, tables with week/date), correct the plan's date to exactly match.
- If the docs are ambiguous, DO NOT GUESS. Keep the original date and set confidence to "low".
- Preserve titles and types; update only dates, details, sourceTitle/sourceLink, and confidence as needed.
- Return ONLY full JSON for the corrected plan with the same shape: {generatedAt, items:[...]}.`;

  const parts: any[] = [{ text: sys }];
  parts.push({ text: `\nOriginalPlan:\n${JSON.stringify(initialPlan)}` });
  docs.forEach((d, i) => {
    parts.push({ text: `\n# Doc ${i + 1}: ${d.title}` });
    if (d.text && d.text.trim().length > 0) {
      const chunks = chunkText(d.text, 15000);
      chunks.forEach((c, idx) => parts.push({ text: `\n[chunk ${idx + 1}]\n${c}` }));
    } else if (d.base64) {
      const pure = d.base64.includes(',') ? d.base64.split(',')[1] : d.base64;
      parts.push({ inlineData: { data: pure, mimeType: d.mimeType || 'application/pdf' } });
    }
  });

  let res;
  try {
    res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  } catch (err) {
    console.warn('[Scheduler] Reconcile primary model failed, falling back to gemini-1.5-flash:', err);
    model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  }
  const txt = res.response.text();
  console.log('[Scheduler] Reconcile response length:', (txt || '').length);
  try {
    const parsed = JSON.parse(txt) as SchedulePlan;
    return parsed;
  } catch {
    const startIdx = txt.indexOf('{');
    const endIdx = txt.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      const sub = txt.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(sub) as SchedulePlan;
      return parsed;
    }
    throw new Error('Reconcile: invalid JSON');
  }
}

export function mergePlans(oldPlan: SchedulePlan | null, newPlan: SchedulePlan): SchedulePlan {
  if (!oldPlan) return newPlan;
  const byId = new Map<string, ScheduledItem>();
  for (const it of oldPlan.items) byId.set(it.id, it);
  for (const it of newPlan.items) byId.set(it.id, it);
  return { generatedAt: newPlan.generatedAt, items: Array.from(byId.values()).sort((a,b)=>a.date.localeCompare(b.date)) };
}


