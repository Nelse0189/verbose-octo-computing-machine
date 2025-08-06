// extension/popup.js

document.addEventListener('DOMContentLoaded', () => {
  const startScrapeBtn = document.getElementById('startScrapeBtn');

  startScrapeBtn.addEventListener('click', async () => {
    // Get the current active tab to send the onClicked event
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      // Programmatically trigger the same action as clicking the extension icon
      // This allows us to reuse the logic in background.js
      chrome.action.onClicked.dispatch(tab);
      window.close(); // Close the popup
    } else {
      console.error("No active tab found.");
    }
  });
}); 