// huskybot-app/extension/popup.js
document.addEventListener('DOMContentLoaded', () => {
  const scrapeBtn = document.getElementById('scrapeBtn');
  const openSiteBtn = document.getElementById('openSiteBtn');
  const showDataBtn = document.getElementById('showDataBtn');
  // Open site and request optional host permissions programmatically
  openSiteBtn.addEventListener('click', async () => {
    const extId = chrome.runtime.id;
    const target = `http://localhost:5173/?ext=${encodeURIComponent(extId)}`; // pass extension id to site
    try {
      const granted = await chrome.permissions.request({ origins: ['http://localhost:5173/*'] });
      console.log('[POPUP] Optional permissions for site', granted ? 'granted' : 'denied');
    } catch (e) {
      console.warn('[POPUP] Optional permissions request failed', e);
    }
    try {
      await chrome.tabs.create({ url: target, active: true });
      window.close();
    } catch (e) {
      console.warn('[POPUP] Failed to open site tab', e);
    }
  });

  // Send a message to the background to start scraping the current page
  scrapeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SCRAPE_PAGE' });
    window.close();
  });

  // Show saved materials with quick previews
  showDataBtn.addEventListener('click', () => {
    const container = document.getElementById('materials');
    container.innerHTML = 'Loading materials...';
    // Read only metadata to avoid exceeding message size
    chrome.runtime.sendMessage({ type: 'READ_MATERIALS_META' }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        container.textContent = `Error: ${err.message}`;
        return;
      }
      const items = (resp && resp.materials) || [];
      if (items.length === 0) {
        container.textContent = 'No materials saved yet.';
        return;
      }
      const frag = document.createDocumentFragment();
      items.slice(0, 20).forEach((m, i) => {
        const row = document.createElement('div');
        row.style.marginBottom = '10px';
        const title = document.createElement('div');
        title.textContent = `${i+1}. ${m.title} — ${m.courseName || ''}`;
        title.style.fontWeight = '600';
        row.appendChild(title);

        const info = document.createElement('div');
        const hasFile = !!m.hasFile;
        info.textContent = hasFile ? `file: ${m.mimeType}` : 'file: none';
        info.style.fontSize = '12px';
        info.style.opacity = '0.7';
        row.appendChild(info);

        if (hasFile) {
          const btn = document.createElement('button');
          btn.textContent = 'Open';
          btn.style.marginTop = '6px';
          btn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'OPEN_MATERIAL_IN_TAB', id: m.id });
          });
          row.appendChild(btn);
        }

        frag.appendChild(row);
      });
      container.innerHTML = '';
      container.appendChild(frag);
    });
  });
}); 