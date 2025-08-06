require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');
const { Pinecone } = require('@pinecone-database/pinecone');
const { getMenu, DiningHallType, DiningHalls, DiningHallHours } = require('@ilefa/blueplate');
const fs = require('fs');
const path = require('path');

// Initialize Pinecone
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

puppeteer.use(StealthPlugin());

// Initialize Firebase Admin SDK
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 8080; // Changed from 3001 to 8080

// --- WebSocket Connection Management ---
wss.on('connection', ws => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'message', message: 'Connected to server' }));

  let duoContinueResolver = null;

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    console.log('Received:', data);

    if (data.type === 'scrape') {
      try {
        const setResolver = (resolver) => {
          duoContinueResolver = resolver;
        };
        // Correctly pass the broadcast function and capture the return value
        const scrapedData = await runScraper(data.username, data.password, broadcast, setResolver);
        
        // Broadcast the scraped data back to the client so it can be saved
        if (scrapedData && scrapedData.courses && scrapedData.courses.length > 0) {
          console.log(`[Server] Broadcasting ${scrapedData.courses.length} course URLs to the client for user ${scrapedData.username}.`);
          broadcast({ type: 'data', data: scrapedData });
        } else {
          console.log('[Server] Scraper finished, but no course URLs were found to broadcast.');
        }

      } catch (error) {
        console.error('Scraping failed:', error.message);
        broadcast({ type: 'error', message: `Scraping failed: ${error.message}` });
      }
    } else if (data.type === 'scrapeClubs') {
      try {
        await scrapeClubs(data.url);
      } catch (error) {
        console.error('Club scraping failed:', error.message);
        broadcast({ type: 'error', message: `Club scraping failed: ${error.message}` });
      }
    } else if (data.type === 'continueAfterDuo') {
      if (duoContinueResolver) {
        console.log('[Server] Received continue signal from client. Resuming scrape.');
        duoContinueResolver();
        duoContinueResolver = null; // Clear after use
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Helper to broadcast a message to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// --- Middleware ---
app.use(cors({ 
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// --- API Endpoint ---
app.post('/api/scrape', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  console.log('[Server] Starting headless browser for scraping...');
  broadcast({ type: 'message', message: 'Initializing browser session...' });
  
  try {
    // Pass the broadcast function to the scraper so it can send real-time updates
    const scrapedData = await runScraper(username, password, broadcast);
    console.log('[Server] Scraping complete.');
    broadcast({ type: 'message', message: 'Scraping completed successfully!' });
    broadcast({ type: 'data', data: scrapedData });
    res.status(200).json(scrapedData);
  } catch (error) {
    console.error('[Server] Scraping failed:', error);
    broadcast({ type: 'error', message: `Error: ${error.message}` });
    res.status(500).json({ error: 'An error occurred during scraping.', details: error.message });
  }
});

// --- Chatbot API Endpoints ---
app.options('/api/chat', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).send();
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Search Pinecone for relevant clubs
    const relevantClubs = await searchClubsInPinecone(message);
    
    // Generate response using Gemini
    const botResponse = await generateResponseWithGemini(message, relevantClubs);
    
    res.status(200).json({ response: botResponse, clubs: relevantClubs });
  } catch (error) {
    console.error('[Server] Chat error:', error);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

// New endpoint to test club search functionality
app.post('/api/search-clubs', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    console.log(`[Server] Searching for clubs with query: "${query}"`);
    
    // Search Pinecone for relevant clubs
    const relevantClubs = await searchClubsInPinecone(query);
    
    res.status(200).json({ 
      query: query,
      clubsFound: relevantClubs.length,
      clubs: relevantClubs 
    });
  } catch (error) {
    console.error('[Server] Club search error:', error);
    res.status(500).json({ error: 'An error occurred while searching for clubs.' });
  }
});

app.post('/api/menu', async (req, res) => {
  const { diningHall, date } = req.body;
  if (!diningHall) {
    return res.status(400).json({ error: 'Dining hall is required' });
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
    return res.status(400).json({ error: `Invalid dining hall name. Please use one of: ${Object.keys(diningHallMap).join(', ')}` });
  }

  try {
    console.log(`[Server] Fetching menu for ${diningHall} on ${date ? new Date(date) : new Date()}`);
    const menu = await getMenu(hall, date ? new Date(date) : new Date());
    res.status(200).json(menu);
  } catch (error) {
    console.error(`[Server] Error fetching menu for ${diningHall}:`, error);
    res.status(500).json({ error: `An error occurred while fetching the menu for ${diningHall}.` });
  }
});

app.get('/api/hours/:diningHall', (req, res) => {
  const { diningHall } = req.params;
  const diningHallKey = diningHall.toUpperCase();

  if (DiningHalls[diningHallKey]) {
    const hours = DiningHallHours[diningHallKey];
    res.status(200).json(hours);
  } else {
    res.status(404).json({ error: 'Dining hall not found' });
  }
});

// Helper function to search clubs in Pinecone and fetch full details from Firebase
async function searchClubsInPinecone(query) {
  try {
    const index = pinecone.index('huskybot-clubs');
    
    // Get embedding for the query using OpenAI (since we're on the server)
    const { OpenAI } = require('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query.replace(/\n/g, ' '),
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Search Pinecone
    const searchResponse = await index.query({
      vector: queryEmbedding,
      topK: 5,
      includeMetadata: true
    });

    // Extract Firestore IDs from Pinecone results
    const firestoreIds = searchResponse.matches
      ?.map(match => match.metadata?.firestoreId)
      .filter(id => id) || [];

    console.log(`Found ${firestoreIds.length} relevant clubs in Pinecone. Fetching full details from Firebase...`);

    // Fetch complete club details from Firebase
    const clubsWithFullDetails = [];
    for (const firestoreId of firestoreIds) {
      try {
        const clubDoc = await db.collection('clubs').doc(firestoreId).get();
        if (clubDoc.exists) {
          const clubData = clubDoc.data();
          clubsWithFullDetails.push({
            name: clubData.name || 'Unknown Club',
            description: clubData.description || '',
            summary: clubData.summary || '',
            url: clubData.url || '',
            email: clubData.email || '',
            phone: clubData.phone || '',
            address: clubData.address || '',
            socialLinks: clubData.socialLinks || [],
            icon: clubData.icon || '',
            scrapedAt: clubData.scrapedAt || null
          });
        }
      } catch (error) {
        console.error(`Error fetching club ${firestoreId} from Firebase:`, error);
      }
    }

    console.log(`Successfully fetched ${clubsWithFullDetails.length} clubs with full details from Firebase.`);
    return clubsWithFullDetails;
  } catch (error) {
    console.error('Error searching clubs:', error);
    return [];
  }
}

// Helper function to generate response with Gemini
async function generateResponseWithGemini(userMessage, relevantClubs) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    
    // Debug: Check if API key is loaded
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set in environment variables');
      return "I'm sorry, there's a configuration issue with the AI service. Please check the server setup.";
    }
    
    console.log('Using Gemini API key:', process.env.GEMINI_API_KEY.substring(0, 10) + '...');
    
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }); // Gemini 2.5 Flash
    
    // Create rich context with all available club information
    const context = relevantClubs.map(club => `
Club: ${club.name}
Description: ${club.description || 'No description available'}
Summary: ${club.summary || 'No summary available'}
Contact Information:
${club.email ? `- Email: ${club.email}` : ''}
${club.phone ? `- Phone: ${club.phone}` : ''}
${club.address ? `- Address: ${club.address}` : ''}
${club.socialLinks && club.socialLinks.length > 0 ? `- Social Media: ${club.socialLinks.join(', ')}` : ''}
Website: ${club.url || 'No website available'}
Last Updated: ${club.scrapedAt ? new Date(club.scrapedAt.toDate()).toLocaleDateString() : 'Unknown'}
    `).join('\n\n');

    const prompt = `You are a helpful UConn student assistant with access to comprehensive information about student clubs and organizations. 

Based on the following detailed club information retrieved from UConn's official database, answer the user's question in a friendly, helpful way. If the information isn't available in the provided context, say so politely and suggest they check the club's website or contact them directly.

Club Information:
${context}

User Question: ${userMessage}

Please provide a helpful response that directly addresses the user's question using the club information provided. Be conversational and friendly. If multiple clubs are relevant, mention all of them. Include contact information and website links when available.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Error generating response:', error);
    return "I'm sorry, I'm having trouble processing your request right now. Please try again later.";
  }
}

async function scrapeClubs(url) {
  broadcast({ type: 'message', message: '🚀 Starting full club scraping process...' });
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    broadcast({ type: 'message', message: '✅ Navigated to organizations page.' });
    console.log('[SCRAPER] Navigated to organizations page.');

    // --- Phase 1: Expand the entire list of clubs ---
    let stallAttempts = 0;
    const maxStalls = 3;
    let previousClubCount = 0;
    while (stallAttempts < maxStalls) {
        const loadMoreButton = await page.$('button ::-p-text(Load More)');
        if (!loadMoreButton) {
            broadcast({ type: 'message', message: '✅ "Load More" button not found. Assuming all clubs are loaded.' });
            console.log('[SCRAPER] "Load More" button not found. All clubs loaded.');
            break;
        }

        const currentClubCount = await page.evaluate(() => document.querySelectorAll('a[href^="/organization/"]').length);
        broadcast({ type: 'message', message: `Expanding list... ${currentClubCount} clubs found so far.` });
        console.log(`[SCRAPER] Clicking "Load More". Current club count: ${currentClubCount}`);
        
        await loadMoreButton.click();
        await page.waitForNetworkIdle({ idleTime: 2000, timeout: 15000 }).catch(() => console.log('[SCRAPER] Network idle timeout after click. Continuing...'));
        await new Promise(resolve => setTimeout(resolve, 500)); // Small delay for DOM to update

        const newClubCount = await page.evaluate(() => document.querySelectorAll('a[href^="/organization/"]').length);
        if (newClubCount === currentClubCount) {
            stallAttempts++;
            broadcast({ type: 'warning', message: `⚠️ Page may have stalled. Attempt ${stallAttempts}/${maxStalls}`});
            console.log(`[SCRAPER] Club count did not change. Stall attempt ${stallAttempts}.`);
        } else {
            stallAttempts = 0;
        }
        previousClubCount = newClubCount;
    }

    // --- Phase 2: Extract all club data in one go ---
    broadcast({ type: 'message', message: 'Extracting final list of clubs...' });
    console.log('[SCRAPER] Page fully expanded. Extracting all club data.');
    const RESUME_AFTER_CLUB = "Student Union Board of Governors (SUBOG)";
    
    const clubsToProcess = await page.evaluate((resumeClubName) => {
        const clubElements = Array.from(document.querySelectorAll('a[href^="/organization/"]'));
        let finalClubList = [];
        let startIndex = 0;

        if (resumeClubName) {
            const resumeIndex = clubElements.findIndex(el => {
                const nameElement = el.querySelector('div[style*="font-weight: 600"]');
                return nameElement && nameElement.innerText.trim() === resumeClubName;
            });

            if (resumeIndex !== -1) {
                console.log(`Resume point "${resumeClubName}" found. Starting after it.`);
                startIndex = resumeIndex + 1;
            } else {
                console.log(`Warning: Resume point "${resumeClubName}" not found. Scraping all clubs.`);
            }
        }
        
        for (let i = startIndex; i < clubElements.length; i++) {
            const el = clubElements[i];
            const relativeUrl = el.getAttribute('href');
            if (!relativeUrl) continue;

            const absoluteUrl = new URL(relativeUrl, document.baseURI).href;
            const imgElement = el.querySelector('img');
            const nameElement = el.querySelector('div[style*="font-weight: 600"]');
            
            finalClubList.push({
                name: nameElement ? nameElement.innerText.trim() : (imgElement ? imgElement.alt.trim() : 'Unknown Name'),
                url: absoluteUrl,
                icon: imgElement ? imgElement.src : null
            });
        }
        return finalClubList;
    }, RESUME_AFTER_CLUB);

    if (RESUME_AFTER_CLUB) {
        broadcast({ type: 'message', message: `✅ Resumed after "${RESUME_AFTER_CLUB}".`});
    }

    // --- Phase 3: Process each club's detail page ---
    broadcast({ type: 'message', message: `Collected ${clubsToProcess.length} total club URLs. Now scraping individual pages.` });
    console.log(`[SCRAPER] Starting to scrape details for ${clubsToProcess.length} clubs.`);

    for (let i = 0; i < clubsToProcess.length; i++) {
      const club = clubsToProcess[i];
      if (!club.url) {
        console.log(`[SCRAPER] Skipping a club with no URL.`);
        continue;
      }

      broadcast({ type: 'message', message: `[${i + 1}/${clubsToProcess.length}] Scraping: ${club.name}` });
      console.log(`[SCRAPER] [${i + 1}/${clubsToProcess.length}] Navigating to ${club.url}`);
      
      const clubPage = await browser.newPage();
      await clubPage.goto(club.url, { waitUntil: 'networkidle2' });
      
      const clubData = await clubPage.evaluate(() => {
        const title = document.querySelector('h1')?.innerText.trim() || null;
        const description = document.querySelector('.bodyText-large.userSupplied p')?.innerText.trim() || null;
        
        const contactInfoElement = document.querySelector('div[style*="border-left-width: 1px"]');
        let address = null, email = null, phone = null;
        
        if (contactInfoElement) {
            const emailElement = Array.from(contactInfoElement.querySelectorAll('div')).find(div => div.innerText.includes('E:'));
            email = emailElement ? emailElement.innerText.replace('E:', '').trim() : null;

            const phoneElement = Array.from(contactInfoElement.querySelectorAll('div')).find(div => div.innerText.includes('P:'));
            phone = phoneElement ? phoneElement.innerText.replace('P:', '').trim() : null;
            
            const addressElement = contactInfoElement.querySelector('div:first-child');
            if (addressElement) {
              address = addressElement.innerText.replace(/\s+/g, ' ').trim();
            }
        }

        const socialLinks = Array.from(document.querySelectorAll('a[aria-label*="Visit our"]')).map(a => a.href);
        const summary = document.querySelector('div.bodyText-large > p')?.innerText.trim() || null;

        return { title, description, address, email, phone, socialLinks, summary };
      });

      console.log(`[SCRAPER] Extracted data for ${club.name}:`, clubData);
      
      const docId = club.name.replace(/[.\/[\]*~]/g, '').replace(/ /g, '_');
      const clubDoc = {
        name: club.name,
        icon: club.icon,
        url: club.url,
        scrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...clubData
      };
      
      await db.collection('clubs').doc(docId).set(clubDoc, { merge: true });
      broadcast({ type: 'message', message: `[${i + 1}/${clubsToProcess.length}] ✅ Saved ${club.name} to database.` });
      console.log(`[SCRAPER] Saved ${club.name} to Firestore with ID ${docId}.`);

      await clubPage.close();
    }
    
    broadcast({ type: 'message', message: '✅ All done! Finished scraping all available clubs.' });
    console.log('[SCRAPER] Club scraping process finished successfully.');

  } catch (error) {
    console.error('Error during club scraping:', error);
    broadcast({ type: 'error', message: `An error occurred: ${error.message}` });
  } finally {
    console.log('[SCRAPER] Closing browser.');
    await browser.close();
    console.log('[SCRAPER] Browser closed.');
  }
}

// --- The Scraper Logic (Adapted for Puppeteer and WebSocket) ---
async function runScraper(username, password, broadcast, setDuoContinueResolver) {
  let browser;
  const downloadPath = path.resolve('./temp_downloads');
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }

  try {
    console.log('[Scraper][Init] Launching browser...');
    broadcast({ type: 'message', message: 'Launching browser session...' });
    
    // --- MODIFICATION FOR LOCAL TESTING ---
    console.log('[Scraper][Init] USING LOCAL CHROME PROFILE FOR AUTHENTICATION');
    browser = await puppeteer.launch({
      headless: false, // Must be false to use a user profile
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: '/Users/nicholaselsener/Library/Application Support/Google/Chrome',
      args: [
        '--profile-directory=Default',
        '--ignore-certificate-errors'
      ]
    });
    // --- END MODIFICATION ---

    const page = await browser.newPage();
    
    // Enable downloads in Puppeteer
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath,
    });

    console.log('[Scraper][Init] New page created and configured for downloads.');

    // Set up error monitoring for JavaScript errors on the page
    page.on('pageerror', error => {
      console.error(`[Scraper][Page-JS-Error] ${error.message}`);
      
      // Check for specific ClientJS error
      if (error.message.includes('ClientJS is not defined')) {
        console.error('[Scraper] ClientJS error detected - likely authentication page loading issue');
        broadcast({ 
          type: 'clientjs_error', 
          message: 'Authentication page failed to load properly. Please verify your credentials and try again.' 
        });
      }
    });

    // Monitor console errors as well
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`[Scraper][Page-Console-Error] ${msg.text()}`);
        
        // Check for ClientJS error in console
        if (msg.text().includes('ClientJS is not defined')) {
          console.error('[Scraper] ClientJS console error detected');
          broadcast({ 
            type: 'clientjs_error', 
            message: 'Authentication system encountered an error. Please check your credentials and try again.' 
          });
        }
      }
    });
    console.log('[Scraper][Init] Page event listeners for errors are active.');


    // --- COMMENTING OUT LOGIN FLOW FOR LOCAL TESTING ---
    /*
    console.log('[Scraper][Auth] Navigating to HuskyCT institution page...');
    broadcast({ type: 'message', message: 'Navigating to HuskyCT login page...' });
    
    // Use a more robust goto command with a longer timeout
    await page.goto('https://huskyct.uconn.edu/ultra/institution-page', {
      waitUntil: 'networkidle0',
      timeout: 30000 // 30 seconds
    });
    console.log('[Scraper][Auth] Landed on institution page.');

    // Click OK if it exists
    try {
      const okButtonSelector = 'button ::-p-text(OK)';
      console.log('[Scraper][Auth] Looking for "OK" button...');
      await page.waitForSelector(okButtonSelector, { timeout: 3000 });
      await page.click(okButtonSelector);
      console.log('[Scraper][Auth] "OK" button clicked.');
    } catch (e) {
       console.log('[Scraper][Auth] "OK" button not found, continuing...');
    }
    
    // Click main login link
    const loginLinkSelector = 'a#cas-login';
    console.log(`[Scraper][Auth] Looking for main login link: ${loginLinkSelector}`);
    broadcast({ type: 'message', message: 'Locating login interface...' });
    
    await page.waitForSelector(loginLinkSelector, { visible: true });
    await page.click(loginLinkSelector);

    console.log('[Scraper][Auth] Main login link clicked. Waiting for SSO page to render...');
    broadcast({ type: 'message', message: 'Accessing UConn authentication system...' });
    
    // On a single-page app, a full navigation might not occur.
    // Instead, we'll wait for a key element of the new "page" to appear.
    const usernameSelector = 'input#username';
    
    try {
      await page.waitForSelector(usernameSelector, { visible: true, timeout: 15000 });
      console.log('[Scraper][Auth] SSO page rendered. Found username field.');
      broadcast({ type: 'message', message: 'Authentication page loaded.' });
    } catch (e) {
      // If we can't find the username field, it might be due to ClientJS error
      console.error('[Scraper][Auth] Failed to find username field - checking for ClientJS error');
      
      // Check if there are any JavaScript errors on the page
      const errors = await page.evaluate(() => {
        return window.errors || [];
      });
      
      throw new Error('Authentication page failed to load properly. This may be due to incorrect credentials or a temporary server issue. Please verify your NetID and password and try again.');
    }

    // --- NOW, on the second page, we enter credentials ---
    console.log('[Scraper][Auth] Attempting to enter credentials...');
    broadcast({ type: 'message', message: 'Entering credentials...' });
    
    // Using precise selectors based on the actual HTML of the SSO page.
    const passwordSelector = 'input#password'; // Assuming password field has a similar structure
    
    console.log(`[Scraper][Auth] Waiting for username field with selector: ${usernameSelector}`);
    // We already waited for it, so this should be instant.
    await page.waitForSelector(usernameSelector, { visible: true });
    console.log('[Scraper][Auth] Username field found. Typing username...');
    await page.type(usernameSelector, username);
    
    console.log(`[Scraper][Auth] Waiting for password field with selector: ${passwordSelector}`);
    await page.waitForSelector(passwordSelector, { visible: true });
    console.log('[Scraper][Auth] Password field found. Typing password...');
    await page.type(passwordSelector, password);
    
    console.log('[Scraper][Auth] Credentials entered on SSO page. Submitting...');
    broadcast({ type: 'message', message: 'Submitting login credentials...' });
    await page.keyboard.press('Enter');

    // --- NEW: Wait for Duo prompt OR a login error message ---
    console.log('[Scraper][Auth] Credentials submitted. Waiting for Duo prompt or login error...');
    broadcast({ type: 'message', message: 'Waiting for Duo Security prompt...' });

    const duoSelector = '.verification-code';
    // Using a more specific set of selectors to avoid false positives
    const errorSelector = '.errors, .form-element--error, .alert-danger, #msg.msg'; 
    const raceSelector = `${duoSelector}, ${errorSelector}`;

    try {
      await page.waitForSelector(raceSelector, { visible: true, timeout: 20000 }); // 20s timeout

      // Check which element appeared
      const duoElement = await page.$(duoSelector);
      if (duoElement) {
        // --- Duo Logic ---
        console.log('[Scraper][Auth-Duo] Duo prompt detected. Proceeding with 2FA.');
        const passcode = await page.evaluate(el => el.textContent.trim(), duoElement);
        
        console.log(`[Scraper][Auth-Duo] Found Duo passcode: ${passcode}. Sending to frontend.`);
        broadcast({ type: 'duo_passcode', code: passcode });
        broadcast({ type: 'message', message: 'Duo passcode received. Please approve on your device and click continue.' });

        console.log('[Scraper][Auth-Duo] Paused. Waiting for user to approve on device and for continue signal from client...');
        
        await new Promise(resolve => {
          setDuoContinueResolver(resolve);
        });

        console.log('[Scraper][Auth-Duo] Resuming scrape after client signal...');
        broadcast({ type: 'message', message: 'Resuming process after Duo approval...' });

      } else {
        // --- Error Logic ---
        const errorElement = await page.$(errorSelector);
        let errorMessage = 'An unknown authentication error occurred.';
        if (errorElement) {
          errorMessage = await page.evaluate(el => el.textContent?.trim() || 'Invalid credentials.', errorElement);
        }
        
        console.error(`[Scraper][Auth-Error] Authentication failed. Found error on page: ${errorMessage}`);
        broadcast({ 
          type: 'credential_error', 
          message: errorMessage
        });
        throw new Error(errorMessage);
      }
    } catch (e) {
      // This catch block now handles two cases:
      // 1. Timeout: Neither Duo nor an error appeared. This could be a slow network or an unexpected page.
      // 2. No Duo Required: The login was successful and immediately navigated away.
      
      console.log(`[Scraper][Auth] Duo prompt/error not found. Assuming direct login or checking current URL. Error: ${e.message}`);
      // If we are no longer on a login page, the login was likely successful without Duo
      if (!page.url().includes('login')) {
         console.log('[Scraper][Auth] No Duo required and successfully navigated away from login page.');
         broadcast({ type: 'message', message: 'Processing authentication (no Duo required)...' });
      } else {
         // If we are still on a login page, something went wrong.
         console.error('[Scraper][Auth] Authentication may have failed without a clear error message.');
         throw new Error('Authentication timed out or failed in an unexpected way. Please try again.');
      }
    }
    // --------------------------------------------------

    console.log('[Scraper][Auth] Waiting for final navigation after SSO/Duo login...');
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }); // Short timeout, might fail if Duo is slow
    } catch(e) {
        console.log('[Scraper][Auth] Initial navigation after Duo failed or was not needed, attempting to click trust button.');
    }

    try {
        const trustButtonSelector = '#dont-trust-browser-button';
        console.log(`[Scraper][Auth] Looking for "${trustButtonSelector}" button...`);
        await page.waitForSelector(trustButtonSelector, { visible: true, timeout: 15000 });
        await page.click(trustButtonSelector);
        console.log('[Scraper][Auth] Clicked "No, other people use this device" button.');
        broadcast({ type: 'message', message: 'Clicked trust button...' });
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 90000 });
    } catch (e) {
        console.log('[Scraper][Auth] "Don\'t trust browser" button not found, continuing as if successful...');
        broadcast({ type: 'message', message: 'Trust button not found, continuing...' });
    }
    */
    // --- END OF COMMENTED OUT LOGIC FOR LOCAL TESTING ---

    console.log('[Scraper][Navigation] Bypassing login. Navigating directly to courses page...');
    broadcast({ type: 'message', message: 'Using existing browser session to access student portal...' });

    // --- DIAGNOSTIC STEP ---
    console.log('[Scraper][Diagnostic] Navigating to Google to verify browser control.');
    await page.goto('https://www.google.com');
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
    console.log('[Scraper][Diagnostic] Navigation to Google successful.');
    // --- END DIAGNOSTIC STEP ---

    await page.goto('https://huskyct.uconn.edu/ultra/course');
    
    // --- DIAGNOSTIC STEP ---
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for any redirects
    const finalUrl = page.url();
    console.log(`[Scraper][Diagnostic] Final URL after navigation attempt: ${finalUrl}`);
    if (finalUrl.includes('login') || finalUrl.includes('cas.uconn.edu')) {
        console.error('[Scraper][Diagnostic-Error] FAILED TO LOAD SESSION. The browser was redirected to a login page.');
        throw new Error('Failed to load authenticated session from local browser profile.');
    }
    // --- END DIAGNOSTIC STEP ---

    broadcast({ type: 'message', message: 'Loading course information...' });

    // ... (rest of the scraping logic) ...
    broadcast({ type: 'message', message: 'Scanning for course data...' });
    await autoScroll(page);
    broadcast({ type: 'message', message: 'Processing course information...' });
    
    const courseUrls = await page.evaluate(() => {
        const courseElements = document.querySelectorAll('article[data-course-id]');
        return Array.from(courseElements)
          .map(element => {
            const courseId = element.dataset.courseId;
            if (courseId && courseId.trim() !== '') {
              return `https://huskyct.uconn.edu/ultra/courses/${courseId}/outline`;
            }
            return null;
          })
          .filter(url => url !== null);
    });
    
    console.log(`[Scraper][CourseList] Extracted ${courseUrls.length} course URLs.`);

    // --- NEW: Deep Scrape Each Course ---
    const allScrapedData = [];
    broadcast({ type: 'message', message: `Found ${courseUrls.length} courses. Starting deep scrape...` });

    for (let i = 0; i < courseUrls.length; i++) {
        const url = courseUrls[i];
        console.log(`[Scraper][CourseLoop][${i + 1}/${courseUrls.length}] Starting course: ${url}`);
        try {
            broadcast({ type: 'message', message: `[${i + 1}/${courseUrls.length}] Navigating to course: ${url}` });
            await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

            const courseName = await page.evaluate(() => {
                const headerElement = document.querySelector('h1.js-header-text.js-readonly-header-text');
                return headerElement ? headerElement.textContent.trim() : 'Unknown Course';
            });
            console.log(`[Scraper][CourseLoop][${i + 1}/${courseUrls.length}] Now scraping "${courseName}"`);
            broadcast({ type: 'message', message: `[${i + 1}/${courseUrls.length}] Scraping: ${courseName}` });
            
            // Expand all modules to ensure all content is visible
            console.log(`[Scraper][CourseLoop][${courseName}] Expanding all content modules.`);
            await page.evaluate(async () => {
                const moduleButtons = document.querySelectorAll('button[id^="learning-module-title-"]');
                for (const button of moduleButtons) {
                    if (button.getAttribute('aria-expanded') === 'false') {
                       button.click();
                        await new Promise(resolve => setTimeout(resolve, 500)); // wait for content to load
                    }
                }
            });
            console.log(`[Scraper][CourseLoop][${courseName}] Modules expanded.`);
            
            const courseMaterials = [];

            // Get all content items (documents, files, etc.)
            const contentItemIds = await page.evaluate(() => 
                Array.from(document.querySelectorAll('div[data-item-id]'), el => el.getAttribute('data-item-id'))
            );

            console.log(`[Scraper][CourseLoop][${courseName}] Found ${contentItemIds.length} content items.`);
            broadcast({ type: 'message', message: `[${i + 1}/${courseUrls.length}] Found ${contentItemIds.length} content items in ${courseName}.` });

            for (let j = 0; j < contentItemIds.length; j++) {
                const itemId = contentItemIds[j];
                const itemSelector = `div[data-item-id="${itemId}"]`;
                
                // Get the title/name of the item
                const itemName = await page.evaluate((selector) => {
                    const itemElement = document.querySelector(selector);
                    const link = itemElement.querySelector('a[data-analytics-id*="link"]');
                    return link ? link.textContent.trim() : 'Unnamed Item';
                }, itemSelector);

                console.log(`[Scraper][ItemLoop][${courseName}][${j+1}/${contentItemIds.length}] Processing: "${itemName}"`);
                broadcast({ type: 'message', message: `[${i + 1}/${courseUrls.length}] (${j+1}/${contentItemIds.length}) Processing: ${itemName}`});

                // Check for overflow menu (download button)
                const overflowButtonSelector = `${itemSelector} button[id^="content-item-overflow-menu-button-"]`;
                const overflowButton = await page.$(overflowButtonSelector);
                
                // New: Also check for the Ally "Alternative Formats" button
                const allyButtonSelector = `${itemSelector} button[data-ally-invoke="alternativeformats"]`;
                const allyButton = await page.$(allyButtonSelector);

                if (overflowButton) {
                    // This is a direct downloadable file (Priority)
                    console.log(`[Scraper][ItemLoop][${itemName}] Found direct download button. Attempting download.`);
                    try {
                        let downloadedFilePath = '';
                        let downloadTimeout = false;

                        const downloadWatcher = new Promise((resolve, reject) => {
                            page.on('download', async (download) => {
                                const filePath = path.join(downloadPath, download.suggestedFilename());
                                await download.saveAs(filePath);
                                downloadedFilePath = filePath;
                                resolve();
                            });
                            setTimeout(() => {
                                downloadTimeout = true;
                                reject(new Error('Download timed out after 30 seconds'));
                            }, 30000);
                        });

                        await overflowButton.click();
                        await page.waitForSelector('li[data-analytics-id*="download.link"]', { visible: true, timeout: 5000 });
                        await page.click('li[data-analytics-id*="download.link"]');

                        await downloadWatcher;

                        if (downloadedFilePath) {
                            const fileData = fs.readFileSync(downloadedFilePath, { encoding: 'base64' });
                            courseMaterials.push({
                                title: itemName,
                                content: '', // No main content for file downloads
                                images: [],
                                files: [{
                                    fileName: path.basename(downloadedFilePath),
                                    data: fileData
                                }]
                            });
                            fs.unlinkSync(downloadedFilePath); // Clean up temp file
                            broadcast({ type: 'message', message: `✅ Downloaded: ${itemName}` });
                            console.log(`[Scraper][ItemLoop][${itemName}] Successfully downloaded directly.`);
                        }
                    } catch (e) {
                         console.error(`[Scraper][Item-Error][${itemName}] Direct download failed. Error: ${e.message}`);
                         broadcast({ type: 'warning', message: `Could not download: ${itemName}` });
                    }
                } else if (allyButton) {
                    // This is a file that needs conversion via Ally
                    console.log(`[Scraper][ItemLoop][${itemName}] Found Ally 'Alternative Formats' button.`);
                    broadcast({ type: 'message', message: `[Ally] Found alternative download for: ${itemName}`});
                    try {
                        console.log(`[Scraper][Item-Ally][${itemName}] Clicking Ally button and waiting for modal.`);
                        await allyButton.click();
                        
                        // Wait for the Ally iframe to appear and get a handle on it
                        const iframeElement = await page.waitForSelector('iframe[title="Alternative formats"]', { timeout: 10000 });
                        const frame = await iframeElement.contentFrame();

                        if (!frame) {
                            throw new Error('Could not get content frame for Ally modal.');
                        }

                        // We want HTML format. Let's select it.
                        console.log(`[Scraper][Item-Ally][${itemName}] Selecting HTML format in modal.`);
                        // This assumes a radio button or similar clickable element.
                        const htmlFormatSelector = 'li[data-format="Tagged PDF"] + li'; // A guess that HTML is after PDF
                        await frame.waitForSelector(htmlFormatSelector, { visible: true, timeout: 5000 });
                        await frame.click(htmlFormatSelector);
                        
                        // 1. Click download to start conversion
                        console.log(`[Scraper][Item-Ally][${itemName}] Clicking download to start conversion.`);
                        const downloadButtonSelector = 'button.download-button';
                        await frame.waitForSelector(downloadButtonSelector, { visible: true });
                        await frame.click(downloadButtonSelector);

                        // 2. Wait for the "Preparing" message to appear and then disappear
                        console.log(`[Scraper][Item-Ally][${itemName}] Waiting for file conversion...`);
                        broadcast({ type: 'message', message: `[Ally] Converting ${itemName} to HTML...` });
                        const preparingSelector = 'div[translate*="PREPARING_YOUR_DOWNLOAD"]';
                        await frame.waitForSelector(preparingSelector, { visible: true, timeout: 5000 });
                        await frame.waitForSelector(preparingSelector, { hidden: true, timeout: 60000 }); // Wait up to 60s
                        
                        console.log(`[Scraper][Item-Ally][${itemName}] Conversion complete. Starting final download.`);
                        broadcast({ type: 'message', message: `[Ally] Conversion complete. Downloading ${itemName}...` });

                        // 3. Click download again to get the file
                        let downloadedFilePath = '';
                        const downloadWatcher = new Promise((resolve, reject) => {
                             page.on('download', async (download) => {
                                const suggestedFilename = download.suggestedFilename().replace(/\.zip$/, '.html');
                                const filePath = path.join(downloadPath, suggestedFilename);
                                await download.saveAs(filePath);
                                downloadedFilePath = filePath;
                                resolve();
                            });
                            setTimeout(() => reject(new Error('Ally download timed out after 30 seconds')), 30000);
                        });

                        await frame.click(downloadButtonSelector);
                        await downloadWatcher;

                        if (downloadedFilePath) {
                            const fileData = fs.readFileSync(downloadedFilePath, { encoding: 'base64' });
                            courseMaterials.push({
                                title: itemName,
                                content: '',
                                images: [],
                                files: [{
                                    fileName: path.basename(downloadedFilePath),
                                    data: fileData
                                }]
                            });
                            fs.unlinkSync(downloadedFilePath);
                            broadcast({ type: 'message', message: `✅ [Ally] Downloaded: ${itemName}` });
                            console.log(`[Scraper][Item-Ally][${itemName}] Successfully downloaded via Ally.`);
                        }

                        // Close the modal
                        console.log(`[Scraper][Item-Ally][${itemName}] Closing Ally modal.`);
                        await page.keyboard.press('Escape');
                        await page.waitForSelector('iframe[title="Alternative formats"]', { hidden: true });

                    } catch (e) {
                        console.error(`[Scraper][Item-Error][${itemName}] Ally download failed. Error: ${e.message}`);
                        broadcast({ type: 'warning', message: `Could not process Ally download for: ${itemName}` });
                         // Ensure modal is closed if something goes wrong
                        if (await page.$('iframe[title="Alternative formats"]')) {
                            await page.keyboard.press('Escape');
                        }
                    }
                } else {
                    // This is likely a regular content page
                    console.log(`[Scraper][ItemLoop][${itemName}] No download button found. Treating as a content page.`);
                    const linkSelector = `${itemSelector} a[data-analytics-id*="link"]`;
                    const linkUrl = await page.evaluate(sel => document.querySelector(sel)?.href, linkSelector);

                    if (linkUrl) {
                        try {
                            console.log(`[Scraper][Item-Page][${itemName}] Navigating to content page: ${linkUrl}`);
                            await page.goto(linkUrl, { waitUntil: 'networkidle0', timeout: 20000 });
                            
                            console.log(`[Scraper][Item-Page][${itemName}] Scraping content from page.`);
                            const materialData = await page.evaluate((title) => {
                                // (Same as before)
                                const editor = document.querySelector('div.ql-editor.bb-editor');
                                if (!editor) return null;
                                const content = editor.textContent?.trim() || '';
                                const images = [];
                                editor.querySelectorAll('img').forEach(img => {
                                    if (img.src) images.push({ src: img.src, alt: img.alt || 'image' });
                                });
                                editor.querySelectorAll('div[data-bbtype="attachment"]').forEach(att => {
                                    const href = att.getAttribute('href');
                                    if (href && !images.some(img => img.src === href)) {
                                        let altText = "attachment";
                                        const dataBbFile = att.getAttribute('data-bbfile');
                                        if (dataBbFile) {
                                            try {
                                                const fileInfo = JSON.parse(dataBbFile);
                                                altText = fileInfo.alternativeText || fileInfo.linkName || "attachment";
                                            } catch (e) {}
                                        }
                                        images.push({ src: href, alt: altText });
                                    }
                                });
                                return { title, content, images, files: [] };
                            }, itemName);

                            if (materialData) {
                                courseMaterials.push(materialData);
                            }
                            // Go back to the course outline page to continue the loop
                            console.log(`[Scraper][Item-Page][${itemName}] Successfully scraped page. Navigating back.`);
                            await page.goBack({ waitUntil: 'networkidle0' });

                        } catch(e) {
                            console.error(`[Scraper][Item-Error][${itemName}] Failed to scrape page. Error: ${e.message}`);
                            broadcast({ type: 'warning', message: `Could not scrape page: ${itemName}` });
                            // Go back even if it fails to avoid being stuck
                            console.log(`[Scraper][Item-Error][${itemName}] Attempting to navigate back after error.`);
                            await page.goBack({ waitUntil: 'networkidle0' });
                        }
                    } else {
                        console.warn(`[Scraper][ItemLoop][${itemName}] No link found for this content page. Skipping.`);
                    }
                }
            }
            
            // --- NEW: Scrape Announcements for the course ---
            const announcements = [];
            try {
                console.log(`[Scraper][Announcements][${courseName}] Navigating to announcements tab.`);
                const announcementsLinkSelector = 'a[data-analytics-id="course.announcements.link"]';
                await page.waitForSelector(announcementsLinkSelector, { visible: true, timeout: 10000 });
                await page.click(announcementsLinkSelector);
                await page.waitForNavigation({ waitUntil: 'networkidle0' });

                console.log(`[Scraper][Announcements][${courseName}] On announcements page. Scraping list.`);

                // Wait for the list to be populated
                await page.waitForSelector('a[id^="list-item-title-"]', { timeout: 10000 });

                const announcementIds = await page.evaluate(() => 
                    Array.from(document.querySelectorAll('a[id^="list-item-title-"]'), a => a.id)
                );
                
                console.log(`[Scraper][Announcements][${courseName}] Found ${announcementIds.length} announcements.`);

                for (let k = 0; k < announcementIds.length; k++) {
                    const annId = announcementIds[k];
                    try {
                        const annLinkSelector = `a#${annId}`;
                        const annTitle = await page.evaluate(sel => document.querySelector(sel)?.textContent?.trim(), annLinkSelector);
                        
                        console.log(`[Scraper][Announcements][${courseName}][${k+1}/${announcementIds.length}] Scraping: "${annTitle}"`);
                        
                        await page.click(annLinkSelector);

                        const contentPanelSelector = 'div.side-panel-content';
                        await page.waitForSelector(contentPanelSelector, { visible: true, timeout: 10000 });
                        
                        const announcementContent = await page.evaluate((panelSelector) => {
                            const panel = document.querySelector(panelSelector);
                            const editor = panel.querySelector('div.ql-editor.bb-editor');
                            return editor ? editor.innerHTML : ''; // Get innerHTML to preserve formatting
                        }, contentPanelSelector);

                        announcements.push({ title: annTitle, content: announcementContent });

                        // Close the side panel to go back to the list
                        const closeButtonSelector = 'button[data-analytics-id="panel.close.button"]';
                        await page.click(closeButtonSelector);
                        await page.waitForSelector(contentPanelSelector, { hidden: true });

                    } catch(e) {
                        console.error(`[Scraper][Announcements-Error][${courseName}] Failed to scrape announcement with id ${annId}. Error: ${e.message}`);
                    }
                }

            } catch(e) {
                console.error(`[Scraper][Announcements-Error][${courseName}] Could not scrape announcements tab. Error: ${e.message}`);
                broadcast({ type: 'warning', message: `Could not get announcements for ${courseName}.`});
            }


            allScrapedData.push({ courseName, materials: courseMaterials, announcements: announcements, updatedAt: new Date() });
            console.log(`[Scraper][CourseLoop][${courseName}] Finished processing all items and announcements for this course.`);
        } catch (e) {
            console.error(`[Scraper][Course-Error] A fatal error occurred while scraping course at ${url}. Error: ${e.message}`);
            broadcast({ type: 'warning', message: `Skipping one course due to an error.` });
        }
    }

    broadcast({ type: 'message', message: 'Finalizing data collection...' });
    console.log('[Scraper][Complete] Scraping process finished. Returning data to client.');
    // Return the full scraped data object
    return { allCourses: allScrapedData, username: username };

  } catch (e) {
    // This is the global error handler
    console.error('--- A FATAL ERROR OCCURRED IN THE SCRAPER ---');
    console.error(e);
    
    // Check if this is a ClientJS-related error and provide specific guidance
    if (e.message.includes('ClientJS') || e.message.includes('Authentication page failed to load')) {
      broadcast({ 
        type: 'credential_error', 
        message: 'Authentication failed. Please verify your NetID and password are correct and try again.' 
      });
    } else {
      broadcast({ type: 'error', message: `Scraping failed: ${e.message}` });
    }
    
    // Re-throw the error so the API endpoint can report it
    throw e;
  } finally {
    if (browser) {
      console.log('[Scraper][Cleanup] Closing browser...');
      await browser.close();
      console.log('[Scraper][Cleanup] Browser closed.');
    }
     if (fs.existsSync(downloadPath)) {
      console.log('[Scraper][Cleanup] Deleting temporary download directory.');
      fs.rmSync(downloadPath, { recursive: true, force: true });
    }
  }
}

// Helper function to reliably scroll to the bottom of a page with lazy loading.
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100; // a small distance to scroll each time
      const scrollInterval = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        // Check if we've reached the bottom
        if (totalHeight >= scrollHeight - window.innerHeight) {
          // Once at the bottom, wait a bit to see if new content loads
          setTimeout(() => {
            const newScrollHeight = document.body.scrollHeight;
            // If the height hasn't changed, we're done
            if (newScrollHeight === scrollHeight) {
              clearInterval(scrollInterval);
              resolve();
            }
          }, 2000); // Wait 2 seconds for new content to load
        }
      }, 100); // Scroll every 100ms
    });
  });
}


// --- Start Server ---
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Environment variables check:');
  console.log('- OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Not set');
  console.log('- PINECONE_API_KEY:', process.env.PINECONE_API_KEY ? 'Set' : 'Not set');
  console.log('- GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'Set' : 'Not set');
}); 