// huskybot-app/extension/background.js
console.log("[BG] Combined script loaded. Version 1.9");

// --- IndexedDB Logic (from idb.js) ---
const DB_NAME = 'HuskyBotDB';
const DB_VERSION = 4; // bump to adjust index uniqueness safely
const ANNOUNCEMENTS_STORE_NAME = 'announcements';
const MATERIALS_STORE_NAME = 'courseMaterials';
let db;
let openPromise = null;
let nextDownloadMetadata = null; // holds { title, courseName } between PREPARE_DOWNLOAD and downloads.onCreated

function openDB() {
  if (db) return Promise.resolve(db);
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => { console.error("[IDB] DB error", e.target.error); openPromise = null; reject("DB error"); };
    request.onblocked = () => { console.warn('[IDB] Version change blocked. Close other tabs using the database.'); };
    request.onsuccess = (e) => { db = request.result; console.log("[IDB] DB opened"); openPromise = null; resolve(db); };
    request.onupgradeneeded = (e) => {
      const dbInstance = e.target.result;
      let annStore;
      if (!dbInstance.objectStoreNames.contains(ANNOUNCEMENTS_STORE_NAME)) {
        annStore = dbInstance.createObjectStore(ANNOUNCEMENTS_STORE_NAME, { autoIncrement: true });
        console.log("[IDB] Object store created:", ANNOUNCEMENTS_STORE_NAME);
      } else {
        annStore = e.target.transaction.objectStore(ANNOUNCEMENTS_STORE_NAME);
      }
      if (!annStore.indexNames.contains('byCourseTitleDate')) {
        // Non-unique to avoid migration aborts on historical duplicates
        annStore.createIndex('byCourseTitleDate', ['courseName', 'title', 'date'], { unique: false });
        console.log('[IDB] Index created: announcements.byCourseTitleDate');
      }

      let matStore;
      if (!dbInstance.objectStoreNames.contains(MATERIALS_STORE_NAME)) {
        matStore = dbInstance.createObjectStore(MATERIALS_STORE_NAME, { keyPath: 'id', autoIncrement: true });
        console.log("[IDB] Object store created:", MATERIALS_STORE_NAME);
      } else {
        matStore = e.target.transaction.objectStore(MATERIALS_STORE_NAME);
      }
      if (!matStore.indexNames.contains('byCourse')) {
        matStore.createIndex('byCourse', 'courseName', { unique: false });
      }
      if (!matStore.indexNames.contains('byCourseTitle')) {
        // Non-unique; we'll dedup in code
        matStore.createIndex('byCourseTitle', ['courseName', 'title'], { unique: false });
        console.log('[IDB] Index created: courseMaterials.byCourseTitle');
      }
    };
  });
  return openPromise;
}

const BLACKBOARD_URL = "https://northeastern.blackboard.com";
const INDEXING_FUNCTION_URL = "https://us-central1-huskybot-dabab.cloudfunctions.net/indexAnnouncement";

function getNamespace() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(['huskybotUserId'], (result) => {
        const ns = result?.huskybotUserId;
        if (typeof ns === 'string' && ns.trim().length > 0) return resolve(ns.trim());
        resolve('anonymous');
      });
    } catch (e) {
      resolve('anonymous');
    }
  });
}

async function saveAndIndexAnnouncements(announcements) {
  const db = await openDB();
  const namespace = await getNamespace();

  const transaction = db.transaction([ANNOUNCEMENTS_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(ANNOUNCEMENTS_STORE_NAME);
  const idx = store.index('byCourseTitleDate');

  for (const announcement of announcements) {
    const compositeKey = [announcement.courseName, announcement.title, announcement.date];
    const range = IDBKeyRange.only(compositeKey);
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (cursor) {
        console.log('[IDB] Duplicate announcement skipped:', announcement.title);
        return; // duplicate exists
      }
      const addReq = store.add(announcement);
      addReq.onsuccess = (e) => {
        const announcementId = e.target.result;
        console.log(`[IDB] Saved: "${announcement.title.substring(0, 50)}..." with local ID: ${announcementId}`);
        triggerIndexingFunction(announcementId, announcement, namespace);
      };
      addReq.onerror = (e2) => {
        console.error(`[IDB] Save error for "${announcement.title}":`, e2.target.error);
      };
    };
    cursorReq.onerror = (err) => {
      console.error('[IDB] Index cursor failed for announcement:', err.target.error);
    };
  }
}

/**huskybot-index
 * Reads all announcements from the IndexedDB.
 * @returns {Promise<Array>} A promise that resolves with an array of all announcements.
 */
async function getAnnouncements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([ANNOUNCEMENTS_STORE_NAME], 'readonly');
    const store = transaction.objectStore(ANNOUNCEMENTS_STORE_NAME);
    const request = store.getAll();

    request.onsuccess = (e) => { resolve(e.target.result); };
    request.onerror = (e) => { console.error("[IDB] Read error", e.target.error); reject("Read error"); };
  });
}

async function saveCourseMaterials(courseName, materials) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([MATERIALS_STORE_NAME], 'readwrite');
      const store = tx.objectStore(MATERIALS_STORE_NAME);
      const idx = store.index('byCourseTitle');

      let pending = materials?.length || 0;
      if (pending === 0) { resolve(); return; }

      for (const m of materials || []) {
        const title = m.title || 'Untitled';
        const key = [courseName, title];
        const range = IDBKeyRange.only(key);
        const cursorReq = idx.openCursor(range);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const existing = cursor.value;
            const contentChanged = existing.content !== (m.content || existing.content || '');
            const imagesChanged = JSON.stringify(existing.images||[]) !== JSON.stringify(m.images||existing.images||[]);
            const fileChanged = !!m.file && JSON.stringify(existing.file || null) !== JSON.stringify(m.file);
            const needsUpdate = contentChanged || imagesChanged || fileChanged;
            if (needsUpdate) {
              const updated = {
                ...existing,
                content: (m.content !== undefined ? m.content : existing.content) || '',
                images: (m.images !== undefined ? m.images : existing.images) || [],
                ...(m.file ? { file: m.file } : existing.file ? { file: existing.file } : {})
              };
              const putReq = store.put(updated);
              putReq.onsuccess = () => { if (--pending === 0) resolve(); };
              putReq.onerror = (e) => { console.error('[IDB] Update material failed', e.target.error); if (--pending === 0) resolve(); };
            } else {
              if (--pending === 0) resolve();
            }
          } else {
            const addReq = store.add({
              courseName,
              title,
              content: m.content || '',
              images: m.images || [],
              ...(m.file ? { file: m.file } : {})
            });
            addReq.onsuccess = () => { if (--pending === 0) resolve(); };
            addReq.onerror = (e) => { console.error('[IDB] Add material failed', e.target.error); if (--pending === 0) resolve(); };
          }
        };
        cursorReq.onerror = (e) => { console.error('[IDB] Index cursor failed', e.target.error); if (--pending === 0) resolve(); };
      }

      tx.onerror = (e) => { console.error('[IDB] TX error saveCourseMaterials', e.target.error); };
    } catch (e) {
      reject(e);
    }
  });
}

async function getCourseMaterials(courseName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([MATERIALS_STORE_NAME], 'readonly');
      const store = tx.objectStore(MATERIALS_STORE_NAME);
      if (courseName) {
        const idx = store.index('byCourse');
        const range = IDBKeyRange.only(courseName);
        const req = idx.getAll(range);
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror = (e) => reject(e.target.error);
      } else {
        const req = store.getAll();
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror = (e) => reject(e.target.error);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function getMaterialById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([MATERIALS_STORE_NAME], 'readonly');
      const store = tx.objectStore(MATERIALS_STORE_NAME);
      const req = store.get(Number(id));
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror = (e) => reject(e.target.error);
    } catch (e) { reject(e); }
  });
}

/**
 * Triggers the Firebase Cloud Function to summarize, embed, and index the content.
 * @param {number} announcementId - The local ID of the announcement.
 * @param {object} announcement - The full announcement object { courseName, title, date, content }.
 * @param {string} namespace - The namespace (userId) for per-user indexing.
 */
function triggerIndexingFunction(announcementId, announcement, namespace) {
  // We need to get the function URL. For now, it's a placeholder.
  if (!INDEXING_FUNCTION_URL || INDEXING_FUNCTION_URL.includes("YOUR_FIREBASE_FUNCTION_URL")) {
    console.warn("[BG] Firebase Function URL is not set correctly. Skipping indexing.");
    return;
  }

  console.log(`[BG] Triggering indexing for announcement ID: ${announcementId} in namespace: ${namespace}`);
  
  // Send the structured data to the Firebase Function
  fetch(INDEXING_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      announcementId: announcementId, // The local DB key
      namespace,
      ...announcement // Spread the rest of the fields: courseName, title, date, content
    })
  })
  .then(response => {
    console.log(`[BG] Indexing function response for ID ${announcementId}:`, response);
  })
  .catch(error => {
    console.error(`[BG] Error calling indexing function for ID ${announcementId}:`, error);
  });
}

async function getAnnouncementByIdbKey(idbKey) {
  const dbInstance = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = dbInstance.transaction([ANNOUNCEMENTS_STORE_NAME], 'readonly');
      const store = tx.objectStore(ANNOUNCEMENTS_STORE_NAME);
      const req = store.get(Number(idbKey));
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror = (e) => reject(e.target.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function findAnnouncementByFields({ courseName, title, date }) {
  const dbInstance = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = dbInstance.transaction([ANNOUNCEMENTS_STORE_NAME], 'readonly');
      const store = tx.objectStore(ANNOUNCEMENTS_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = (e) => {
        const all = e.target.result || [];
        // Try strict match first
        let match = all.find(a => (
          (!courseName || a.courseName === courseName) &&
          (!title || a.title === title) &&
          (!date || a.date === date)
        ));
        // Relax matching if needed
        if (!match && title) {
          match = all.find(a => a.title === title);
        }
        resolve(match || null);
      };
      req.onerror = (e) => reject(e.target.error);
    } catch (e) {
      reject(e);
    }
  });
}

// --- Action & Message Logic ---
// Note: chrome.action.onClicked is no longer used when a popup is active.
// Logic is now triggered by messages from popup.js

async function scrapeUrlInNewTab(url, title) {
  return new Promise((resolve) => {
    try {
      console.log('[BG] Opening visible tab to scrape:', title, url);
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (!tab || !tab.id) {
          console.warn('[BG] Failed to create tab for', url);
          resolve(null);
          return;
        }
        const tabId = tab.id;

        let timeoutId = null;
        const cleanup = () => {
          try { if (timeoutId) clearTimeout(timeoutId); } catch {}
          try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch {}
          // Do not auto-close the tab; leave it open for user inspection
        };

        const onUpdated = (updatedTabId, changeInfo) => {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === 'complete') {
            chrome.scripting.executeScript({
              target: { tabId },
              world: 'ISOLATED',
              func: async (pageTitle) => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const normalizeText = (s) => (s || '').replace(/\s+/g, ' ').trim();

                // Give the page a few seconds to handle any SPA redirects or initial loading.
                await sleep(3000);

                // 1. Wait patiently for the page to render some text content.
                let contentReady = false;
                let waitCycles = 0;
                console.log('[BG_TAB] Waiting for text content to appear...');
                while (waitCycles < 80) { // Poll for up to 20 seconds (80 * 250ms)
                    const editor = document.querySelector('.ql-editor');
                    const paragraphs = document.querySelectorAll('p, li');
                    
                    const hasEditorText = editor && editor.innerText.length > 50;
                    const hasSufficientParagraphs = paragraphs.length > 1 && Array.from(paragraphs).some(p => (p.innerText || '').length > 20);

                    if (hasEditorText || hasSufficientParagraphs) {
                        console.log(`[BG_TAB] Content appears ready after ${waitCycles * 250}ms.`);
                        contentReady = true;
                        break;
                    }
                    await sleep(250);
                    waitCycles++;
                }

                if (!contentReady) {
                    console.warn('[BG_TAB] Timed out waiting for text content. Will attempt to scrape anyway.');
                }

                // 2. Directly extract text from common tags including Blackboard/Ultra content containers.
                const selectors = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div.ql-editor', 'div[data-rtf]'];
                const texts = [];
                const elements = document.querySelectorAll(selectors.join(','));
                
                elements.forEach(el => {
                    // This check prevents grabbing container text if it has children we're already grabbing.
                    if (el.querySelector('p, li, h1, h2, h3, h4')) {
                        return;
                    }
                    const text = normalizeText(el.innerText);
                    if (text && text.length > 3) {
                        texts.push(text);
                    }
                });

                // 3. Deduplicate the text to avoid repeated content.
                const uniqueTexts = [...new Set(texts)];
                
                // 4. Filter out irrelevant text from previous pages using the title as an anchor.
                const titleIndex = uniqueTexts.findIndex(t => t.trim().toLowerCase() === pageTitle.trim().toLowerCase());

                let relevantTexts = uniqueTexts;
                if (titleIndex > -1) {
                    console.log(`[BG_TAB] Found title "${pageTitle}" at index ${titleIndex}. Slicing text snippets.`);
                    relevantTexts = uniqueTexts.slice(titleIndex);
                } else {
                    console.warn(`[BG_TAB] Could not find title "${pageTitle}" in extracted text. Returning all snippets.`);
                }

                const content = relevantTexts.join('\n');
                
                // 5. Extract relevant images, including Ally inline previews.
                const imgs = [];
                const resolveToAbs = (src, base) => { try { return new URL(src, base).toString(); } catch { return src; } };
                const pushImg = (raw, alt) => {
                  if (!raw) return;
                  try {
                    const abs = resolveToAbs(raw, location.href);
                    const isBbcs = abs.includes('/bbcswebdav/') || abs.includes('/ally/');
                    const isIcon = abs.endsWith('.svg') || abs.includes('ally-icon');
                    if (isBbcs && !isIcon && !imgs.some(i => i.src === abs)) {
                        imgs.push({ src: abs, alt: alt || 'image' });
                    }
                  } catch {}
                };
                document.querySelectorAll('img[src*="bbcswebdav"], [data-ally-file-preview-url*="bbcswebdav"], img[src*="ally"], [data-ally-file-preview-url*="ally"]').forEach(el => {
                    const raw = el.getAttribute('src') || el.getAttribute('data-ally-file-preview-url');
                    pushImg(raw, el.getAttribute('alt'));
                });

                const debug_info = [`Simplified extractor found ${relevantTexts.length} relevant text snippets.`];

                return {
                    content,
                    images: imgs,
                    invalidContent: !content || content.length < 20,
                    debug_info,
                    extractedTexts: relevantTexts
                };
              },
              args: [title]
            }).then((results) => {
              const result = (results && results[0] && results[0].result) || null;
              cleanup();
              resolve(result);
            }).catch((e) => {
              console.warn('[BG] Injection error for', url, e);
              cleanup();
              resolve(null);
            });
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        timeoutId = setTimeout(() => {
          console.warn('[BG] Timed out waiting for tab to be ready:', url);
          cleanup();
          resolve(null);
        }, 30000);
      });
    } catch (e) {
      console.warn('[BG] scrapeUrlInNewTab failed for', url, e);
      resolve(null);
    }
  });
}

let scrapingInitiatorTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCRAPE_PAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (tab && (tab.url.includes('huskyct.uconn.edu') || tab.url.includes('learn.uconn.edu') || tab.url.includes('lms.uconn.edu'))) {
            console.log(`[BG] Received SCRAPE_PAGE. Storing initiator tab ${tab.id} and injecting script into: ${tab.url}`);
            scrapingInitiatorTabId = tab.id; // Store the tab ID
        try {
          if (/\/ultra\/courses\/.+\/outline/.test(tab.url)) {
            console.log('[BG] Detected course outline page. Injecting contentCourseScraper.js');
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentCourseScraper.js'] });
          } else if (tab.url.includes('/announcements')) {
            console.log('[BG] Detected announcements page. Injecting contentScraper.js');
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScraper.js'] });
          } else if (tab.url.includes('/ultra/course')) {
            console.warn('[BG] On course list page. Open a specific course outline then click scrape.');
          } else {
            console.log('[BG] Defaulting to announcements scraper.');
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScraper.js'] });
          }
          sendResponse({ success: true });
        } catch (e) {
          console.error('[BG] Script injection failed:', e);
          sendResponse({ success: false, error: String(e) });
        }
      } else {
        console.error("[BG] Not a valid UConn Blackboard page.");
        sendResponse({ success: false, error: 'Invalid page' });
      }
    });
    return true; // async
    } else if (message.type === 'SCRAPED_DATA') {
    (async () => {
      try {
        console.log("[BG] Received data. Full object:", message.data);
        if (message.data && message.data.announcements && message.data.announcements.length > 0) {
          console.log(`[BG] Processing ${message.data.announcements.length} announcements...`);
          await saveAndIndexAnnouncements(message.data.announcements);
          console.log("[BG] Finished processing announcements.");
          sendResponse({ success: true, processed: message.data.announcements.length });
        } else {
          console.log("[BG] No announcements found in the received data.");
          sendResponse({ success: true, processed: 0 });
        }
      } catch (e) {
        console.error('[BG] Failed to process SCRAPED_DATA:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'SCRAPED_COURSE') {
    (async () => {
      try {
        const { courseName, materials } = message.data || {};
        if (!courseName || !materials) {
          console.warn('[BG] SCRAPED_COURSE missing data');
          sendResponse({ success: false, error: 'Missing courseName/materials' });
          return;
        }
        await saveCourseMaterials(courseName, materials);
        console.log(`[BG] Saved ${materials.length} materials for course ${courseName}.`);
        sendResponse({ success: true, saved: materials.length });
      } catch (e) {
        console.error('[BG] Failed to save course materials:', e);
        sendResponse({ success: false, error: 'DB error' });
      }
    })();
    return true; // async
    } else if (message.type === 'READ_DATA') {
    (async () => {
      console.log("[BG] Received READ_DATA. Reading from DB...");
      const allData = await getAnnouncements();
      console.log(`[BG] Found ${allData.length} announcements in the database.`);
      console.log("[BG] All Saved Data:", allData);
      sendResponse({ success: true, announcements: allData.length });
    })();
    return true; // async
    } else if (message.type === 'READ_MATERIALS') {
    (async () => {
      try {
        const courseName = message.courseName || '';
        const items = await getCourseMaterials(courseName || undefined);
        console.log(`[BG] Read materials${courseName ? ' for '+courseName : ''}: ${items.length}`);
        sendResponse({ success: true, count: items.length, materials: items });
      } catch (e) {
        console.error('[BG] READ_MATERIALS error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'READ_MATERIALS_META') {
    (async () => {
      try {
        const courseName = message.courseName || '';
        const items = await getCourseMaterials(courseName || undefined);
        const meta = (items || []).map(m => ({
          id: m.id,
          title: m.title,
          courseName: m.courseName,
          hasFile: !!(m.file && m.file.data),
          mimeType: m.file?.mimeType || '',
          size: (m.file?.data || '').length,
        }));
        sendResponse({ success: true, count: meta.length, materials: meta });
      } catch (e) {
        console.error('[BG] READ_MATERIALS_META error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'READ_MATERIAL_FILE') {
    (async () => {
      try {
        const id = message.id;
        const item = await getMaterialById(id);
        if (!item || !item.file || !item.file.data) {
          sendResponse({ success: false, error: 'Not found' });
          return;
        }
        // Protect against very large payloads
        if ((item.file.data || '').length > 2000000) {
          sendResponse({ success: false, error: 'Too large for message' });
          return;
        }
        sendResponse({ success: true, file: { mimeType: item.file.mimeType, data: item.file.data } });
      } catch (e) {
        console.error('[BG] READ_MATERIAL_FILE error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'OPEN_MATERIAL_IN_TAB') {
    (async () => {
      try {
        const id = message.id;
        const item = await getMaterialById(id);
        if (!item || !item.file || !item.file.data) {
          sendResponse({ success: false, error: 'Not found' });
          return;
        }
        chrome.tabs.create({ url: item.file.data });
        sendResponse({ success: true });
      } catch (e) {
        console.error('[BG] OPEN_MATERIAL_IN_TAB error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'SCRAPE_URL') {
        (async () => {
          try {
            const { url, title } = message;
            if (!url) { sendResponse({ success: false, error: 'Missing url' }); return; }
            const result = await scrapeUrlInNewTab(url, title || 'Untitled');
            
            // Add direct, detailed logging here for immediate feedback
            if (result) {
                console.log(`%c[BG] scrapeUrlInNewTab for "${title}" finished.`, 'font-weight: bold; color: green;');
                const { content, images, invalidContent, debug_info, extractedTexts } = result;
                const imgCount = (images || []).length;
                console.log(`[BG] Result has content length: ${content?.length}, images: ${imgCount}, invalid: ${invalidContent}`);
                if (debug_info && debug_info.length > 0) {
                    console.log('%c[BG] Background Scraper Path:', 'color: #8A2BE2;', debug_info.join(' -> '));
                }
                if (extractedTexts && extractedTexts.length > 0) {
                    console.log(`%c[BG] Extracted ${extractedTexts.length} text snippets for "${title}":`, 'color: #00A36C;');
                    extractedTexts.forEach((text, i) => {
                        console.log(`  [Snippet ${i + 1}]: ${text}`);
                    });
                }
            } else {
                console.warn(`[BG] scrapeUrlInNewTab for "${title}" returned null.`);
            }

            sendResponse({ success: true, data: result });
          } catch (e) {
            console.error('[BG] SCRAPE_URL failed:', e);
            sendResponse({ success: false, error: String(e) });
          }
        })();
        return true; // async
    } else if (message.type === 'SAVE_MATERIAL') {
    (async () => {
      try {
        const { courseName, material } = message.payload || {};
        if (!courseName || !material || !material.title) {
          sendResponse({ success: false, error: 'Missing courseName/material' });
          return;
        }
        await saveCourseMaterials(courseName, [material]);
        console.log(`[BG] Saved material via content fetch: "${material.title}" to course "${courseName}"`);
        sendResponse({ success: true });
      } catch (e) {
        console.error('[BG] SAVE_MATERIAL failed:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
    } else if (message.type === 'PREPARE_DOWNLOAD') {
        console.log('[BG] Preparing for download (via click):', message.payload);
        nextDownloadMetadata = message.payload;
        sendResponse({success: true});
        return true;
    } else if (message.type === 'DOWNLOAD_FILE') {
        (async () => {
            const { url, title, courseName } = message.payload || {};
            if (!url || !title || !courseName) {
                sendResponse({ success: false, error: 'Missing payload for DOWNLOAD_FILE.' });
                return;
            }
            try {
                console.log(`[BG] Starting direct download for "${title}"`);
                // Cross-origin signed URLs (blackboardcdn) reject credentials; omit them
                const response = await fetch(url, { cache: 'no-store' });
                if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                
                const blob = await response.blob();
                console.log(`[BG] Fetched blob for "${title}". Size: ${blob.size}, Type: ${blob.type}`);

                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64data = reader.result;
                    const material = {
                        title,
                        content: `[DOWNLOADED_FILE]`,
                        file: { mimeType: blob.type, data: base64data }
                    };
                    await saveCourseMaterials(courseName, [material]);
                    console.log(`%c[BG] Saved file "${title}" to course "${courseName}"`, 'font-weight: bold; color: green;');
                    sendResponse({ success: true });
                };
                reader.onerror = () => {
                    sendResponse({ success: false, error: 'FileReader error' });
                };
                reader.readAsDataURL(blob);

            } catch(e) {
                console.error(`[BG] Direct download failed for "${title}":`, e);
                // As a fallback, try to open a tab which will trigger downloads.onCreated, then capture
                try {
                    nextDownloadMetadata = { title, courseName };
                    chrome.tabs.create({ url, active: false });
                } catch {}
                sendResponse({ success: false, error: String(e) });
            }
        })();
        return true;
    } else if (message.type === 'RESTORE_FOCUS_TO_ORIGINAL_TAB') {
        if (scrapingInitiatorTabId) {
            console.log(`[BG] Restoring focus to original tab: ${scrapingInitiatorTabId}`);
            chrome.tabs.update(scrapingInitiatorTabId, { active: true });
            scrapingInitiatorTabId = null; // Reset the ID
        }
        sendResponse({success: true});
        return true;
    } else if (message.type === 'HANDLE_ALLY_DOWNLOAD') {
        (async () => {
            const { iframeUrl, title, courseName } = message.payload || {};
            if (!iframeUrl) {
                sendResponse({ success: false, error: 'Missing iframeUrl for Ally download.' });
                return;
            }
            try {
                console.log(`[BG] Handling Ally download for "${title}". Opening iframe URL in new tab.`);
                // We must prepare the download metadata BEFORE creating the tab that will trigger it.
                nextDownloadMetadata = { title, courseName };
                
                chrome.tabs.create({ url: iframeUrl, active: true }, (tab) => {
                    const tabId = tab.id;
                    const onUpdated = (updatedTabId, changeInfo) => {
                        if (updatedTabId === tabId && changeInfo.status === 'complete') {
                            chrome.tabs.onUpdated.removeListener(onUpdated); // Clean up listener
                            console.log(`[BG] Ally tab ${tabId} loaded. Injecting script to click download.`);
                            chrome.scripting.executeScript({
                                target: { tabId: tabId },
                                func: () => {
                                    const candidates = [
                                      'button.download-button',
                                      'button[aria-label*="download" i]',
                                      'button[data-analytics-id*="download" i]',
                                      'a[download]',
                                      'button.MuiButton-root'
                                    ];
                                    for (const sel of candidates) {
                                      const el = document.querySelector(sel);
                                      if (el) { el.click(); return true; }
                                    }
                                    return false;
                                }
                            }).then((res) => {
                                const ok = res && res[0] && res[0].result;
                                console.log(`[BG] Ally click result: ${ok}`);
                                setTimeout(() => chrome.tabs.remove(tabId), 2500);
                            }).catch((e) => {
                                console.warn('[BG] Ally click injection error:', e);
                                setTimeout(() => chrome.tabs.remove(tabId), 2500);
                            });
                        }
                    };
                    chrome.tabs.onUpdated.addListener(onUpdated);
                });
                sendResponse({ success: true, message: 'Ally download process initiated.' });
            } catch (e) {
                console.error(`[BG] Failed to handle Ally download for "${title}":`, e);
                sendResponse({ success: false, error: String(e) });
            }
        })();
        return true;
    }
    // Return true for any async operations above
});

// Mirror logs coming from the content course scraper into the background console
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'COURSE_LOG') {
    const level = message.level || 'log';
    const parts = Array.isArray(message.args) ? message.args : [String(message.args || '')];
    const prefix = '[CS-Course→BG]';
    try {
      if (level === 'warn') {
        console.warn(prefix, ...parts);
      } else if (level === 'error') {
        console.error(prefix, ...parts);
      } else {
        console.log(prefix, ...parts);
      }
    } catch (e) {
      console.log(prefix, ...parts);
    }
  }
});


chrome.downloads.onCreated.addListener(async (downloadItem) => {
    if (!nextDownloadMetadata) {
        console.log('[BG] Ignoring a download that was not prepared.');
        return;
    }

    console.log('[BG] Download started, using prepared metadata:', nextDownloadMetadata);
    const { title, courseName } = nextDownloadMetadata;
    nextDownloadMetadata = null; // Reset for the next one

    try {
        // Try to intercept without showing a visible download
        try { chrome.downloads.pause(downloadItem.id, () => {}); } catch {}
        try { chrome.downloads.cancel(downloadItem.id, () => { console.log('[BG] Cancelled visible download (intercepting).'); }); } catch {}

        const response = await fetch(downloadItem.url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        
        const blob = await response.blob();
        console.log(`[BG] Fetched blob for "${title}". Size: ${blob.size}, Type: ${blob.type}`);

        const reader = new FileReader();
        reader.onloadend = async () => {
            const base64data = reader.result;
            const material = {
                title,
                content: `[DOWNLOADED_FILE]`,
                file: { mimeType: blob.type, data: base64data }
            };
            await saveCourseMaterials(courseName, [material]);
            console.log(`%c[BG] Saved file "${title}" to course "${courseName}"`, 'font-weight: bold; color: green;');
        };
        reader.readAsDataURL(blob);

    } catch (e) {
        console.error(`[BG] Download processing failed for "${title}":`, e);
        if (nextDownloadMetadata && nextDownloadMetadata.title === title) {
            nextDownloadMetadata = null; // Clear metadata on failure
        }
    }
});


// Listen for messages from the whitelisted frontend website
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log("[BG] Received message from external website:", message);

  if (message.type === 'REQUEST_SAVED_DATA') {
    getAnnouncements().then(data => {
      console.log(`[BG] Sending ${data.length} saved announcements to the frontend.`);
      sendResponse({ success: true, data: data });
    }).catch(error => {
      console.error("[BG] Error retrieving data for frontend:", error);
      sendResponse({ success: false, error: "Failed to retrieve data." });
    });
    // Return true to indicate that the response will be sent asynchronously
    return true;
  }

  if (message.type === 'READ_MATERIALS_META') {
    (async () => {
      try {
        const courseName = message.courseName || '';
        const items = await getCourseMaterials(courseName || undefined);
        const meta = (items || []).map(m => ({
          id: m.id,
          title: m.title,
          courseName: m.courseName,
          hasFile: !!(m.file && m.file.data),
          mimeType: m.file?.mimeType || '',
          size: (m.file?.data || '').length,
        }));
        sendResponse({ success: true, count: meta.length, materials: meta });
      } catch (e) {
        console.error('[BG] READ_MATERIALS_META (external) error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'READ_MATERIAL_FILE') {
    (async () => {
      try {
        const id = message.id;
        const item = await getMaterialById(id);
        if (!item || !item.file || !item.file.data) {
          sendResponse({ success: false, error: 'Not found' });
          return;
        }
        // Limit very large payloads for external messages as well
        if ((item.file.data || '').length > 2000000) {
          sendResponse({ success: false, error: 'Too large for message' });
          return;
        }
        sendResponse({ success: true, file: { mimeType: item.file.mimeType, data: item.file.data } });
      } catch (e) {
        console.error('[BG] READ_MATERIAL_FILE (external) error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_MATERIAL_IN_TAB') {
    (async () => {
      try {
        const id = message.id;
        const item = await getMaterialById(id);
        if (!item || !item.file || !item.file.data) {
          sendResponse({ success: false, error: 'Not found' });
          return;
        }
        chrome.tabs.create({ url: item.file.data });
        sendResponse({ success: true });
      } catch (e) {
        console.error('[BG] OPEN_MATERIAL_IN_TAB (external) error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message.type === 'SET_USER') {
    const userId = typeof message.userId === 'string' ? message.userId.trim() : '';
    if (userId) {
      chrome.storage.sync.set({ huskybotUserId: userId }, () => {
        console.log('[BG] Stored user namespace:', userId);
        sendResponse({ success: true });
      });
      return true; // async response
    } else {
      sendResponse({ success: false, error: 'Invalid userId' });
      return false;
    }
  }

  if (message.type === 'GET_ANNOUNCEMENT') {
    const { idbKey, courseName, title, date } = message;
    (async () => {
      try {
        let item = null;
        if (idbKey != null) {
          item = await getAnnouncementByIdbKey(idbKey);
        }
        if (!item) {
          item = await findAnnouncementByFields({ courseName, title, date });
        }
        sendResponse({ success: true, data: item });
      } catch (e) {
        console.error('[BG] GET_ANNOUNCEMENT error:', e);
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
  }
}); 