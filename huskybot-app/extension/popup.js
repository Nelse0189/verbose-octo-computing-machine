// huskybot-app/extension/popup.js
document.addEventListener('DOMContentLoaded', () => {
  const scrapeBtn = document.getElementById('scrapeBtn');
  const showDataBtn = document.getElementById('showDataBtn');

  // Send a message to the background to start scraping the current page
  scrapeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SCRAPE_PAGE' });
    window.close();
  });

  // Send a message to the background to read and log the saved data
  showDataBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'READ_DATA' });
    window.close();
  });
}); 