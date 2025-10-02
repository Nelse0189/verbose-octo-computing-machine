import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../firebase/config';
import { collection, getDocs } from 'firebase/firestore';

export type ScheduledItem = {
  id: string;
  date: string; // ISO date (YYYY-MM-DD)
  title: string;
  type?: 'exam' | 'assignment' | 'lecture' | 'study' | 'other';
  details?: string;
  sourceTitle?: string;
  sourceLink?: string;
  confidence?: 'high' | 'medium' | 'low';
  section?: string; // e.g., "1.2", "3.4"
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

async function getTextbookSegments(): Promise<Array<{ sectionToken: string; title: string; textbookTitle?: string }>> {
  try {
    // Add timeout and retry logic for Firestore
    const fetchWithRetry = async (retries = 3): Promise<any> => {
      for (let i = 0; i < retries; i++) {
        try {
          console.log(`[Scheduler] Fetching textbook segments (attempt ${i + 1}/${retries})`);
          const textbooksSnap = await Promise.race([
            getDocs(collection(db, 'textbooks')),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Firestore timeout after 10 seconds')), 10000)
            )
          ]);
          return textbooksSnap;
        } catch (err) {
          console.warn(`[Scheduler] Firestore attempt ${i + 1} failed:`, err);
          if (i === retries - 1) throw err;
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
      }
    };

    const textbooksSnap = await fetchWithRetry();
    const segments: Array<{ sectionToken: string; title: string; textbookTitle?: string }> = [];
    
    textbooksSnap.forEach((doc: any) => {
      const data = doc.data();
      const textbookTitle = data.title || '';
      const docSegments = data.segments || [];
      
      for (const seg of docSegments) {
        if (seg.sectionToken && seg.title && seg.kind === 'section') {
          segments.push({
            sectionToken: seg.sectionToken,
            title: seg.title,
            textbookTitle
          });
        }
      }
    });
    
    console.log(`[Scheduler] Successfully fetched ${segments.length} textbook segments`);
    
    return segments.sort((a, b) => {
      // Sort by section number (e.g., "1.1" before "1.2" before "2.1")
      const aParts = a.sectionToken.split('.').map(Number);
      const bParts = b.sectionToken.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (aVal !== bVal) return aVal - bVal;
      }
      return 0;
    });
  } catch (error) {
    console.warn('[Scheduler] Failed to fetch textbook segments after retries:', error);
    // Return empty array so schedule generation can continue without textbook segments
    return [];
  }
}

export async function generateScheduleFromDocs(
  docs: { title: string; text?: string; base64?: string; mimeType?: string }[],
  startDateISO: string
): Promise<SchedulePlan> {
  // Fetch textbook segments to include in planning
  const segments = await getTextbookSegments();
  console.log('[Scheduler] Found textbook segments:', segments.length);

  // Prefer Cloud Function if configured
  if (FN_URL) {
    console.log('[Scheduler] Using function URL for schedule:', FN_URL);
    const resp = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs, startDate: startDateISO, segments }),
    });
    if (!resp.ok) throw new Error(`Schedule function error: ${resp.status}`);
    const data = await resp.json();
    console.log('[Scheduler] Function response keys:', Object.keys(data || {}));
    if (!data || !data.items) throw new Error('Invalid schedule response');
    return data as SchedulePlan;
  }

  const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[Scheduler] Missing VITE_GEMINI_API_KEY environment variable');
    throw new Error('Missing VITE_GEMINI_API_KEY - please set this environment variable with your Google AI API key');
  }
  console.log('[Scheduler] API key found, length:', apiKey.length);
  const genAI = new GoogleGenerativeAI(apiKey);

  const modelName = (import.meta as any).env?.VITE_GEMINI_MODEL || 'gemini-1.5-flash';
  console.log('[Scheduler] Using Gemini model:', modelName);
  let model = genAI.getGenerativeModel({ model: modelName });

  const segmentsList = segments.map(s => `${s.sectionToken}: ${s.title}`).join('\n');
  
  const sys = `You are an academic planning assistant. From course documents (syllabi, assignments, lecture notes), derive a semester plan.

Available textbook sections:
${segmentsList}

CONSENSUS POLICY & STRICT RULES:
1. SYLLABUS DATES ARE ABSOLUTE TRUTH - If a syllabus explicitly states "Oct 15: Chapter 3.2 & 3.3", create TWO separate items for that date, both with high confidence.
2. EXPLICIT DATES OVERRIDE EVERYTHING - Never move, shift, or guess dates when they're explicitly stated in documents.
3. HANDLE MULTIPLE TOPICS PER DAY - If syllabus shows "Week 5 (Oct 15): Sections 2.1, 2.2, 2.3", create separate items for each section on that date.
4. DOCUMENT HIERARCHY - Syllabus > Assignment sheets > Lecture notes > Textbook order
5. CONFLICT RESOLUTION - If documents conflict on dates, prefer the most official source (usually syllabus)
6. SECTION MATCHING - Match course topics to textbook sections, but NEVER let section order override syllabus dates
7. CONFIDENCE LEVELS:
   - "high": Explicit date in syllabus/official document
   - "medium": Implied from schedule pattern or week structure  
   - "low": Estimated based on textbook order or general timing

For each item, include:
- Exact date from syllabus if available
- Relevant section number in "section" field (e.g., "2.1")
- Descriptive title like "Section 2.1: Linear Independence" 
- Source document for provenance
- Appropriate confidence level

Return ONLY JSON as {"generatedAt":"ISO","items":[{"id":"string","date":"YYYY-MM-DD","title":"string","type":"exam|assignment|lecture|study|other","details":"string","sourceTitle":"string","sourceLink":"string","confidence":"high|medium|low","section":"2.1"}...]}.`;

  const start = new Date(startDateISO);
  const header = `Start date: ${start.toISOString().slice(0,10)}.`;

  // Prioritize documents: syllabi first, then assignments, then others
  const prioritizedDocs = [...docs].sort((a, b) => {
    const aIsSyllabus = /syllabus|course.outline|schedule/i.test(a.title);
    const bIsSyllabus = /syllabus|course.outline|schedule/i.test(b.title);
    const aIsAssignment = /assignment|homework|project|exam/i.test(a.title);
    const bIsAssignment = /assignment|homework|project|exam/i.test(b.title);
    
    if (aIsSyllabus && !bIsSyllabus) return -1;
    if (!aIsSyllabus && bIsSyllabus) return 1;
    if (aIsAssignment && !bIsAssignment) return -1;
    if (!aIsAssignment && bIsAssignment) return 1;
    return 0;
  });

  const parts: any[] = [{ text: `${sys}\n\n${header}` }];
  const titles = prioritizedDocs.map(d => d.title).slice(0, 20);
  console.log('[Scheduler] Gemini call prep (prioritized):', { totalDocs: prioritizedDocs.length, firstTitles: titles });
  prioritizedDocs.forEach((d, i) => {
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
    console.warn('[Scheduler] Primary model failed, trying gemini-1.5-pro:', err);
    try {
      model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
      res = await model.generateContent({ contents: [{ role: 'user', parts }] });
    } catch (err2) {
      console.warn('[Scheduler] Fallback model also failed, trying gemini-1.0-pro:', err2);
      model = genAI.getGenerativeModel({ model: 'gemini-1.0-pro' });
      res = await model.generateContent({ contents: [{ role: 'user', parts }] });
    }
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
  if (!apiKey) {
    console.error('[Scheduler] Missing VITE_GEMINI_API_KEY environment variable');
    throw new Error('Missing VITE_GEMINI_API_KEY - please set this environment variable with your Google AI API key');
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = (import.meta as any).env?.VITE_GEMINI_MODEL || 'gemini-1.5-flash';
  console.log('[Scheduler] Reconcile using model:', modelName);
  let model = genAI.getGenerativeModel({ model: modelName });

  const sys = `You are performing FINAL VALIDATION of a semester schedule plan against source documents using CONSENSUS POLICY.

VALIDATION & CONSENSUS RULES:
1. SYLLABUS IS SUPREME - If ANY document (especially syllabus) explicitly states a date, that date is FINAL. Override any conflicting dates.
2. MULTIPLE TOPICS VALIDATION - If syllabus says "Oct 15: Sections 2.1 & 2.2", ensure BOTH sections appear on Oct 15, not spread across days.
3. CONFLICT RESOLUTION HIERARCHY:
   - Syllabus dates > Assignment due dates > Lecture schedules > Textbook order > AI estimates
4. CONFIDENCE ADJUSTMENT:
   - "high": Explicitly stated in official documents (syllabus, assignment sheets)
   - "medium": Strongly implied by document patterns or week structures
   - "low": Estimated or inferred without explicit support
5. DATE VALIDATION:
   - If multiple documents agree on a date → confidence = "high"
   - If only one document states date → confidence = "medium" 
   - If no explicit date found → confidence = "low"
6. PRESERVE MULTI-TOPIC DAYS - Don't artificially spread topics that should be on the same day
7. SOURCE ACCURACY - Update sourceTitle to reflect the most authoritative document for each date

CRITICAL: If you find explicit syllabus dates that contradict the current plan, FIX THEM. The syllabus schedule is non-negotiable.

Return ONLY full JSON for the corrected plan: {generatedAt, items:[...]}.`;

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
    console.warn('[Scheduler] Reconcile primary model failed, trying gemini-1.5-pro:', err);
    try {
      model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
      res = await model.generateContent({ contents: [{ role: 'user', parts }] });
    } catch (err2) {
      console.warn('[Scheduler] Reconcile fallback model also failed, trying gemini-1.0-pro:', err2);
      model = genAI.getGenerativeModel({ model: 'gemini-1.0-pro' });
      res = await model.generateContent({ contents: [{ role: 'user', parts }] });
    }
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


