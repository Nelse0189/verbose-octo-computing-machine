const functions = require("firebase-functions");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require("cors")({ origin: true });
const { getMenu, DiningHallType, DiningHallHours } = require("@ilefa/blueplate");
const pdf = require('pdf-parse');

// Resolve Storage bucket explicitly (supports non-standard bucket hostname)
const CFG = functions.config() || {};
const KEYS = (CFG && CFG.keys) || {};
const STORAGE_BUCKET = KEYS.storage_bucket || 'huskybot-dabab.firebasestorage.app';

admin.initializeApp({
  storageBucket: STORAGE_BUCKET,
});
const storage = admin.storage();

let pinecone, genAI, geminiModel, mainIndex, clubsIndex, pdfRendererEndpoint;
let clientsInitialized = false;

function initializeClients() {
  if (clientsInitialized) return;

  try {
    const config = functions.config().keys;
    if (!config || !config.pinecone_key || !config.pinecone_index_name || !config.gemini_key) {
      throw new Error("Missing required secret keys in functions configuration.");
    }
    pinecone = new Pinecone({ apiKey: config.pinecone_key });
    genAI = new GoogleGenerativeAI(config.gemini_key);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    pdfRendererEndpoint = config.pdf_renderer_endpoint || '';
    
    // Unified index for all content (use namespaces for per-user segregation)
    mainIndex = pinecone.index(config.pinecone_index_name);
    // Legacy clubs index (fallback until clubs are reindexed into unified)
    clubsIndex = pinecone.index('huskybot-clubs');

    clientsInitialized = true;
    logger.info("AI clients initialized successfully with unified index.");
  } catch (error) {
    logger.error("Failed to initialize clients:", error);
    clientsInitialized = false;
  }
}

// --- Textbook ingestion trigger ---
exports.onTextbookCreated = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .region('us-central1')
  .firestore
  .document('textbooks/{docId}')
  .onCreate(async (snap, context) => {
    try {
      initializeClients();
      if (!clientsInitialized) throw new Error('Clients not initialized');

      const db = admin.firestore();
      const data = snap.data() || {};
      const {
        ownerUid,
        storagePath,
        fileUrl,
        title = '',
        courseId = '',
        edition = '',
        author = '',
        isbn = ''
      } = data;

      if (!ownerUid || !storagePath) {
        await snap.ref.update({ ingestStatus: 'error', ingestError: 'Missing ownerUid or storagePath' });
        return;
      }

      await snap.ref.update({
        ingestStatus: 'processing',
        ingestStage: 'download_pdf',
        ingestStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        storageBucket: STORAGE_BUCKET,
      });

      // Download PDF from Storage
      const bucket = storage.bucket();
      const tempFilePath = `/tmp/${context.params.docId}.pdf`;
      logger.info('[Ingest] Download start', { docId: context.params.docId, storagePath, bucket: bucket.name });
      await bucket.file(storagePath).download({ destination: tempFilePath });
      logger.info('[Ingest] Download complete', { docId: context.params.docId });

      // Extract per-page text and aggregate
      const fs = require('fs');
      const buffer = fs.readFileSync(tempFilePath);
      await snap.ref.update({ ingestStage: 'extract_pages' });
      const perPage = [];
      const parsed = await pdf(buffer, {
        pagerender: (pageData) => pageData.getTextContent().then(tc => {
          const s = (tc.items || []).map(i => i.str).join('\n');
          perPage.push(s);
          return s;
        })
      });
      const rawText = (perPage && perPage.length > 0) ? perPage.join('\n\n') : (parsed.text || '');
      const totalPages = perPage.length || parsed.numpages || 0;
      logger.info('[Ingest] Pages extracted', { docId: context.params.docId, totalPages });

      // --- Math heuristics ---
      function normalizeMathArtifacts(s) {
        return String(s)
          .replace(/\bC\b/g, '+') // many PDFs encode + as C in exercises
          .replace(/\bD\b/g, '=') // many PDFs encode = as D in exercises
          .replace(/[−–—·•]/g, '-') // normalize dashes and dots
      }
      function computeMathDensity(t) {
        if (!t) return 0;
        const norm = normalizeMathArtifacts(t);
        const mathChars = /[∑∏∫√∞≈≠≤≥±÷×παβγδθλμνξστυφχψωΩ→←⇒⇔⟂⊥∈∉∩∪⊂⊆⊄⊇∅∇∆∂≃≅≡≤≥∝∴∵√^_]/g;
        const matches = String(norm).match(mathChars);
        const symbols = matches ? matches.length : 0;
        const eqLike = (norm.match(/[^\w]=[^=]/g) || []).length
          + (norm.match(/\b(dy\/dx|x\^\d|y\^\d|\w_\d)\b/g) || []).length
          + (norm.match(/\b[xyz]\s*\d+\b/gi) || []).length; // e.g., x 1, x 2
        const len = Math.max(1, norm.length);
        return (symbols + eqLike) / len;
      }

      // Detect scanned pages and simple headings by regex
      const emptyPageIdx = [];
      const pageMeta = [];
      let currentChapter = '';
      let currentSection = '';
      for (let p = 0; p < (perPage.length || 0); p++) {
        const text = perPage[p] || '';
        if ((text.trim()).length < 30) emptyPageIdx.push(p + 1);
        const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
        for (const line of lines.slice(0, 15)) { // scan top lines for headings
          if (/^chapter\s+\d+\b/i.test(line)) currentChapter = line;
          else if (/^\d+(?:\.\d+)*\s+\S+/.test(line)) currentSection = line;
        }
        pageMeta.push({ page: p + 1, chapter: currentChapter || null, section: currentSection || null });
      }

      const scannedRatio = totalPages ? (emptyPageIdx.length / totalPages) : 0;
      const scanned = scannedRatio > 0.5;
      await snap.ref.update({ totalPages, scanned, ocrPendingCount: emptyPageIdx.length, scannedRatio });
      logger.info('[Ingest] Scan detection', { docId: context.params.docId, scanned, scannedRatio, emptyPages: emptyPageIdx.length });

      // Remove LaTeX-OCR trigger (no longer used)

      // --- Visual TOC Parsing (AI reads images of first 20 pages) ---
      let tocEntries = [];
      try {
        logger.info('[Ingest][TOC-Vision] Calling PDF renderer for first 20 pages...');
        if (!pdfRendererEndpoint) throw new Error('PDF renderer endpoint is not configured');

        const rendererResponse = await fetch(`${pdfRendererEndpoint}/render-pages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gcsPath: `gs://${STORAGE_BUCKET}/${storagePath}`,
            pageStart: 1,
            pageEnd: 20,
          }),
        });

        if (!rendererResponse.ok) {
          throw new Error(`PDF renderer failed with status ${rendererResponse.status}: ${await rendererResponse.text()}`);
        }

        const { images } = await rendererResponse.json();
        const imageParts = (images || []).map(img => ({
          inlineData: { mimeType: 'image/png', data: img.base64 },
        }));

        logger.info(`[Ingest][TOC-Vision] Received ${imageParts.length} page images. Asking AI to parse TOC.`);

        const tocParserPrompt = `Analyze these textbook page images. Find the main Table of Contents and extract the chapter and section information. Respond with ONLY a valid JSON array of objects, where each object has "token" (e.g., "1.1"), "title" (e.g., "Systems of Linear Equations"), and "page" (e.g., 26). The token must be a numeric identifier like X.X.
e.g., [{"token": "1.1", "title": "Systems of Linear Equations", "page": 26}, {"token": "1.2", "title": "Row Reduction and Echelon Forms", "page": 37}]`;

        const requestPayload = {
          contents: [{ role: 'user', parts: [{ text: tocParserPrompt }, ...imageParts] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        };

        const result = await geminiModel.generateContent(requestPayload);
        const rawResponse = await result.response.text();
        const parsedToc = JSON.parse(rawResponse);

        if (Array.isArray(parsedToc)) {
          tocEntries = parsedToc
            .map(e => ({
              token: String(e.token || '').trim(),
              title: String(e.title || '').trim(),
              page: Number(e.page || 0),
            }))
            .filter(e => e.token && e.title && e.page > 0 && /^\d+(\.\d+)*$/.test(e.token))
            .sort((a, b) => a.page - b.page);
        }
        
        logger.info('[Ingest][TOC-Vision] AI successfully parsed TOC from images.', { count: tocEntries.length });
        await snap.ref.set({ toc: tocEntries }, { merge: true });

      } catch (e) {
        logger.error('[Ingest][TOC-Vision] The visual TOC parsing process failed.', { error: String(e?.message || e), stack: e.stack });
      }

      // If we have a usable TOC, segment strictly by TOC and create a segments array.
      if (tocEntries.length >= 3) {
        const segments = tocEntries.map((cur, i) => {
          const next = tocEntries[i + 1];
          const ps = Number(cur.page);
          const pe = Math.min(totalPages, next ? Number(next.page) - 1 : totalPages);
          return {
            sectionToken: cur.token,
            title: cur.title,
            pageStart: ps,
            pageEnd: pe,
            kind: 'section',
          };
        });

        await snap.ref.update({
          ingestStatus: 'done',
          ingestStage: 'done',
          segmentedBy: 'toc',
          segments: segments,
          segmentCount: segments.length,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        logger.info('[Ingest] Completed via TOC segmentation', { docId: context.params.docId, count: segments.length });
        return;
      }

      // If TOC segmentation failed, fall back to minimal page-based segmentation
      logger.warn('[Ingest] TOC insufficient, falling back to page-based segmentation', { tocCount: tocEntries.length });
      const pageSegments = [];
      for (let p = 0; p < totalPages; p++) {
        pageSegments.push({
          sectionToken: `P${p + 1}`,
          title: `Page ${p + 1}`,
          pageStart: p + 1,
          pageEnd: p + 1,
          kind: 'page'
        });
      }
      await snap.ref.update({
        ingestStatus: 'done',
        ingestStage: 'done',
        segments: pageSegments,
        segmentedBy: 'pages',
        segmentCount: pageSegments.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      logger.info('[Ingest] Completed via page-based fallback segmentation', { docId: context.params.docId });

    } catch (err) {
      logger.error('[onTextbookCreated] Ingest failed', err);
      try {
        await snap.ref.update({ ingestStatus: 'error', ingestStage: 'error', ingestError: String(err?.message || err) });
      } catch {}
    }
  });

// The processSubchapter function is now obsolete with the TOC-first, image-based summary approach.
// It is removed to prevent accidental triggers and to clean up the codebase.

// Very lightweight intent detector to decide which corpus to query
function detectIntent(userMessage) {
  const text = (userMessage || "").toLowerCase();
  const clubKeywords = [
    'club', 'clubs', 'organization', 'organizations', 'org', 'student org', 'sports club', 'intramural', 'team', 'join', 'meetings for', 'when do they meet', 'who can join'
  ];
  const announcementKeywords = [
    'announcement', 'announcements', 'posted', 'due', 'deadline', 'assignment', 'exam', 'quiz', 'update', 'class', 'lecture'
  ];

  const isClubIntent = clubKeywords.some(k => text.includes(k));
  const isAnnouncementIntent = announcementKeywords.some(k => text.includes(k));

  if (isClubIntent && !isAnnouncementIntent) return 'clubs';
  if (isAnnouncementIntent && !isClubIntent) return 'announcements';
  return 'both';
}

// Extract simple date terms like "july 18" or "sept 2" from the user query
function extractDateTerms(userMessage) {
  const text = (userMessage || '').toLowerCase();
  const monthNames = [
    'january','february','march','april','may','june','july','august','september','october','november','december',
    'jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec'
  ];
  // match e.g. "july 18th", "sept 2", "dec 01"
  const regex = new RegExp(`\\b(${monthNames.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  const terms = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const month = match[1];
    const day = match[2];
    terms.push(`${month} ${day}`.toLowerCase());
  }
  return terms;
}

function monthStrToIndex(m) {
  const map = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11,
  };
  return map[m?.toLowerCase?.()] ?? null;
}

function parseMonthDayFromString(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  // Try ISO-like first (YYYY-MM-DD or YYYY/MM/DD)
  const iso = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (iso) {
    const monthIdx = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    if (!Number.isNaN(monthIdx) && !Number.isNaN(day)) return { monthIdx, day };
  }
  // Try M/D/YY or M/D/YYYY
  const mdys = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (mdys) {
    const monthIdx = Number(mdys[1]) - 1;
    const day = Number(mdys[2]);
    if (!Number.isNaN(monthIdx) && !Number.isNaN(day)) return { monthIdx, day };
  }
  // Try "Month 18" or "Mon 18th"
  const md = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\s+(\d{1,2})(?:st|nd|rd|th)?/);
  if (md) {
    const monthIdx = monthStrToIndex(md[1]);
    const day = Number(md[2]);
    if (monthIdx !== null && !Number.isNaN(day)) return { monthIdx, day };
  }
  return null;
}

function monthDayKeyFromMonthIdxDay(monthIdx, day) {
  if (monthIdx == null || day == null) return null;
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${mm}-${dd}`;
}

function monthDayKeyFromDateString(dateStr) {
  const md = parseMonthDayFromString(dateStr);
  if (!md) return null;
  return monthDayKeyFromMonthIdxDay(md.monthIdx, md.day);
}

function parseDateTerm(term) {
  if (!term) return null;
  const parts = String(term).trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;
  const monthIdx = monthStrToIndex(parts[0]);
  const day = Number(parts[1].replace(/(st|nd|rd|th)$/i, ''));
  if (monthIdx == null || Number.isNaN(day)) return null;
  return { monthIdx, day };
}

function extractCourseCodesFromText(text) {
  const t = (text || '').toUpperCase();
  const regex = /\b[A-Z]{2,5}-?\d{3,4}\b/g;
  const set = new Set();
  let m;
  while ((m = regex.exec(t)) !== null) {
    // Normalize to format like ABCD-1234 (with dash)
    const raw = m[0];
    const norm = raw.includes('-') ? raw : `${raw.slice(0, raw.length - 4)}-${raw.slice(-4)}`;
    set.add(norm);
  }
  return Array.from(set);
}

async function queryAnnouncements(query, options = {}) {
  const { minScore = 0.0, debug = false, topK = 3, dateTerms = [], courseCodes = [], namespace = 'anonymous' } = options;
  try {
    const embeddingResponse = await genAI.getGenerativeModel({ model: "text-embedding-004" }).embedContent({
        content: { parts: [{ text: query }] },
        outputDimensionality: 512,
    });
    const queryVector = embeddingResponse.embedding.values;

    // Build Pinecone metadata filter when possible
    let baseFilter = { type: 'announcement' };
    const dateKeys = (dateTerms || [])
      .map(parseDateTerm)
      .filter(Boolean)
      .map(d => monthDayKeyFromMonthIdxDay(d.monthIdx, d.day))
      .filter(Boolean);

    if (courseCodes && courseCodes.length > 0) {
      baseFilter.courseCode = { $in: courseCodes };
    }

    const indexNs = mainIndex.namespace(namespace || 'anonymous');

    // First try with md filter if we have dateKeys
    let firstFilter = { ...baseFilter };
    if (dateKeys.length > 0) firstFilter.md = { $in: dateKeys };

    let queryResult = await indexNs.query({
      topK,
      vector: queryVector,
      includeMetadata: true,
      ...(firstFilter ? { filter: firstFilter } : {})
    });

    // If no matches and we used md filter, retry without md filter for recall
    if ((queryResult.matches?.length ?? 0) === 0 && dateKeys.length > 0) {
      if (debug) logger.info('[Announcements] md-filtered query returned 0. Retrying without md filter.');
      const fallbackFilter = { ...baseFilter };
      queryResult = await indexNs.query({
        topK,
        vector: queryVector,
        includeMetadata: true,
        ...(fallbackFilter ? { filter: fallbackFilter } : {})
      });
    }

    const matches = (queryResult.matches || []).map(match => {
      const rawMd = match.metadata?.md;
      const computedMd = rawMd || monthDayKeyFromDateString(match.metadata?.date || '');
      return ({
        id: match.id,
        score: match.score,
        summary: match.metadata?.summary,
        courseName: match.metadata?.courseName,
        courseCode: match.metadata?.courseCode,
        title: match.metadata?.title,
        date: match.metadata?.date,
        md: computedMd || undefined,
        idbKey: match.metadata?.idbKey,
      });
    });

    let filtered;
    if (dateKeys.length > 0) {
      const mdMatches = matches.filter(m => m.md && dateKeys.includes(m.md));
      if (mdMatches.length > 0) {
        const minScoreForMd = 0.35; // accept lower scores for exact date hits
        filtered = mdMatches.filter(m => typeof m.score !== 'number' ? true : m.score >= minScoreForMd);
      } else {
        // fallback: score-only
        filtered = matches.filter(m => typeof m.score === 'number' ? m.score >= minScore : true);
      }
    } else {
      filtered = matches.filter(m => typeof m.score === 'number' ? m.score >= minScore : true);
    }

    // No forced minimum results; return only threshold-qualified results

    if (debug) {
      logger.info('[Announcements] Namespace', namespace);
      logger.info('[Announcements] Filters', { baseFilter, dateKeys, usedMdFilter: dateKeys.length > 0 });
      logger.info('[Announcements] Raw matches', matches);
      logger.info('[Announcements] Filtered matches', filtered);
    }

    return filtered;
  } catch (error) {
    logger.error('Error querying announcements:', error);
    return [];
  }
}

async function searchClubsUnified(query, options = {}) {
  const { minScore = 0.0, debug = false } = options;
  try {
    const embeddingResponse = await genAI.getGenerativeModel({ model: "text-embedding-004" }).embedContent({
        content: { parts: [{ text: query.replace(/\n/g, ' ') }] },
        outputDimensionality: 512,
    });
    const queryEmbedding = embeddingResponse.embedding.values;

    const indexNs = mainIndex.namespace('global');
    const searchResponse = await indexNs.query({
      vector: queryEmbedding,
      topK: 10,
      includeMetadata: true,
      filter: { type: 'club' }
    });

    const rawMatches = (searchResponse.matches || []).map(m => ({
      id: m.id,
      score: m.score,
      firestoreId: m.metadata?.firestoreId,
      name: m.metadata?.name,
      summary: m.metadata?.summary,
    }));

    if (debug) logger.info('[Clubs-Unified] Raw matches', rawMatches);

    const chosen = rawMatches.filter(m => (typeof m.score !== 'number') || m.score >= minScore);

    const firestoreIds = chosen
      .map(m => m.firestoreId)
      .filter(id => id);

    const clubsWithFullDetails = [];
    if (firestoreIds.length > 0) {
      const db = admin.firestore();
      const clubDocs = await db.collection('clubs').where(admin.firestore.FieldPath.documentId(), 'in', firestoreIds).get();
      clubDocs.forEach(doc => {
        clubsWithFullDetails.push(doc.data());
      });
    }

    return clubsWithFullDetails;
  } catch (error) {
    logger.error('Error searching unified clubs:', error);
    return [];
  }
}

async function searchClubs(query, options = {}) {
  // Use unified index only to avoid dimension mismatches with legacy 1536-dim index
  return await searchClubsUnified(query, options);
}

async function generateComprehensiveResponse(userMessage, announcements, clubs) {
  try {
    let context = "";

    if (announcements && announcements.length > 0) {
      context += "Relevant Announcements:\n" + announcements.map(a => `Title: ${a.title || 'N/A'} | Course: ${a.courseName || 'N/A'} | Date: ${a.date || 'N/A'}\n${a.summary || ''}`).join("\n---\n") + "\n\n";
    }

    if (clubs && clubs.length > 0) {
      context += "Relevant Clubs:\n" + clubs.map(c => `Name: ${c.name}, Summary: ${c.summary || 'N/A'}`).join("\n---\n") + "\n\n";
    }

    if (!context) {
      context = "No specific context found. Please answer the user's question based on general knowledge.";
    }

    const nowUtc = new Date().toISOString();
    const nowEt = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    const prompt = `You are a helpful UConn student assistant.

Current date/time: ${nowEt} (America/New_York), ${nowUtc} (UTC)

Based ONLY on the context provided below, answer the user's question. If the context doesn't contain the answer, say that you don't have enough information. When the user uses relative dates (e.g., today, tomorrow, next week), interpret them relative to the current date/time above.

Context:
---
${context}
---

User Question: ${userMessage}`;

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    logger.error('Error generating comprehensive response:', error);
    return "I'm sorry, I encountered an error while formulating a response.";
  }
}

function buildAnnouncementQueryVariants(message, dateTerms, courseCodes) {
  const variants = new Set();
  const msg = (message || '').trim();
  if (msg) variants.add(msg);

  // Date-focused variants
  if (dateTerms && dateTerms.length > 0) {
    for (const dt of dateTerms) {
      variants.add(`announcements for ${dt}`);
      variants.add(`announcement on ${dt}`);
      variants.add(`class updates ${dt}`);
    }
  }

  // Course-focused variants
  if (courseCodes && courseCodes.length > 0) {
    for (const code of courseCodes) {
      variants.add(`${code} announcements`);
      variants.add(`updates for ${code}`);
      variants.add(`assignments ${code}`);
    }
  }

  // Generic expansion
  variants.add(`class announcements and deadlines ${msg}`);
  variants.add(`course announcements ${msg}`);

  return Array.from(variants).filter(Boolean);
}

function unionMatchesById(arrays) {
  const byId = new Map();
  for (const arr of arrays) {
    for (const m of (arr || [])) {
      const existing = byId.get(m.id);
      if (!existing || (typeof m.score === 'number' && m.score > (existing.score ?? -Infinity))) {
        byId.set(m.id, m);
      }
    }
  }
  return Array.from(byId.values());
}

exports.indexAnnouncement = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      initializeClients();
      if (!clientsInitialized) {
        throw new Error("Clients not initialized. Check logs for secret key errors.");
      }

      const { announcementId, courseName, title, date, content, namespace } = req.body;
      if (!announcementId || !courseName || !title || !date || !content) {
        return res.status(400).send("Bad Request: Missing required fields.");
      }

      const summaryPrompt = `Summarize: Course: ${courseName}, Title: ${title}, Date: ${date}, Content: "${content}"`;
      const summaryResult = await geminiModel.generateContent(summaryPrompt);
      const summary = await summaryResult.response.text();

      // Compute metadata helpers for better filtering
      const mdKey = monthDayKeyFromDateString(date);
      const courseCodes = extractCourseCodesFromText(courseName + ' ' + title);
      const courseCode = courseCodes.length > 0 ? courseCodes[0] : undefined;

      const embeddingResponse = await genAI.getGenerativeModel({ model: "text-embedding-004" }).embedContent({
          content: { parts: [{ text: summary }] },
          outputDimensionality: 512,
      });
      const vector = embeddingResponse.embedding.values;

      const ns = (typeof namespace === 'string' && namespace.trim().length > 0) ? namespace.trim() : 'anonymous';
      const indexNs = mainIndex.namespace(ns);

      const metadata = {
        type: 'announcement',
        courseName: String(courseName),
        title: String(title),
        date: String(date),
        summary: String(summary),
        idbKey: String(announcementId),
      };
      if (courseCode) metadata.courseCode = String(courseCode);
      if (mdKey) metadata.md = String(mdKey);

      await indexNs.upsert([{
        id: announcementId.toString(),
        values: vector,
        metadata,
      }]);

      res.status(200).send({ message: "Announcement indexed successfully.", namespace: ns });

    } catch (error) {
      logger.error(`Error processing ID ${req.body?.announcementId}:`, error);
      res.status(500).send("Internal Server Error");
    }
  });
});

// Return a short-lived signed URL for a PDF in GCS so the frontend can embed it inline
exports.getSignedPdfUrl = functions
  .runWith({ serviceAccount: 'huskybot-dabab@appspot.gserviceaccount.com' })
  .https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (method === 'OPTIONS') return res.status(204).send('');
      if (method !== 'POST') return res.status(405).send('Method Not Allowed');

      const body = req.body || {};
      const storagePath = body.storagePath || body.path;
      const minutes = Math.max(1, Math.min(120, Number(body.minutes || 15)));
      if (!storagePath || typeof storagePath !== 'string') {
        return res.status(400).send('Missing storagePath');
      }

      // Normalize storagePath: accept either 'textbooks/..pdf' or 'gs://bucket/textbooks/..pdf'
      let targetBucketName = storage.bucket().name;
      let objectPath = String(storagePath);
      if (objectPath.startsWith('gs://')) {
        try {
          const withoutScheme = objectPath.slice(5);
          const slashIdx = withoutScheme.indexOf('/');
          if (slashIdx > 0) {
            targetBucketName = withoutScheme.slice(0, slashIdx);
            objectPath = withoutScheme.slice(slashIdx + 1);
          }
        } catch {}
      }

      const bucket = admin.storage().bucket(targetBucketName);
      const file = bucket.file(objectPath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).send({ error: 'File not found', bucket: targetBucketName, path: objectPath });

      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + minutes * 60 * 1000,
        version: 'v4',
        // Do not set contentType on GET; browsers won't send the header and the signature will fail (400)
        // You can force inline rendering via response-content-disposition
        extensionHeaders: {},
        queryParams: { 'response-content-disposition': 'inline' },
      });

      return res.status(200).send({ url, expiresInMinutes: minutes, bucket: targetBucketName, path: objectPath });
    } catch (e) {
      logger.error('[getSignedPdfUrl] Failed', e);
      return res.status(500).send({ error: String(e?.message || e), hint: 'Check bucket/path correctness and IAM of Functions SA', received: req.body || null });
    }
  });
});


exports.chat = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      initializeClients();
      if (!clientsInitialized) {
        throw new Error("Clients not initialized. Check logs for secret key errors.");
      }

      const { message, namespace } = req.body;
      // Default debug true; allow ?debug=false or body.debug=false/0 to disable
      let debug = true;
      const debugParam = (req.query && typeof req.query.debug !== 'undefined') ? req.query.debug : (req.body ? req.body.debug : undefined);
      if (typeof debugParam !== 'undefined') {
        const v = String(debugParam).toLowerCase();
        if (v === 'false' || v === '0') debug = false;
      }
      if (!message) {
        return res.status(400).send("Bad Request: Missing message field.");
      }

      const ns = (typeof namespace === 'string' && namespace.trim().length > 0) ? namespace.trim() : 'anonymous';

      const intent = detectIntent(message);
      const dateTerms = extractDateTerms(message);
      const detectedCourseCodes = extractCourseCodesFromText(message);
      logger.info(`[Chat] Detected intent: ${intent}`);
      logger.info('[Chat] Namespace:', ns);
      if (dateTerms.length > 0) logger.info('[Chat] Detected date terms:', dateTerms);
      if (detectedCourseCodes.length > 0) logger.info('[Chat] Detected course codes:', detectedCourseCodes);

      // Score threshold to filter spurious results
      const minScore = 0.45;

      let relevantAnnouncements = [];
      let relevantClubs = [];
      let debugInfo = {};

      if (intent === 'clubs') {
        relevantClubs = await searchClubs(message, { minScore, debug });
      } else if (intent === 'announcements') {
        relevantAnnouncements = await queryAnnouncements(message, { minScore, debug, topK: dateTerms.length ? 50 : 10, dateTerms, courseCodes: detectedCourseCodes, namespace: ns });
      } else {
        // both
        [relevantAnnouncements, relevantClubs] = await Promise.all([
          queryAnnouncements(message, { minScore, debug, topK: dateTerms.length ? 50 : 10, dateTerms, courseCodes: detectedCourseCodes, namespace: ns }),
          searchClubs(message, { minScore, debug })
        ]);
      }

      if (debug) {
        debugInfo = { intent, minScore, dateTerms, courseCodes: detectedCourseCodes, namespace: ns };
      }

      const botResponse = await generateComprehensiveResponse(message, relevantAnnouncements, relevantClubs);
      
      res.status(200).send({ 
        response: botResponse, 
        announcements: relevantAnnouncements,
        clubs: relevantClubs,
        ...(debug ? { debug: debugInfo } : {})
      });

    } catch (error) {
      logger.error(`Error in chat function:`, error);
      res.status(500).send("Internal Server Error");
    }
  });
});

// Summarize a topic with textbook context
exports.textbookTopicSummary = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      initializeClients();
      if (!clientsInitialized) throw new Error('Clients not initialized');

      const { topic, namespace, limit, textbookId: forcedTextbookId } = req.body || {};
      if (!topic) return res.status(400).send('Missing topic');

      const ns = (typeof namespace === 'string' && namespace.trim().length > 0) ? namespace.trim() : 'anonymous';

      // Helper: extract explicit section tokens like 1.9, 2.3.1 from topic/title
      function extractSectionTokens(input) {
        const s = String(input || '').toLowerCase();
        const tokens = new Set();
        const re = /(section\s+)?(\d+(?:\.\d+)+)/gi;
        let m;
        while ((m = re.exec(s)) !== null) {
          tokens.add(m[2]);
        }
        return Array.from(tokens);
      }

      // Helper: find relevant segments from textbook documents
      async function findRelevantSegments(topic, forcedTextbookId) {
        const contexts = [];
        const sectionTokens = extractSectionTokens(topic);

        // Query textbooks collection
        let query = admin.firestore().collection('textbooks');
        if (forcedTextbookId) {
          query = query.where('__name__', '==', forcedTextbookId);
        }

        const snapshots = await query.get();
        for (const snap of snapshots.docs) {
          const data = snap.data() || {};
          const storagePath = data.storagePath;
          const segments = data.segments || [];

          // Filter segments by section tokens
          for (const segment of segments) {
            if (sectionTokens.some(token => segment.sectionToken === token)) {
              contexts.push({
                textbookId: snap.id,
                storagePath,
                heading: segment.title,
                pages: `${segment.pageStart}-${segment.pageEnd}`,
                pageStart: segment.pageStart,
                pageEnd: segment.pageEnd,
                sectionToken: segment.sectionToken,
                kind: segment.kind
              });
            }
          }
        }

        return contexts.sort((a, b) => a.pageStart - b.pageStart);
      }

      // 1) Find relevant textbook segments (TOC-based)
      const db = admin.firestore();
      const contexts = await findRelevantSegments(topic, forcedTextbookId);

      // Hydrate contexts with page images by calling the renderer service
      const imageParts = [];
      for (const c of contexts) {
        if (!c.storagePath || !c.pageStart || !c.pageEnd) continue;
        try {
          if (!pdfRendererEndpoint) throw new Error('PDF renderer endpoint is not configured');

          const rendererResponse = await fetch(`${pdfRendererEndpoint}/render-pages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gcsPath: `gs://${STORAGE_BUCKET}/${c.storagePath}`,
              pageStart: c.pageStart,
              pageEnd: c.pageEnd,
            }),
          });

          if (!rendererResponse.ok) {
            const errorBody = await rendererResponse.text();
            throw new Error(`PDF renderer failed with status ${rendererResponse.status}: ${errorBody}`);
          }

          const { images } = await rendererResponse.json();
          if (images && Array.isArray(images)) {
            for (const img of images) {
              imageParts.push({
                inlineData: {
                  mimeType: 'image/png',
                  data: img.base64,
                },
              });
            }
          }
        } catch (e) {
          logger.error(`[textbookTopicSummary] Failed to render PDF pages for textbook ${c.textbookId}`, e);
        }
      }

      // If no segments found, try vector search as fallback (for legacy subchapters)
      if (contexts.length === 0) {
        logger.info('[textbookTopicSummary] No segments found, trying vector search fallback');
        const embeddingResponse = await genAI.getGenerativeModel({ model: 'text-embedding-004' }).embedContent({
          content: { parts: [{ text: String(topic) }] },
          outputDimensionality: 512,
        });
        const queryVector = embeddingResponse.embedding.values;
        const indexNs = mainIndex.namespace(ns);
        const searchResponse = await indexNs.query({
          vector: queryVector,
          topK: Math.min(typeof limit === 'number' && limit > 0 ? limit : 6, 12),
          includeMetadata: true,
          filter: forcedTextbookId ? { type: 'textbook_subchapter_summary', textbookId: forcedTextbookId } : { type: 'textbook_subchapter_summary' },
        });
        const matches = (searchResponse.matches || []).slice(0, 6);
        for (const m of matches) {
          const tid = m.metadata?.textbookId;
          const sid = m.metadata?.subchapterId;
          if (!tid || typeof sid === 'undefined') continue;
          const doc = await db.doc(`textbooks/${tid}/subchapters/${sid}`).get();
          const chunk = doc.exists ? doc.data() : null;
          if (!chunk) continue;
          const parentDoc = await db.doc(`textbooks/${tid}`).get();
          const storagePath = parentDoc.exists ? (parentDoc.data() || {}).storagePath || null : null;
          contexts.push({
            textbookId: tid,
            storagePath,
            heading: chunk.section || chunk.headingPath || 'Unknown',
            pages: chunk.pageStart && chunk.pageEnd ? `${chunk.pageStart}-${chunk.pageEnd}` : null,
            pageStart: chunk.pageStart || null,
            pageEnd: chunk.pageEnd || null,
            summary: chunk.summary || null,
            text: chunk.plainText || null,
          });
        }
      }


      const contextText = contexts.map((c, i) => `Source ${i + 1}${c.heading ? ` (${c.heading})` : ''}${c.pages ? ` [pp. ${c.pages}]` : ''}:
[Page range: ${c.pageStart}-${c.pageEnd}]
Textbook ID: ${c.textbookId}
`).join('\n\n');

      const prompt = `You are a helpful study assistant. Generate a detailed study summary for the topic below using ONLY the provided textbook pages.
The user has provided images of the relevant textbook pages. Your response should be based entirely on the content visible in these images.

Cite sources inline like [S1], [S2] where relevant.
Include:
- Key concepts and definitions from the text
- Theorems/claims with brief statements from the text
- Important formulas in LaTeX as they appear in the text
- 1-2 worked example outlines based on the text

Topic: ${String(topic)}

Reference Information (for citation purposes):
${contextText}

Return markdown without frontmatter.`;
      
      const requestPayload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              ...imageParts,
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 2048,
        },
      };

      const result = await geminiModel.generateContent(requestPayload);
      const text = await result.response.text();
      return res.status(200).send({ summary: text, sources: contexts.map((c, i) => ({ id: i + 1, heading: c.heading, pages: c.pages, pageStart: c.pageStart || null, pageEnd: c.pageEnd || null, textbookId: c.textbookId || null, storagePath: c.storagePath || null })) });
    } catch (e) {
      logger.error('[textbookTopicSummary] Failed', e);
      return res.status(500).send('Internal Server Error');
    }
  });
});

exports.retrieveRelevant = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      initializeClients();
      if (!clientsInitialized) {
        throw new Error("Clients not initialized. Check logs for secret key errors.");
      }

      const { message, limit, namespace, type } = req.body || {};
      // Default debug true; allow ?debug=false or body.debug=false/0 to disable
      let debug = true;
      const debugParam = (req.query && typeof req.query.debug !== 'undefined') ? req.query.debug : (req.body ? req.body.debug : undefined);
      if (typeof debugParam !== 'undefined') {
        const v = String(debugParam).toLowerCase();
        if (v === 'false' || v === '0') debug = false;
      }
      if (!message) {
        return res.status(400).send("Bad Request: Missing message field.");
      }

      const ns = (typeof namespace === 'string' && namespace.trim().length > 0) ? namespace.trim() : 'anonymous';

      // If type==='textbook', prefer textbook_summary vectors
      if (type === 'textbook') {
        const embeddingResponse = await genAI.getGenerativeModel({ model: "text-embedding-004" }).embedContent({
          content: { parts: [{ text: message.replace(/\n/g, ' ') }] },
          outputDimensionality: 512,
        });
        const queryVector = embeddingResponse.embedding.values;
        const indexNs = mainIndex.namespace(ns);
        const searchResponse = await indexNs.query({
          vector: queryVector,
          topK: Math.min(typeof limit === 'number' && limit > 0 ? limit : 12, 25),
          includeMetadata: true,
          filter: { type: 'textbook_subchapter_summary' }
        });

        const matches = (searchResponse.matches || []).map(m => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata || {},
        }));

        // Hydrate with Firestore plainText/summary
        const db = admin.firestore();
        const results = [];
        for (const m of matches) {
          const textbookId = m.metadata?.textbookId;
          const subchapterId = m.metadata?.subchapterId;
          if (!textbookId || typeof subchapterId === 'undefined') continue;
          const subDoc = await db.doc(`textbooks/${textbookId}/subchapters/${subchapterId}`).get();
          const chunk = subDoc.exists ? subDoc.data() : null;
          const parentDoc = await db.doc(`textbooks/${textbookId}`).get();
          const parent = parentDoc.exists ? parentDoc.data() : {};
          results.push({
            id: m.id,
            score: m.score,
            textbookId,
            subchapterId,
            headingPath: m.metadata?.headingPath || null,
            pageStart: m.metadata?.pageStart || null,
            pageEnd: m.metadata?.pageEnd || null,
            hasMath: m.metadata?.hasMath || false,
            mathDensity: m.metadata?.mathDensity || 0,
            summary: chunk?.summary || null,
            plainText: chunk?.plainText || null,
            storagePath: parent?.storagePath || null,
          });
        }

        return res.status(200).send({ textbook: results });
      }

      const dateTerms = extractDateTerms(message);
      const courseCodes = extractCourseCodesFromText(message);
      const variants = buildAnnouncementQueryVariants(message, dateTerms, courseCodes);

      const minScore = 0.45; // recall-friendly baseline
      const topKPerVariant = 25; // recall-first

      if (debug) {
        logger.info('[RetrieveRelevant] Variants', variants);
        logger.info('[RetrieveRelevant] dateTerms/courseCodes', { dateTerms, courseCodes });
        logger.info('[RetrieveRelevant] Namespace', ns);
      }

      const allResults = [];
      for (const v of variants) {
        const r = await queryAnnouncements(v, {
          minScore,
          debug,
          topK: topKPerVariant,
          dateTerms,
          courseCodes,
          namespace: ns,
        });
        allResults.push(r);
      }

      let merged = unionMatchesById(allResults);
      merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const finalLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 100;
      merged = merged.slice(0, finalLimit);

      return res.status(200).send({
        announcements: merged,
        ...(debug ? { debug: { variants, dateTerms, courseCodes, namespace: ns, minScore, topKPerVariant } } : {})
      });
    } catch (error) {
      logger.error('Error in retrieveRelevant:', error);
      res.status(500).send('Internal Server Error');
    }
  });
});

// Dining hall menu endpoint (mirrors former Express /api/menu)
exports.menu = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Max-Age', '3600');
        return res.status(204).send('');
      }

      // Always set CORS header on actual response
      res.set('Access-Control-Allow-Origin', '*');
      // Support both GET (query) and POST (body)
      let diningHall, date;
      if (req.method === 'GET') {
        diningHall = req.query && req.query.diningHall;
        date = req.query && req.query.date;
      } else if (req.method === 'POST') {
        const body = req.body || {};
        diningHall = body.diningHall;
        date = body.date;
      } else {
        return res.status(405).send('Method Not Allowed');
      }
      if (!diningHall) {
        return res.status(400).send({ error: 'Dining hall is required' });
      }

      const diningHallMap = {
        'Buckley': DiningHallType.BUCKLEY,
        'McMahon': DiningHallType.MCMAHON,
        'North': DiningHallType.NORTH,
        'Northwest': DiningHallType.NORTHWEST,
        'Putnam': DiningHallType.PUTNAM,
        'South': DiningHallType.SOUTH,
        'Towers': DiningHallType.TOWERS,
        'Whitney': DiningHallType.WHITNEY,
      };

      const hall = diningHallMap[diningHall];
      if (hall === undefined) {
        return res.status(400).send({ error: `Invalid dining hall name. Please use one of: ${Object.keys(diningHallMap).join(', ')}` });
      }

      const when = date ? new Date(date) : new Date();
      const menu = await getMenu(hall, when);
      return res.status(200).send(menu);
    } catch (error) {
      logger.error('[Functions][menu] Error fetching menu:', error);
      return res.status(500).send({ error: 'An error occurred while fetching the menu.' });
    }
  });
});

// Dining hall hours endpoint (mirrors former Express /api/hours/:diningHall)
exports.hours = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.set('Access-Control-Max-Age', '3600');
        return res.status(204).send('');
      }

      // Always set CORS header on actual response
      res.set('Access-Control-Allow-Origin', '*');

      if (req.method !== 'GET') {
        return res.status(405).send('Method Not Allowed');
      }

      // Support both: /hours?diningHall=South and /hours/South
      let diningHall = (req.query && req.query.diningHall) ? String(req.query.diningHall) : '';
      if (!diningHall) {
        const rawPath = (req.originalUrl || req.url || req.path || '')?.split('?')[0] || '';
        // Try to match /hours/South
        const match = rawPath.match(/\/hours\/([^\/?#]+)/i);
        if (match && match[1]) {
          diningHall = decodeURIComponent(match[1]);
        }
      }
      if (!diningHall) {
        return res.status(400).send({ error: 'Dining hall is required' });
      }

      const diningHallKey = diningHall.toUpperCase();
      if (DiningHallHours[diningHallKey]) {
        const hours = DiningHallHours[diningHallKey];
        return res.status(200).send(hours);
      } else {
        return res.status(404).send({ error: 'Dining hall not found' });
      }
    } catch (error) {
      logger.error('[Functions][hours] Error fetching hours:', error);
      return res.status(500).send({ error: 'An error occurred while fetching hours.' });
    }
  });
});

// --- Background summarization: Enqueue subchapters for a given textbook (HTTP) ---
exports.enqueueSubchapters = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .region('us-central1')
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      try {
        initializeClients();
        if (!clientsInitialized) throw new Error('Clients not initialized');

        const { docId } = req.body || req.query || {};
        if (!docId || typeof docId !== 'string') return res.status(400).send('Missing docId');

        const db = admin.firestore();
        const snap = await db.doc(`textbooks/${docId}`).get();
        if (!snap.exists) return res.status(404).send('textbook not found');
        const data = snap.data() || {};
        const { storagePath } = data;
        if (!storagePath) return res.status(400).send('textbook missing storagePath');

        await db.doc(`textbooks/${docId}`).update({ ingestStage: 'segment_toc_http' });

        // Download + extract per-page (same as main function)
        const bucket = storage.bucket();
        const tempFilePath = `/tmp/${docId}.pdf`;
        await bucket.file(storagePath).download({ destination: tempFilePath });
        const fs = require('fs');
        const buffer = fs.readFileSync(tempFilePath);
        const perPage = [];
        await pdf(buffer, {
          pagerender: (pageData) => pageData.getTextContent().then(tc => {
            const s = (tc.items || []).map(i => i.str).join('\n');
            perPage.push(s);
            return s;
          })
        });

        // Always use LLM consensus TOC segmentation for HTTP endpoint
        const firstPagesText = (perPage.slice(0, 20) || []).join('\n\n');
        const consensus = await llmParseToc(firstPagesText);
        if (consensus.length === 0) return res.status(500).send('TOC consensus failed');
        // Build segments array
        const totalPages = perPage.length;
        const segments = consensus.map((e, idx) => ({
          sectionToken: e.token,
          title: e.title,
          pageStart: e.page,
          pageEnd: Math.min(totalPages, (consensus[idx+1]?.page || (totalPages+1)) - 1),
          kind: 'section',
        }));
        await db.doc(`textbooks/${docId}`).set({ segments, segmentedBy: 'toc', segmentCount: segments.length }, { merge: true });
        return res.status(200).send({ segments, segmentedBy: 'toc' });
      } catch (e) {
        logger.error('[enqueueSubchapters] Failed', e);
        return res.status(500).send('Internal Server Error');
      }
    });
  });

// End of file