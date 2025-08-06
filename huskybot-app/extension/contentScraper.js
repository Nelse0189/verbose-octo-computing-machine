// huskybot-app/extension/contentScraper.js
console.log("[CS] Simple content script loaded. Version 2.2");


function scrapeAnnouncements() {
  const announcements = [];
  
  // Get course name
  const courseNameElement = document.querySelector('h1.js-header-text');
  const courseName = courseNameElement ? courseNameElement.textContent.trim() : "Unknown Course";

  // Find ALL title links directly - no containers, no complex logic
  const titleLinks = document.querySelectorAll('a.list-item-title');
  console.log(`[CS] Found ${titleLinks.length} title links with class 'list-item-title'.`);

  // If we found titles, let's also check for dates and bodies
  const dateElements = document.querySelectorAll('span.list-item-date-sent');
  const bodyElements = document.querySelectorAll('p.list-item-body');
  
  console.log(`[CS] Found ${titleLinks.length} titles, ${dateElements.length} dates, and ${bodyElements.length} bodies.`);

  // Simple index-based matching
  const numAnnouncements = Math.min(titleLinks.length, dateElements.length, bodyElements.length);
  
  for (let i = 0; i < numAnnouncements; i++) {
    const title = titleLinks[i].textContent.trim();
    const date = dateElements[i].textContent.trim();
    const content = bodyElements[i].innerHTML.trim();
    
    if (title && content) {
      announcements.push({ courseName, title, date, content });
      console.log(`[CS] Added announcement: "${title}"`);
    }
  }

  console.log(`[CS] Successfully constructed ${announcements.length} announcements.`);

  if (announcements.length > 0) {
    chrome.runtime.sendMessage({
      type: "SCRAPED_DATA",
      data: {
        url: window.location.href,
        scrapedAt: new Date().toISOString(),
        announcements,
      }
    });
  }
}

function waitForContentAndScrape() {
  const maxAttempts = 20;
  let attempts = 0;

  console.log("[CS] Waiting for title links to appear...");

  const interval = setInterval(() => {
    // Look for the exact selector from the HTML provided
    const titleLinks = document.querySelectorAll('a.list-item-title');
    console.log(`[CS] Attempt ${attempts + 1}: Found ${titleLinks.length} title links.`);
    
    if (titleLinks.length > 0) {
      console.log(`[CS] Success! Found ${titleLinks.length} title links after ${attempts * 500}ms.`);
      clearInterval(interval);
      scrapeAnnouncements();
    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        console.error("[CS] Timed out. Let me try to debug what's on the page...");
        
        // Debug: Let's see what we can find
        const allLinks = document.querySelectorAll('a');
        const linksWithTitle = document.querySelectorAll('a[id*="list-item-title"]');
        console.log(`[CS] DEBUG: Found ${allLinks.length} total links, ${linksWithTitle.length} with 'list-item-title' in ID.`);
        
        scrapeAnnouncements(); // Try anyway
      }
    }
  }, 500);
}

if (window.location.href.includes('/announcements')) {
  waitForContentAndScrape();
} else {
  console.log("[CS] Not on an announcements page. No action taken.");
} 