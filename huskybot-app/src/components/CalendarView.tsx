import { useEffect, useMemo, useState } from 'react';
import { getCourseMaterials, CourseData, CourseMaterial } from '../lib/idb';
import { generateScheduleFromDocs, mergePlans, SchedulePlan, reconcileScheduleWithDocs, computeDocsHash } from '../lib/scheduler';
import PdfViewer from './PdfViewer';
import { summarizeTopicWithTextbook, getSignedPdfUrl, TopicSummaryResponse } from '../lib/textbookRetrieval';
import { db } from '../firebase/config';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

type CalendarMode = 'month' | 'week' | 'day';

interface CalendarEvent {
  id: string;
  date: Date;
  title: string;
}

const LINEAR_ALGEBRA_COURSE = 'MATH-2210Q-Applied Linear Algebra-SEC001-1258';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

function startOfWeek(d: Date) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // make Monday=0
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(d: Date) {
  const date = new Date(d.getFullYear(), d.getMonth(), 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number) {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

function formatDateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function scheduleFromMaterials(materials: CourseMaterial[], baseMonday: Date): CalendarEvent[] {
  // Very simple heuristic scheduler for this case:
  // - Videos go on consecutive days starting at the next Monday
  // - Matching "Notes for video on Chapter ... part N" go the same day as the related video
  // - Everything else is placed the day after the last scheduled item
  let offset = 0;
  const events: CalendarEvent[] = [];
  const videoMap: Record<string, Date> = {};

  const videos = materials.filter(m => /Video for Chapter/i.test(m.title));
  const others = materials.filter(m => !/Video for Chapter/i.test(m.title));

  videos.sort((a, b) => a.title.localeCompare(b.title)).forEach(v => {
    const date = addDays(baseMonday, offset++);
    events.push({ id: `v-${v.title}-${formatDateKey(date)}`, date, title: v.title });
    // Key by chapter/part if present
    const key = v.title.replace(/\s+/g, '').toLowerCase();
    videoMap[key] = date;
  });

  others.forEach(m => {
    const notesMatchKey = m.title.replace(/\s+/g, '').toLowerCase();
    const related = Object.keys(videoMap).find(k => notesMatchKey.includes(k.replace('video', '')));
    if (related) {
      const date = videoMap[related];
      events.push({ id: `n-${m.title}-${formatDateKey(date)}`, date, title: m.title });
    } else {
      const date = addDays(baseMonday, offset++);
      events.push({ id: `o-${m.title}-${formatDateKey(date)}`, date, title: m.title });
    }
  });

  return events;
}

export default function CalendarView() {
  const [mode, setMode] = useState<CalendarMode>('month');
  const [current, setCurrent] = useState<Date>(() => new Date());
  const [course, setCourse] = useState<CourseData | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [aiPlan, setAiPlan] = useState<SchedulePlan | null>(null);
  const [extensionId, setExtensionId] = useState<string>('');
  const [materialsMeta, setMaterialsMeta] = useState<Array<{ id:number; title:string; courseName?:string; hasFile?:boolean; mimeType?:string; size?:number }>>([]);
  const [extError, setExtError] = useState<string>('');
  const [isPlanning, setIsPlanning] = useState<boolean>(false);
  const [planMessage, setPlanMessage] = useState<string>('');
  const [autoPlanned, setAutoPlanned] = useState<boolean>(false);
  const [authUid, setAuthUid] = useState<string | null>(null);
  const [activeSummary, setActiveSummary] = useState<{ eventId: string; summary: string; sources: { heading?: string | null; pageStart?: number | null; pageEnd?: number | null; storagePath?: string | null }[] } | null>(null);
  const [activePdf, setActivePdf] = useState<{ url: string } | null>(null);
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        // Load extension ID the same way as SavedDataView
        const params = new URLSearchParams(window.location.search);
        const ext = params.get('ext') || localStorage.getItem('huskybot_extension_id') || '';
        if (ext) setExtensionId(ext);

        if (ext && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          setExtError('');
          await new Promise<void>((resolve) => {
            chrome.runtime.sendMessage(ext, { type: 'READ_MATERIALS_META' }, (resp: any) => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr) {
                if (mounted) setExtError(lastErr.message || 'Extension messaging failed');
                return resolve();
              }
              if (!resp || !resp.success) {
                if (mounted) setExtError(resp?.error || 'Failed to read materials from extension');
                return resolve();
              }
              if (mounted) setMaterialsMeta(resp.materials || []);
              resolve();
            });
          });
        }

        // Keep the old local DB fallback
        const data = await getCourseMaterials(LINEAR_ALGEBRA_COURSE);
        if (mounted) setCourse(data);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Watch auth state and store uid
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (user) => {
      setAuthUid(user?.uid || null);
    });
    return () => unsub();
  }, []);

  // Auto-plan when signed in and we have materials and haven't planned yet
  useEffect(() => {
    (async () => {
      if (autoPlanned) return;
      if (!authUid) {
        setPlanMessage('Please sign in to generate your calendar.');
        return;
      }
      const pdfMetas = (materialsMeta || []).filter(m => m.hasFile && String(m.mimeType||'').toLowerCase().includes('pdf'));
      if (pdfMetas.length === 0 && (!course?.materials || course.materials.length === 0)) return;

      try {
        // 1) Load cached plan first (no spinner)
        let savedHash: string | null = null;
        try {
          const ref = doc(db, 'schedules', authUid);
          const snap = await getDoc(ref);
          if (snap.exists()) {
            const saved = snap.data() as any;
            if (saved.plan) setAiPlan(saved.plan as SchedulePlan);
            if (saved.docsHash) savedHash = String(saved.docsHash);
          }
        } catch (e) {
          console.warn('[Calendar] Cache read skipped:', e);
        }

        // 2) Build docs + hash to check for changes
        let docs: Array<{ title: string; text?: string; base64?: string; mimeType?: string }> = [];
        if (extensionId && pdfMetas.length && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          await Promise.all(
            pdfMetas.map(meta => new Promise<void>((resolve) => {
              chrome.runtime.sendMessage(extensionId, { type: 'READ_MATERIAL_FILE', id: meta.id }, (resp: any) => {
                const lastErr = chrome.runtime.lastError;
                if (!lastErr && resp?.success && resp.file?.data) {
                  docs.push({ title: meta.title, base64: resp.file.data, mimeType: resp.file.mimeType || meta.mimeType });
                }
                resolve();
              });
            }))
          );
        }
        if (docs.length === 0 && pdfMetas.length > 0) {
          docs = pdfMetas.map(m => ({ title: m.title, text: '(no file content available from extension; using title only)' }));
        } else if (docs.length === 0 && course?.materials?.length) {
          docs = course.materials.map(m => ({ title: m.title, text: m.content }));
        }
        if (docs.length === 0) { setAutoPlanned(true); return; }

        const docsHash = computeDocsHash(docs);
        if (savedHash && savedHash === docsHash) { setAutoPlanned(true); return; }

        // 3) Only show spinner if changes detected
        setIsPlanning(true);
        setPlanMessage('Creating schedule…');
        const plan = await generateScheduleFromDocs(docs, new Date().toISOString());
        setPlanMessage('Reconciling dates…');
        const reconciled = await reconcileScheduleWithDocs(docs, plan);
        const finalPlan = reconciled;
        setAiPlan(prev => mergePlans(prev, finalPlan));
        try {
          const ref = doc(db, 'schedules', authUid);
          await setDoc(ref, { plan: finalPlan, docsHash, updatedAt: new Date().toISOString() }, { merge: true });
        } catch (e) {
          console.warn('[Calendar] Cache write skipped:', e);
        }
      } catch (e) {
        console.warn('[Calendar] Auto planning failed', e);
        setPlanMessage('Failed to create calendar.');
      } finally {
        setIsPlanning(false);
        setAutoPlanned(true);
      }
    })();
  }, [authUid, materialsMeta, course, extensionId, autoPlanned]);

  const events = useMemo(() => {
    if (aiPlan && aiPlan.items.length > 0) {
      return aiPlan.items.map((it) => ({ id: it.id, date: new Date(it.date), title: it.title }));
    }
    const nextMonday = startOfWeek(addDays(new Date(), 7));
    // Build from extension materials exactly like SavedDataView, PDF only
    const pdfs = (materialsMeta || []).filter(m => m.hasFile && typeof m.mimeType === 'string' && m.mimeType.toLowerCase().includes('pdf'));
    if (pdfs.length > 0) {
      const pseudo: CourseMaterial[] = pdfs.map(m => ({ title: m.title, content: '', images: [] }));
      return scheduleFromMaterials(pseudo, nextMonday);
    }
    if (!course?.materials || course.materials.length === 0) return [] as CalendarEvent[];
    return scheduleFromMaterials(course.materials, nextMonday);
  }, [course, aiPlan, materialsMeta]);

  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    for (const ev of events) {
      const key = formatDateKey(ev.date);
      if (!map[key]) map[key] = [];
      map[key].push(ev);
    }
    return map;
  }, [events]);

  const monthDays = useMemo(() => {
    if (mode !== 'month') return [] as Date[];
    const first = startOfMonth(current);
    const gridStart = startOfWeek(first);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));
    return days;
  }, [mode, current]);

  const weekDays = useMemo(() => {
    if (mode !== 'week') return [] as Date[];
    const ws = startOfWeek(current);
    return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  }, [mode, current]);

  const dayKey = formatDateKey(current);

  return (
    <div className="w-full p-4 text-foreground">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-2">
          <button className="modern-button" onClick={() => setCurrent(addDays(current, mode === 'day' ? -1 : mode === 'week' ? -7 : -30))}>{'<'}</button>
          <button className="modern-button" onClick={() => setCurrent(addDays(current, mode === 'day' ? 1 : mode === 'week' ? 7 : 30))}>{'>'}</button>
        </div>
        <div className="flex gap-2">
          <button className={`modern-button ${mode==='month'?'enhanced-button':''}`} onClick={() => setMode('month')}>Month</button>
          <button className={`modern-button ${mode==='week'?'enhanced-button':''}`} onClick={() => setMode('week')}>Week</button>
          <button className={`modern-button ${mode==='day'?'enhanced-button':''}`} onClick={() => setMode('day')}>Day</button>
        </div>
      </div>

      {authUid && events.length > 0 && (
        <div className="mb-3">
          <button 
            className="modern-button" 
            onClick={async () => {
              setAutoPlanned(false);
              setAiPlan(null);
              // This will trigger the useEffect to regenerate
            }}
            disabled={isPlanning}
            style={{ padding: '6px 12px', width: 'auto' }}
          >
            {isPlanning ? 'Regenerating...' : 'Regenerate Schedule'}
          </button>
          {planMessage && <span className="ml-2 text-xs text-muted-foreground">{planMessage}</span>}
        </div>
      )}

      {loading && <div>Loading saved materials…</div>}
      {!loading && events.length === 0 && (
        <div>
          No saved materials found yet. Open Saved Data to grant permission, then try again.
          {extError && (
            <div className="text-xs text-muted-foreground mt-2">{extError}</div>
          )}
        </div>
      )}

      {!loading && events.length > 0 && (
        <div>
          {mode === 'month' && (
            <div className="grid grid-cols-7 gap-2">
              {monthDays.map((d, idx) => {
                const key = formatDateKey(d);
                const evs = eventsByDay[key] || [];
                const muted = d.getMonth() !== current.getMonth();
                return (
                  <div
                    key={idx}
                    className={`p-2 rounded border ${muted?'opacity-50':''} cursor-pointer hover:bg-accent/20 transition-colors`}
                    onClick={() => { setCurrent(d); setMode('day'); }}
                    title={`View ${evs.length} item(s) on ${d.toDateString()}`}
                  >
                    <div className="text-xs font-semibold mb-1">{d.toLocaleDateString(undefined, { day:'numeric' })}</div>
                    {evs.slice(0, 4).map(e => (
                      <div key={e.id} className="text-xs mb-1 truncate">• {e.title}</div>
                    ))}
                    {evs.length > 4 && <div className="text-[10px] text-muted-foreground">+{evs.length - 4} more</div>}
                  </div>
                );
              })}
            </div>
          )}

          {mode === 'week' && (
            <div className="grid grid-cols-7 gap-2">
              {weekDays.map((d, idx) => {
                const key = formatDateKey(d);
                const evs = eventsByDay[key] || [];
                return (
                  <div
                    key={idx}
                    className="p-2 rounded border cursor-pointer hover:bg-accent/20 transition-colors"
                    onClick={() => { setCurrent(d); setMode('day'); }}
                    title={`View ${evs.length} item(s) on ${d.toDateString()}`}
                  >
                    <div className="text-xs font-semibold mb-1">{d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })}</div>
                    {evs.map(e => (
                      <div key={e.id} className="text-xs mb-1 truncate">• {e.title}</div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {mode === 'day' && (
            <div className="p-3 rounded border w-full max-w-4xl mx-auto">
              <div className="text-sm font-semibold mb-2">{new Date(current).toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' })}</div>
              <div className="mb-3">
                <button className="modern-button" onClick={() => setMode('month')} style={{ width: 'auto', padding: '6px 10px' }}>Back to Month</button>
              </div>
              {(eventsByDay[dayKey] || []).map(e => {
                // If this event came from an AI plan, enrich with details
                const aiItem = aiPlan?.items?.find(it => it.id === e.id);
                // Otherwise, try to find extension meta by title
                const meta = (materialsMeta || []).find(m => m.title === e.title);
                const canOpen = !!(meta && extensionId && meta.hasFile);
                const handleOpen = () => {
                  if (!canOpen) return;
                  try {
                    chrome.runtime.sendMessage(extensionId, { type: 'OPEN_MATERIAL_IN_TAB', id: meta!.id }, (_resp: any) => {
                      const lastErr = chrome.runtime.lastError;
                      if (lastErr) console.warn('[Calendar] OPEN_MATERIAL_IN_TAB error:', lastErr.message);
                    });
                  } catch (err) {
                    console.warn('[Calendar] Failed to open material', err);
                  }
                };
                const handleSummarize = async () => {
                  try {
                    setIsSummarizing(true);
                    // Use event title directly; chapter-first retrieval handled server-side
                    const resp: TopicSummaryResponse = await summarizeTopicWithTextbook(e.title);
                    setActiveSummary({ eventId: e.id, summary: resp.summary, sources: resp.sources.map(s => ({ heading: s.heading, pageStart: s.pageStart || null, pageEnd: s.pageEnd || null, storagePath: s.storagePath || null })) });
                    // Prefetch first source PDF URL for viewer
                    const first = resp.sources.find(s => s.storagePath && s.pageStart && s.pageEnd);
                    if (first?.storagePath) {
                      try {
                        const url = await getSignedPdfUrl(first.storagePath);
                        setActivePdf({ url });
                      } catch {}
                    }
                  } catch (err) {
                    console.warn('[Calendar] Summarize failed', err);
                    alert('Failed to generate study summary.');
                  } finally {
                    setIsSummarizing(false);
                  }
                };
                return (
                  <div key={e.id} className="mb-2 p-2 rounded border bg-card/40">
                    <div className="text-sm font-medium">
                      • {e.title}
                      {aiItem?.section && (
                        <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                          Section {aiItem.section}
                        </span>
                      )}
                    </div>
                    {aiItem && (
                      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        {aiItem.type && (<span className="mr-2 inline-block px-1 py-0.5 rounded bg-accent/40 border">{aiItem.type}</span>)}
                        {aiItem.confidence && (
                          <span className={`inline-block px-1 py-0.5 rounded text-xs ${
                            aiItem.confidence === 'high' ? 'bg-green-100 text-green-800' :
                            aiItem.confidence === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-gray-100 text-gray-800'
                          }`}>
                            {aiItem.confidence === 'high' ? '✓ Syllabus' : 
                             aiItem.confidence === 'medium' ? '~ Inferred' : 
                             '? Estimated'}
                          </span>
                        )}
                        {aiItem.details && (<span>{aiItem.details}</span>)}
                        {aiItem.sourceTitle && (<span className="text-xs">from: {aiItem.sourceTitle}</span>)}
                        {aiItem.sourceLink && (
                          <a className="ml-2 underline" href={aiItem.sourceLink} target="_blank" rel="noreferrer">source</a>
                        )}
                        <button className="modern-button" onClick={handleSummarize} style={{ padding: '4px 8px', width: 'auto' }}>{isSummarizing ? 'Summarizing…' : 'Study Summary'}</button>
                      </div>
                    )}
                    {!aiItem && (
                      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <button className="modern-button" onClick={handleSummarize} style={{ padding: '4px 8px', width: 'auto' }}>{isSummarizing ? 'Summarizing…' : 'Study Summary'}</button>
                      </div>
                    )}

                    {activeSummary?.eventId === e.id && (
                      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3" style={{ minHeight: '400px' }}>
                        <div className="p-2 rounded border overflow-auto" style={{ maxHeight: '70vh' }}>
                          <div className="prose prose-sm max-w-none whitespace-pre-wrap">{activeSummary.summary}</div>
                          <div className="mt-3 text-xs">
                            <div className="font-semibold mb-1">Sources</div>
                            {activeSummary.sources.map((s, idx) => (
                              <div key={idx} className="mb-1">
                                <span>[S{idx+1}] {s.heading || 'Section'} — pages {s.pageStart ?? '?'}–{s.pageEnd ?? '?'}</span>
                                {s.storagePath && (
                                  <button
                                    className="modern-button ml-2"
                                    onClick={async () => {
                                      try {
                                        const url = await getSignedPdfUrl(s.storagePath!);
                                        setActivePdf({ url });
                                      } catch {
                                        alert('Failed to open PDF source.');
                                      }
                                    }}
                                    style={{ padding: '2px 6px', width: 'auto' }}
                                  >Open PDF</button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="p-0 rounded border overflow-hidden" style={{ height: '70vh' }}>
                          {activePdf?.url ? (
                            <PdfViewer url={activePdf.url} />
                          ) : (
                            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Select a source to view PDF</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {(eventsByDay[dayKey] || []).length === 0 && <div className="text-sm text-muted-foreground">No events today</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


