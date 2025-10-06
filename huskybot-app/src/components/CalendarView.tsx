import { useEffect, useMemo, useState } from 'react';
import { getCourseMaterials, CourseData, CourseMaterial } from '../lib/idb';
import { generateScheduleFromDocs, mergePlans, SchedulePlan, reconcileScheduleWithDocs, computeDocsHash } from '../lib/scheduler';
import PdfViewer from './PdfViewer';
import { summarizeTopicWithTextbook, getSignedPdfUrl, TopicSummaryResponse } from '../lib/textbookRetrieval';
import { db } from '../firebase/config';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

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
  const [activePdf, setActivePdf] = useState<{ url: string; pageStart?: number | null; pageEnd?: number | null } | null>(null);
  const [showPdfViewer, setShowPdfViewer] = useState<boolean>(false);
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [networkStatus, setNetworkStatus] = useState<'online' | 'offline' | 'slow'>('online');

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

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => setNetworkStatus('online');
    const handleOffline = () => setNetworkStatus('offline');
    
    // Initial status
    setNetworkStatus(navigator.onLine ? 'online' : 'offline');
    
    // Listen for connectivity changes
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Log debug information to console
  useEffect(() => {
    if (!loading) {
      const debugInfo = {
        network: networkStatus === 'online' ? '🟢 Online' : networkStatus === 'slow' ? '🟡 Slow' : '🔴 Offline',
        signedIn: authUid ? '✅ Yes' : '❌ No',
        extensionId: extensionId || 'None',
        materialsFound: materialsMeta.length,
        pdfMaterials: materialsMeta.filter(m => m.hasFile && String(m.mimeType||'').toLowerCase().includes('pdf')).length,
        courseMaterials: course?.materials?.length || 0,
        autoPlanned: autoPlanned ? 'Yes' : 'No',
        planMessage: planMessage,
        aiPlanExists: aiPlan ? 'Yes' : 'No',
        // events: will be logged separately after events are computed
        extensionError: extError || null
      };
      
      console.log('[Calendar Debug Info]', debugInfo);
    }
  }, [loading, networkStatus, authUid, extensionId, materialsMeta.length, course?.materials?.length, autoPlanned, planMessage, aiPlan, extError]);

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
          // Add timeout to Firestore read
          const snap = await Promise.race([
            getDoc(ref),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Firestore read timeout')), 8000)
            )
          ]) as any;
          if (snap.exists()) {
            const saved = snap.data() as any;
            if (saved.plan) setAiPlan(saved.plan as SchedulePlan);
            if (saved.docsHash) savedHash = String(saved.docsHash);
          }
        } catch (e) {
          console.warn('[Calendar] Cache read skipped (network issue):', e);
          // Update network status based on Firebase errors
          if (e instanceof Error && (
            e.message.includes('timeout') || 
            e.message.includes('QUIC') || 
            e.message.includes('CONNECTION_TIMED_OUT')
          )) {
            setNetworkStatus('slow');
          }
          setPlanMessage('Network connectivity issue with Firebase. Continuing without cache...');
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
          // Add timeout to Firestore write
          await Promise.race([
            setDoc(ref, { plan: finalPlan, docsHash, updatedAt: new Date().toISOString() }, { merge: true }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Firestore write timeout')), 8000)
            )
          ]);
          console.log('[Calendar] Schedule cached successfully');
        } catch (e) {
          console.warn('[Calendar] Cache write skipped (network issue):', e);
          // Update network status based on Firebase errors
          if (e instanceof Error && (
            e.message.includes('timeout') || 
            e.message.includes('QUIC') || 
            e.message.includes('CONNECTION_TIMED_OUT')
          )) {
            setNetworkStatus('slow');
          }
          setPlanMessage('Schedule generated but cache failed due to network issues.');
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

  // Log events information separately after events are computed
  useEffect(() => {
    console.log('[Calendar Events Info]', {
      eventsCount: events.length,
      eventsByDay: Object.keys(eventsByDay).length,
      totalDaysWithEvents: Object.keys(eventsByDay).filter(key => eventsByDay[key].length > 0).length
    });
  }, [events, eventsByDay]);

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
      {/* Month/Period Title */}
      <div className="text-center mb-4">
        <h1 className="text-2xl font-semibold text-foreground">
          {mode === 'month' && current.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          {mode === 'week' && `Week of ${startOfWeek(current).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
          {mode === 'day' && current.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </h1>
      </div>

      {/* Navigation and Mode Controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <button className="modern-button" onClick={() => setCurrent(addDays(current, mode === 'day' ? -1 : mode === 'week' ? -7 : -30))}>
            ← Previous
          </button>
          <button className="modern-button" onClick={() => setCurrent(addDays(current, mode === 'day' ? 1 : mode === 'week' ? 7 : 30))}>
            Next →
          </button>
        </div>
        <div className="flex gap-2">
          <button className={`modern-button ${mode==='month'?'bg-accent text-accent-foreground':''}`} onClick={() => setMode('month')}>Month</button>
          <button className={`modern-button ${mode==='week'?'bg-accent text-accent-foreground':''}`} onClick={() => setMode('week')}>Week</button>
          <button className={`modern-button ${mode==='day'?'bg-accent text-accent-foreground':''}`} onClick={() => setMode('day')}>Day</button>
        </div>
      </div>

      {authUid && (
        <div className="mb-3 flex gap-2">
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
          
          {/* Manual test generation button */}
          <button 
            className="modern-button bg-blue-500 text-white" 
            onClick={async () => {
              try {
                setIsPlanning(true);
                setPlanMessage('Testing calendar generation...');
                
                // Create test documents
                const testDocs = [
                  {
                    title: "Course Syllabus - Linear Algebra",
                    text: `Course Schedule:
Week 1 (Sept 5): Introduction to Linear Systems - Section 1.1
Week 2 (Sept 12): Row Reduction - Section 1.2  
Week 3 (Sept 19): Vector Equations - Section 1.3
Week 4 (Sept 26): Matrix Equations - Section 1.4
Week 5 (Oct 3): Linear Independence - Section 1.7
Midterm Exam: October 10
Week 6 (Oct 17): Introduction to Transformations - Section 1.8
Week 7 (Oct 24): Matrix of Linear Transformation - Section 1.9
Final Exam: December 15`
                  }
                ];
                
                const plan = await generateScheduleFromDocs(testDocs, new Date().toISOString());
                setAiPlan(plan);
                setPlanMessage('Test calendar generated successfully!');
                
                // Save to Firebase
                if (authUid) {
                  const ref = doc(db, 'schedules', authUid);
                  await setDoc(ref, { 
                    plan, 
                    docsHash: 'test-hash', 
                    updatedAt: new Date().toISOString() 
                  }, { merge: true });
                }
              } catch (err) {
                console.error('Test generation failed:', err);
                const errorMsg = String(err);
                if (errorMsg.includes('VITE_GEMINI_API_KEY')) {
                  setPlanMessage('❌ Missing Google AI API key. Please create a .env file with VITE_GEMINI_API_KEY=your_key');
                } else if (errorMsg.includes('503') || errorMsg.includes('overloaded')) {
                  setPlanMessage('⏳ AI model is overloaded. Please try again in a few minutes.');
                } else if (errorMsg.includes('404') || errorMsg.includes('not found')) {
                  setPlanMessage('🔧 AI model not available. Using fallback models...');
                } else {
                  setPlanMessage('❌ Test generation failed: ' + errorMsg);
                }
              } finally {
                setIsPlanning(false);
              }
            }}
            disabled={isPlanning}
            style={{ padding: '6px 12px', width: 'auto' }}
          >
            Test Generate
          </button>
          
          {planMessage && <span className="ml-2 text-xs text-muted-foreground">{planMessage}</span>}
        </div>
      )}

      {loading && <div>Loading saved materials…</div>}
      

      {networkStatus !== 'online' && (
        <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded text-sm">
          ⚠️ <strong>Network Issues Detected:</strong> {
            networkStatus === 'slow' ? 'Slow connection to Firebase. Operations may take longer.' :
            'You appear to be offline. Some features may not work properly.'
          }
        </div>
      )}

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
                <button className="modern-button" onClick={() => setMode('month')}>← Back to Month</button>
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
                    
                    if (!authUid) {
                      alert('Please sign in to generate study summaries.');
                      return;
                    }

                    // Create cache key based on event title and date
                    const cacheKey = `${formatDateKey(e.date)}__${e.id}`;
                    const cacheRef = doc(db, 'schedules', authUid, 'summaries', cacheKey);
                    
                    // Try to load from cache first
                    try {
                      const cachedSnap = await getDoc(cacheRef);
                      if (cachedSnap.exists()) {
                        const cached = cachedSnap.data();
                        console.log('[Calendar] Using cached study summary');
                        setActiveSummary({ 
                          eventId: e.id, 
                          summary: cached.summary, 
                          sources: cached.sources || [] 
                        });
                        
                        // Prefetch first source PDF URL for viewer
                        const first = (cached.sources || []).find((s: any) => s.storagePath && s.pageStart && s.pageEnd);
                        if (first?.storagePath) {
                          try {
                            const url = await getSignedPdfUrl(first.storagePath, 15, first.pageStart || undefined);
                            setActivePdf({ url, pageStart: first.pageStart, pageEnd: first.pageEnd });
                          } catch {}
                        }
                        return;
                      }
                    } catch (cacheErr) {
                      console.warn('[Calendar] Cache read failed, generating new summary:', cacheErr);
                    }

                    // Generate new summary if not cached
                    console.log('[Calendar] Generating new study summary');
                    const resp: TopicSummaryResponse = await summarizeTopicWithTextbook(e.title);
                    const summaryData = {
                      eventId: e.id,
                      summary: resp.summary,
                      sources: resp.sources.map(s => ({ 
                        heading: s.heading, 
                        pageStart: s.pageStart || null, 
                        pageEnd: s.pageEnd || null, 
                        storagePath: s.storagePath || null 
                      }))
                    };
                    
                    setActiveSummary(summaryData);
                    
                    // Save to cache
                    try {
                      await setDoc(cacheRef, {
                        ...summaryData,
                        eventTitle: e.title,
                        eventDate: formatDateKey(e.date),
                        generatedAt: new Date().toISOString(),
                        cachedAt: new Date().toISOString()
                      });
                      console.log('[Calendar] Study summary cached successfully');
                    } catch (saveErr) {
                      console.warn('[Calendar] Failed to cache study summary:', saveErr);
                    }
                    
                    // Prefetch first source PDF URL for viewer
                    const first = resp.sources.find(s => s.storagePath && s.pageStart && s.pageEnd);
                    if (first?.storagePath) {
                      try {
                        const url = await getSignedPdfUrl(first.storagePath, 15, first.pageStart || undefined);
                        setActivePdf({ url, pageStart: first.pageStart, pageEnd: first.pageEnd });
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
                        <button className="modern-button" onClick={handleSummarize} disabled={isSummarizing}>
                          {isSummarizing ? '🤖 Analyzing...' : '📚 Study Summary'}
                        </button>
                      </div>
                    )}
                    {!aiItem && (
                      <div className="mt-1 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <button className="modern-button" onClick={handleSummarize} disabled={isSummarizing}>
                          {isSummarizing ? '🤖 Analyzing...' : '📚 Study Summary'}
                        </button>
                      </div>
                    )}

                    {activeSummary?.eventId === e.id && (
                      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => {
                        setActiveSummary(null);
                        setActivePdf(null);
                        setShowPdfViewer(false);
                      }}>
                        <div className="bg-white rounded-lg shadow-xl w-[98vw] h-[96vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-between p-4 border-b bg-gray-50">
                            <h2 className="text-xl font-semibold">Study Summary: {e.title}</h2>
                            <div className="flex items-center gap-3">
                              <button 
                                onClick={() => setShowPdfViewer(!showPdfViewer)}
                                className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 text-sm font-medium"
                              >
                                {showPdfViewer ? '📖 Hide PDF' : '📖 Show PDF'}
                              </button>
                              <button 
                                onClick={() => {
                                  setActiveSummary(null);
                                  setActivePdf(null);
                                  setShowPdfViewer(false);
                                }}
                                className="text-gray-500 hover:text-gray-700 text-2xl font-bold"
                              >×</button>
                            </div>
                          </div>
                          
                          <div className="flex-1 flex overflow-hidden">
                            <div className={`${showPdfViewer && activePdf?.url ? 'w-1/2' : 'w-full'} flex flex-col transition-all duration-300`}>
                              <div className="flex-1 p-6 overflow-auto">
                                <div className="prose prose-lg max-w-none">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={[rehypeKatex]}
                                  >
                                    {activeSummary.summary}
                                  </ReactMarkdown>
                                </div>
                              </div>
                              
                              <div className="p-4 border-t bg-gray-50">
                                <div className="flex items-center justify-between mb-3">
                                  <h3 className="text-lg font-semibold">Sources</h3>
                                  <button
                                    className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm font-medium"
                                    onClick={async () => {
                                      if (!authUid) return;
                                      // Force regenerate by deleting cache and calling handleSummarize again
                                      const cacheKey = `${formatDateKey(e.date)}__${e.id}`;
                                      const cacheRef = doc(db, 'schedules', authUid, 'summaries', cacheKey);
                                      try {
                                        await deleteDoc(cacheRef);
                                        console.log('[Calendar] Cache cleared, regenerating summary');
                                        setActiveSummary(null);
                                        handleSummarize();
                                      } catch (err) {
                                        console.warn('[Calendar] Failed to clear cache:', err);
                                        handleSummarize(); // Try regenerating anyway
                                      }
                                    }}
                                  >
                                    🔄 Regenerate
                                  </button>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-32 overflow-y-auto">
                                  {activeSummary.sources.map((s, idx) => (
                                    <div key={idx} className="p-3 bg-white rounded border">
                                      <div className="font-medium text-sm">[S{idx+1}] {s.heading || 'Section'}</div>
                                      <div className="text-xs text-gray-600 mb-2">Pages {s.pageStart ?? '?'}–{s.pageEnd ?? '?'}</div>
                                      {s.storagePath && (
                                        <button
                                          className="px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
                                          onClick={async () => {
                                            try {
                                              const url = await getSignedPdfUrl(s.storagePath!, 15, s.pageStart || undefined);
                                              setActivePdf({ url, pageStart: s.pageStart, pageEnd: s.pageEnd });
                                              setShowPdfViewer(true);
                                            } catch {
                                              alert('Failed to open PDF source.');
                                            }
                                          }}
                                        >📄 View Pages {s.pageStart}–{s.pageEnd}</button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                            
                            {showPdfViewer && activePdf?.url && (
                              <div className="w-1/2 flex flex-col border-l">
                                <div className="p-3 border-b bg-gray-50 flex items-center justify-between">
                                  <span className="text-sm font-medium">
                                    📖 PDF Viewer {activePdf.pageStart && activePdf.pageEnd && `(Pages ${activePdf.pageStart}–${activePdf.pageEnd})`}
                                  </span>
                                  <button 
                                    onClick={() => {
                                      setActivePdf(null);
                                      setShowPdfViewer(false);
                                    }}
                                    className="text-gray-500 hover:text-gray-700 font-bold"
                                  >×</button>
                                </div>
                                <div className="flex-1 overflow-hidden">
                                  <PdfViewer 
                                    url={activePdf.url} 
                                    pageStart={activePdf.pageStart} 
                                    pageEnd={activePdf.pageEnd} 
                                  />
                                </div>
                              </div>
                            )}
                          </div>
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


