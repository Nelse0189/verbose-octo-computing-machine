// extension/contentCourseScraper.js
console.log('[CS-Course] Course scraper loaded');
// Mirror content-script logs to background for easier debugging
try {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => {
    try { chrome.runtime.sendMessage({ type: 'COURSE_LOG', level: 'log', args: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)) }); } catch {}
    originalLog(...args);
  };
  console.warn = (...args) => {
    try { chrome.runtime.sendMessage({ type: 'COURSE_LOG', level: 'warn', args: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)) }); } catch {}
    originalWarn(...args);
  };
  console.error = (...args) => {
    try { chrome.runtime.sendMessage({ type: 'COURSE_LOG', level: 'error', args: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)) }); } catch {}
    originalError(...args);
  };
  console.log('[CS-Course] Log mirroring to background enabled');
} catch {}

(async () => {
  const t0 = performance.now();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const stats = { modulesExpanded: 0, foldersExpanded: 0, itemsTotal: 0, itemSuccess: 0, itemFail: 0, imagesTotal: 0 };

  function simulateMouseClick(element) {
      const mouseEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
      });
      element.dispatchEvent(mouseEvent);
  }

  function getCourseName() {
    const header = document.querySelector('h1.js-header-text.js-readonly-header-text');
    return header ? header.textContent.trim() : 'Unknown Course';
  }

  async function expandAllContainers() {
    let totalExpanded = 0;
    for (let pass = 0; pass < 5; pass++) {
      let expanded = 0;
      const moduleButtons = Array.from(document.querySelectorAll('button[id^="learning-module-title-"][aria-expanded="false"]'));
      for (const btn of moduleButtons) {
        try { btn.scrollIntoView({ block: 'center' }); simulateMouseClick(btn); expanded++; stats.modulesExpanded++; await sleep(250); } catch (e) { console.warn('[CS-Course] Module expand failed:', e); }
      }
      const folderButtons = Array.from(document.querySelectorAll([
        'button[id^="folder-title-"][aria-expanded="false"]',
        'button[data-analytics-id="content.item.folder.toggleFolder.button"][aria-expanded="false"]',
        'button[aria-controls^="folder-contents-"][aria-expanded="false"]'
      ].join(',')));
      for (const btn of folderButtons) {
        try { btn.scrollIntoView({ block: 'center' }); simulateMouseClick(btn); expanded++; stats.foldersExpanded++; await sleep(250); } catch (e) { console.warn('[CS-Course] Folder expand failed:', e); }
      }
      totalExpanded += expanded;
      if (expanded === 0) break;
      await sleep(350);
    }
    console.log(`[CS-Course] Expand summary: modules=${stats.modulesExpanded}, folders=${stats.foldersExpanded}, totalClicks=${totalExpanded}`);
  }

  async function loadAllLazyContent() {
    try {
      let lastOverflowCount = -1;
      let lastAllyCount = -1;
      let lastScrollHeight = -1;
      let stablePasses = 0;
      const maxPasses = 60; // ~90 seconds at 1.5s each
      function getScrollableContainers() {
        try {
          const nodes = Array.from(document.querySelectorAll('main, [role="main"], div, section, article'));
          return nodes.filter(n => {
            try {
              const style = window.getComputedStyle(n);
              if (!style) return false;
              const canScroll = (n.scrollHeight - n.clientHeight) > 80;
              const overflowY = style.overflowY;
              return canScroll && (overflowY === 'auto' || overflowY === 'scroll');
            } catch { return false; }
          });
        } catch { return []; }
      }
      for (let pass = 0; pass < maxPasses; pass++) {
        const overflowCount = document.querySelectorAll('button[id^="content-item-overflow-menu-button-"]').length;
        const allyCount = document.querySelectorAll('button[data-ally-invoke="alternativeformats"]').length;
        const scrollHeight = document.body.scrollHeight;
        console.log(`[CS-Course] LazyLoad pass ${pass}: overflow=${overflowCount}, ally=${allyCount}, scrollH=${scrollHeight}, stable=${stablePasses}`);

        // Scroll window and all scrollable containers to bottom to trigger intersection observers
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
        try {
          const containers = getScrollableContainers();
          for (const c of containers) { c.scrollTop = c.scrollHeight; }
        } catch {}
        await sleep(1500);

        const noNewOverflow = overflowCount === lastOverflowCount;
        const noNewAlly = allyCount === lastAllyCount;
        const noNewHeight = scrollHeight === lastScrollHeight;
        if (noNewOverflow && noNewAlly && noNewHeight) {
          stablePasses++;
        } else {
          stablePasses = 0;
        }
        if (stablePasses >= 5) {
          console.log('[CS-Course] LazyLoad stabilized after multiple passes; stopping scroll');
          break;
        }
        lastOverflowCount = overflowCount;
        lastAllyCount = allyCount;
        lastScrollHeight = scrollHeight;
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(400);
    } catch (e) { console.warn('[CS-Course] loadAllLazyContent failed', e); }
  }

  async function scrapeMaterials() {
    await expandAllContainers();
    await loadAllLazyContent();

    // Broader selector diagnostics to understand page structure
    const selectorDiagnostics = {
      'div[data-item-id]': document.querySelectorAll('div[data-item-id]').length,
      'article[role="listitem"]': document.querySelectorAll('article[role="listitem"]').length,
      'li[role="listitem"]': document.querySelectorAll('li[role="listitem"]').length,
      'a[href*="/bbcswebdav/"]': document.querySelectorAll('a[href*="/bbcswebdav/"]').length,
      'button[id^="content-item-overflow-menu-button-"]': document.querySelectorAll('button[id^="content-item-overflow-menu-button-"]').length,
      'button[data-ally-invoke="alternativeformats"]': document.querySelectorAll('button[data-ally-invoke="alternativeformats"]').length,
      'a[data-analytics-id*="content.item"]': document.querySelectorAll('a[data-analytics-id*="content.item"]').length
    };
    console.log('[CS-Course] Selector counts:', selectorDiagnostics);

    // Use a broader set of containers for items (some courses have no folders/modules)
    const itemCandidates = Array.from(new Set([
      ...Array.from(document.querySelectorAll('div[data-item-id]')),
      ...Array.from(document.querySelectorAll('article[role="listitem"]')),
      ...Array.from(document.querySelectorAll('li[role="listitem"]'))
    ]));
    const items = itemCandidates;
    console.log(`[CS-Course] Found ${items.length} content items after expansion`);
    items.slice(0, 15).forEach((item, idx) => {
      try {
        const link = item.querySelector('a[href]');
        const hasOverflow = !!item.querySelector('button[id^="content-item-overflow-menu-button-"]');
        const hasAlly = !!item.querySelector('button[data-ally-invoke="alternativeformats"]');
        const textSample = (item.textContent || '').trim().slice(0, 120).replace(/\s+/g, ' ');
        console.log(`[CS-Course] Item#${idx + 1}: hasLink=${!!link}, hasOverflow=${hasOverflow}, hasAlly=${hasAlly}, textSample="${textSample}"`);
      } catch (e) { console.warn('[CS-Course] Failed to log item details', e); }
    });

    const linkSet = new Map();
    for (const item of items) {
      let link = item.querySelector('a[data-analytics-id*="content.item.course.outline.document.link"]');
      if (!link) link = item.querySelector('a[data-analytics-id*="link"]');
      if (!link) link = item.querySelector('a[href]');
      const title = (link?.textContent || item.textContent || 'Untitled Item').trim();
      const href = link?.href;
      if (href) {
        console.log(`[CS-Course] Collected link: title="${title}", href=${href}`);
        linkSet.set(href, { title, href });
      } else {
        console.log(`[CS-Course] Skipped item without href: title="${title}"`);
      }
    }

    // Re-enable opening document pages (for scraping in-page text) with robust selectors
    const docLinkSelectors = [
      'a[data-analytics-id="content.item.course.outline.courseContent.link"]',
      'a[data-analytics-id*="courseContent.link"]',
      'a[href*="/outline/file/"]',
      'a[href*="/outline/document/"]'
    ];
    const docLinks = Array.from(document.querySelectorAll(docLinkSelectors.join(',')));
    console.log(`[CS-Course] Document links detected (pre-filter): ${docLinks.length}`);
    for (const a of docLinks) {
      try {
        const href = a.href;
        // Skip Ally preview-only anchors and direct bbcswebdav previews
        if (!href || href.includes('/bbcswebdav/')) continue;
        const title = (a.textContent || a.getAttribute('aria-label') || 'Untitled Item').trim();
        if (!linkSet.has(href)) {
          console.log(`[CS-Course] Added document link: title="${title}", href=${href}`);
          linkSet.set(href, { title, href });
        }
      } catch (e) { console.warn('[CS-Course] Failed to process a document link', e); }
    }

    console.log(`[CS-Course] Total unique links to scrape: ${linkSet.size}`);
    if (linkSet.size > 0) {
      let idx = 1;
      for (const { title, href } of linkSet.values()) {
        console.log(`[CS-Course] Link#${idx++}: title="${title}", href=${href}`);
      }
    }

    const materials = [];
    for (const { title, href } of linkSet.values()) {
      try {
        console.log('[CS-Course] Requesting background tab scrape for:', { title, href });
        const page = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'SCRAPE_URL', url: href, title }, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) {
              console.warn('[CS-Course] SCRAPE_URL lastError:', err.message);
              resolve(null);
            } else {
              resolve(resp && resp.success ? (resp.data || null) : null);
            }
          });
        });

        if (page && (page.content || (page.images && page.images.length > 0))) {
          console.log(`[CS-Course] Received scraped data for "${title}" from background. contentLen=${(page.content||'').length}, images=${(page.images||[]).length}`);
          materials.push({ title, content: page.content || '', images: page.images || [] });
          stats.itemSuccess++;
          stats.imagesTotal += (page.images || []).length;
        } else {
          console.warn(`[CS-Course] Background scrape failed or returned empty for "${title}". Fallback to URL only.`);
          materials.push({ title, content: `URL: ${href}`, images: [] });
          stats.itemFail++; 
        }
      } catch (e) {
        stats.itemFail++;
        console.warn('[CS-Course] Item scrape failed', e);
      }
    }

    // --- Restore Focus before Downloads ---
    console.log('[CS-Course] Finished scraping text materials. Restoring focus to main tab before downloads.');
    chrome.runtime.sendMessage({ type: 'RESTORE_FOCUS_TO_ORIGINAL_TAB' });
    await sleep(1000); // Give a second for the tab to become active

    // --- Downloadable Files Logic (Prioritized) ---
    const downloadableItems = document.querySelectorAll('div[data-item-id]');
    console.log(`[CS-Course] Found ${downloadableItems.length} items to check for downloads.`);

    function getBestTitleFromItem(item) {
      try {
        const overflow = item.querySelector('button[id^="content-item-overflow-menu-button-"]');
        const overflowLabel = overflow?.getAttribute('aria-label') || overflow?.getAttribute('title') || '';
        if (overflowLabel) return overflowLabel.replace('More options for', '').trim();
        const anchor = item.querySelector('a[data-analytics-id*="courseContent.link"], a');
        const anchorText = (anchor?.textContent || '').trim();
        if (anchorText) return anchorText;
      } catch {}
      return 'Untitled File';
    }

    for (const item of downloadableItems) {
        try {
            const moreOptionsMenu = item.querySelector('button[id^="content-item-overflow-menu-button-"]');
            const allyButton = item.querySelector('button[data-ally-invoke="alternativeformats"]');
            const linkElement = item.querySelector('a[href*="/bbcswebdav/"]');
            const allyHiddenAnchor = item.querySelector('a[data-ally-file-preview-url*="/bbcswebdav/"]');
            const allyHiddenUrl = allyHiddenAnchor ? allyHiddenAnchor.getAttribute('data-ally-file-preview-url') : '';
            const titleProbe = getBestTitleFromItem(item).slice(0, 100);
            console.log(`[CS-Course] Download check: hasOverflow=${!!moreOptionsMenu}, hasAlly=${!!allyButton}, hasDirectFile=${!!linkElement}, hasHiddenAlly=${!!allyHiddenUrl}, titleProbe="${titleProbe}"`);

            if (moreOptionsMenu) {
                // Priority 1: Handle PDF downloads (direct link or click)
                const title = getBestTitleFromItem(item);

                if (linkElement && linkElement.href) {
                    console.log(`[CS-Course] Prioritizing direct PDF link for "${title}".`);
                    chrome.runtime.sendMessage({
                        type: 'DOWNLOAD_FILE',
                        payload: { url: linkElement.href, title, courseName: getCourseName() }
                    });
                } else if (allyHiddenUrl) {
                    console.log(`[CS-Course] Using hidden Ally preview URL for "${title}": ${allyHiddenUrl}`);
                    chrome.runtime.sendMessage({
                        type: 'DOWNLOAD_FILE',
                        payload: { url: allyHiddenUrl, title, courseName: getCourseName() }
                    });
                } else {
                    console.log(`[CS-Course] Prioritizing click-based PDF download for "${title}".`);
                    chrome.runtime.sendMessage({ type: 'PREPARE_DOWNLOAD', payload: { title, courseName: getCourseName() } });
                    await sleep(100);
                    // Robust click sequence
                    try { moreOptionsMenu.focus(); } catch {}
                    moreOptionsMenu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                    moreOptionsMenu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    simulateMouseClick(moreOptionsMenu);
                    moreOptionsMenu.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    await sleep(500);
                    let downloadMenuItem = document.querySelector('li[data-analytics-id*="components.directives.content-item-base.overflowMenu.global.download.link"]');
                    if (!downloadMenuItem) downloadMenuItem = document.querySelector('li[data-analytics-id*="download.link"]');
                    console.log(`[CS-Course] Clicked overflow. downloadMenuItemFound=${!!downloadMenuItem}`);
                    if (downloadMenuItem) {
                      downloadMenuItem.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                      downloadMenuItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                      simulateMouseClick(downloadMenuItem);
                      downloadMenuItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    }
                    await sleep(500);
                    if (moreOptionsMenu.getAttribute('aria-expanded') === 'true') simulateMouseClick(moreOptionsMenu);
                }
            } else if (allyButton) {
                // Ally modal path disabled to avoid unreliable popup/tab flow
                console.log('[CS-Course] Ally fallback disabled; skipping Ally modal path.');
            } else {
                console.log('[CS-Course] Item has no overflow or Ally controls; skipping download handling.');
            }
            await sleep(300); // Small delay between processing items
        } catch (e) {
            console.warn('[CS-Course] Failed to process a downloadable item.', e);
        }
    }

    // Fallback: some classes may not use folders/items; scan page-level direct file links
    // Disabled page-level direct bbcswebdav link scanning; primary path is overflow/Ally clicks
    console.log('[CS-Course] Page-level bbcswebdav scanning disabled.');

    // Global fallback: click any visible overflow menu buttons and choose Download Original File
    try {
        await loadAllLazyContent();
        const overflowButtons = Array.from(document.querySelectorAll('button[id^="content-item-overflow-menu-button-"]'));
        console.log(`[CS-Course] Global overflow menu buttons detected: ${overflowButtons.length}`);
        for (const moreOptionsMenu of overflowButtons) {
            try {
                const rawLabel = moreOptionsMenu.getAttribute('aria-label') || moreOptionsMenu.getAttribute('title') || '';
                let title = rawLabel.replace('More options for', '').trim();
                if (!title) {
                  const container = moreOptionsMenu.closest('[data-item-id]') || document;
                  const a = container.querySelector('a[data-analytics-id*="courseContent.link"], a');
                  title = (a?.textContent || '').trim() || 'Untitled File';
                }
                console.log(`[CS-Course] Fallback overflow path for: "${title}"`);
                chrome.runtime.sendMessage({ type: 'PREPARE_DOWNLOAD', payload: { title, courseName: getCourseName() } });
                await sleep(120);
                try { moreOptionsMenu.scrollIntoView({ block: 'center' }); } catch {}
                try { moreOptionsMenu.focus(); } catch {}
                moreOptionsMenu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                moreOptionsMenu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                simulateMouseClick(moreOptionsMenu);
                moreOptionsMenu.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                await sleep(600);
                let downloadMenuItem = document.querySelector('li[data-analytics-id*="components.directives.content-item-base.overflowMenu.global.download.link"]');
                if (!downloadMenuItem) downloadMenuItem = document.querySelector('li[data-analytics-id*="download.link"]');
                console.log(`[CS-Course] Fallback download menu item found=${!!downloadMenuItem}`);
                if (downloadMenuItem) {
                    try { downloadMenuItem.scrollIntoView({ block: 'center' }); } catch {}
                    downloadMenuItem.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
                    downloadMenuItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    simulateMouseClick(downloadMenuItem);
                    downloadMenuItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    await sleep(800);
                }
                if (moreOptionsMenu.getAttribute('aria-expanded') === 'true') simulateMouseClick(moreOptionsMenu);
                await sleep(250);
            } catch (e) {
                console.warn('[CS-Course] Fallback overflow path failed for one item', e);
            }
        }
    } catch (e) {
        console.warn('[CS-Course] Global overflow fallback failed', e);
    }

    // Global Ally fallback disabled
    console.log('[CS-Course] Global Ally fallback disabled.');

    // Global hidden-link direct save (no popups): scan Ally preview and bbcswebdav anchors
    try {
      await loadAllLazyContent();
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll('a[data-ally-file-preview-url*="bbcswebdav"], a[href*="/bbcswebdav/"]'));
      console.log(`[CS-Course] Hidden/file anchors detected: ${anchors.length}`);
      for (const a of anchors) {
        try {
          const url = a.getAttribute('data-ally-file-preview-url') || a.href;
          if (!url || seen.has(url)) continue;
          seen.add(url);
          // Best-effort title resolution from nearby context
          let title = (a.textContent || a.getAttribute('aria-label') || '').trim();
          if (!title) {
            const container = a.closest('[data-item-id]') || a.closest('li, article, div') || document;
            const tAnchor = container.querySelector('a[data-analytics-id*="courseContent.link"], a');
            title = (tAnchor?.textContent || '').trim() || 'File';
          }
          console.log(`[CS-Course] Sending hidden Ally URL for save: title="${title}", url=${url}`);
          // Try to fetch the file directly from the content script with cookies, then send the base64 to background
          try {
            // For signed blackboardcdn redirects, omit credentials to avoid CORS preflight failures
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) {
              const blob = await res.blob();
              const reader = new FileReader();
              const b64 = await new Promise(r => { reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
              chrome.runtime.sendMessage({ type: 'SAVE_MATERIAL', payload: { courseName: getCourseName(), material: { title, content: '[DOWNLOADED_FILE]', file: { mimeType: blob.type, data: b64 } } } });
              await sleep(100);
              continue;
            }
          } catch {}
          // Fallback: ask background to fetch and save
          chrome.runtime.sendMessage({ type: 'DOWNLOAD_FILE', payload: { url, title, courseName: getCourseName() } });
          await sleep(120);
        } catch (e) { console.warn('[CS-Course] Hidden/file anchor process failed for one link', e); }
      }
    } catch (e) { console.warn('[CS-Course] Global hidden-link save failed', e); }

    stats.itemsTotal = linkSet.size;
    console.log(`[CS-Course] Materials scrape summary: total=${stats.itemsTotal}, ok=${stats.itemSuccess}, fail=${stats.itemFail}, images=${stats.imagesTotal}`);
    return materials;
  }

  async function scrapeAnnouncementsFromLink() {
    const annLink = document.querySelector('a[data-analytics-id="course.announcements.link"]');
    if (!annLink || !annLink.href) return [];
    try {
      const res = await fetch(annLink.href, { credentials: 'include' });
      if (!res.ok) { console.warn('[CS-Course] announcements fetch non-OK', res.status); return [];
      }
      const html = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const titles = Array.from(doc.querySelectorAll('a.list-item-title'));
      const dates = Array.from(doc.querySelectorAll('span.list-item-date-sent'));
      const bodies = Array.from(doc.querySelectorAll('p.list-item-body'));
      const count = Math.min(titles.length, dates.length, bodies.length);
      const anns = [];
      for (let i = 0; i < count; i++) {
        try {
          const title = titles[i].textContent.trim();
          const date = dates[i].textContent.trim();
          const content = bodies[i].innerHTML.trim();
          if (title && content) anns.push({ title, date, content });
        } catch (e) { console.warn('[CS-Course] Announcement parse fail at index', i, e); }
      }
      console.log(`[CS-Course] Parsed ${anns.length}/${count} announcements from list page`);
      return anns;
    } catch (e) { console.warn('[CS-Course] scrapeAnnouncementsFromLink failed', e); return []; }
  }

  try {
    const courseName = getCourseName();
    console.log('[CS-Course] Scraping course:', courseName);
    const materials = await scrapeMaterials();
    const announcements = await scrapeAnnouncementsFromLink();

    chrome.runtime.sendMessage({ type: 'SCRAPED_COURSE', data: { courseName, materials } }, (res) => {
      const err = chrome.runtime.lastError; if (err) console.warn('[CS-Course] SCRAPED_COURSE lastError:', err.message);
    });
    if (announcements.length > 0) {
      chrome.runtime.sendMessage({ type: 'SCRAPED_DATA', data: { announcements: announcements.map(a => ({ courseName, ...a })) } }, (res) => {
        const err = chrome.runtime.lastError; if (err) console.warn('[CS-Course] SCRAPED_DATA lastError:', err.message);
      });
    }
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[CS-Course] Done in ${dt}ms. Sent materials(${materials.length}) and announcements(${announcements.length}) to background. Stats:`, stats);
  } catch (e) {
    console.error('[CS-Course] Fatal error in course scraper:', e);
  }
})();
