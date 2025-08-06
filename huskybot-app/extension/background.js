// huskybot-app/extension/background.js
console.log("[BG] Combined script loaded. Version 1.4");

// --- IndexedDB Logic (from idb.js) ---
const DB_NAME = 'HuskyBotDB';
const DB_VERSION = 1;
const ANNOUNCEMENTS_STORE_NAME = 'announcements';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => { console.error("[IDB] DB error", e.target.error); reject("DB error"); };
    request.onsuccess = (e) => { db = e.target.result; console.log("[IDB] DB opened"); resolve(db); };
    request.onupgradeneeded = (e) => {
      const dbInstance = e.target.result;
      if (!dbInstance.objectStoreNames.contains(ANNOUNCEMENTS_STORE_NAME)) {
        dbInstance.createObjectStore(ANNOUNCEMENTS_STORE_NAME, { autoIncrement: true });
        console.log("[IDB] Object store created.");
      }
    };
  });
}

const BLACKBOARD_URL = "https://northeastern.blackboard.com";
const INDEXING_FUNCTION_URL = "https://us-central1-huskybot-dabab.cloudfunctions.net/indexAnnouncement";

async function saveAndIndexAnnouncements(announcements) {
  const db = await openDB();
  const transaction = db.transaction([ANNOUNCEMENTS_STORE_NAME], 'readwrite');
  const store = transaction.objectStore(ANNOUNCEMENTS_STORE_NAME);

  for (const announcement of announcements) {
    // Each announcement is now { courseName, title, date, content }
    const request = store.add(announcement);
    
    request.onsuccess = (e) => {
      const announcementId = e.target.result;
      console.log(`[IDB] Saved: "${announcement.title.substring(0, 50)}..." with local ID: ${announcementId}`);
      
      // Pass the full structured announcement to the indexing function
      triggerIndexingFunction(announcementId, announcement);
    };
    
    request.onerror = (e) => {
      console.error(`[IDB] Save error for "${announcement.title}":`, e.target.error);
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

/**
 * Triggers the Firebase Cloud Function to summarize, embed, and index the content.
 * @param {number} announcementId - The local ID of the announcement.
 * @param {object} announcement - The full announcement object { courseName, title, date, content }.
 */
function triggerIndexingFunction(announcementId, announcement) {
  // We need to get the function URL. For now, it's a placeholder.
  if (!INDEXING_FUNCTION_URL || INDEXING_FUNCTION_URL.includes("YOUR_FIREBASE_FUNCTION_URL")) {
    console.warn("[BG] Firebase Function URL is not set correctly. Skipping indexing.");
    return;
  }

  console.log(`[BG] Triggering indexing for announcement ID: ${announcementId}`);
  
  // Send the structured data to the Firebase Function
  fetch(INDEXING_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      announcementId: announcementId, // The local DB key
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

// --- Action & Message Logic ---
// Note: chrome.action.onClicked is no longer used when a popup is active.
// Logic is now triggered by messages from popup.js

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "SCRAPE_PAGE") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && (tab.url.includes('huskyct.uconn.edu') || tab.url.includes('learn.uconn.edu'))) {
      console.log(`[BG] Received SCRAPE_PAGE. Injecting script into: ${tab.url}`);
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['contentScraper.js'] });
    } else {
      console.error("[BG] Not a valid UConn Blackboard page.");
    }
  } else if (message.type === "SCRAPED_DATA") {
    console.log("[BG] Received data. Full object:", message.data);
    if (message.data && message.data.announcements && message.data.announcements.length > 0) {
      console.log(`[BG] Processing ${message.data.announcements.length} announcements...`);
      // The announcements are already structured correctly by the content script
      await saveAndIndexAnnouncements(message.data.announcements);
      console.log("[BG] Finished processing announcements.");
    } else {
      console.log("[BG] No announcements found in the received data.");
    }
  } else if (message.type === "READ_DATA") {
    console.log("[BG] Received READ_DATA. Reading from DB...");
    const allData = await getAnnouncements();
    console.log(`[BG] Found ${allData.length} announcements in the database.`);
    console.log("[BG] All Saved Data:", allData);
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
}); 