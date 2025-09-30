// functions/index.js
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/v2/params");
const logger = require("firebase-functions/logger");

// Import SDKs
const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const OpenAI = require("openai");

// Define the secrets that the function needs access to.
const OPENAI_KEY = defineSecret("OPENAI_KEY");
const PINECONE_KEY = defineSecret("PINECONE_KEY");
const PINECONE_INDEX_NAME = defineSecret("PINECONE_INDEX_NAME");
const GEMINI_KEY = defineSecret("GEMINI_KEY");

// Global clients, initialized once
let pinecone, openai, genAI, geminiModel, pineconeIndex;
let clientsInitialized = false;

// Function to initialize clients to avoid re-initializing on every cold start
function initializeClients() {
  if (clientsInitialized) return;

  const pineconeKey = PINECONE_KEY.value();
  const pineconeIndexName = PINECONE_INDEX_NAME.value();
  const geminiKey = GEMINI_KEY.value();
  const openAIKey = OPENAI_KEY.value();
  
  if (!pineconeKey || !pineconeIndexName || !geminiKey || !openAIKey) {
    logger.error("One or more secret keys are not available.");
    return;
  }
  
  pinecone = new Pinecone({ apiKey: pineconeKey });
  openai = new OpenAI({ apiKey: openAIKey });
  genAI = new GoogleGenerativeAI(geminiKey);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
  pineconeIndex = pinecone.index(pineconeIndexName);
  
  clientsInitialized = true;
  logger.info("AI clients initialized successfully.");
}

/**
 * Main cloud function to process and index announcements.
 */
exports.indexAnnouncement = onRequest(
  // Pass the defined secrets to the function's runtime options
  { secrets: [OPENAI_KEY, PINECONE_KEY, PINECONE_INDEX_NAME, GEMINI_KEY] },
  async (req, res) => {
    // Manually handle CORS
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '3600');
      return res.status(204).send('');
    }

    try {
      // Ensure clients are initialized before use
      initializeClients();
      if (!clientsInitialized) {
        throw new Error("Clients not initialized. Check logs for secret key errors.");
      }

      logger.info("Request received", { body: req.body });
      if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
      
      const { announcementId, courseName, title, date, content } = req.body;
      if (!announcementId || !courseName || !title || !date || !content) {
        return res.status(400).send("Bad Request: Missing required fields.");
      }

      // 1. Summarize content
      const summaryPrompt = `Summarize: Course: ${courseName}, Title: ${title}, Date: ${date}, Content: "${content}"`;
      const summaryResult = await geminiModel.generateContent(summaryPrompt);
      const summary = await summaryResult.response.text();
      logger.info(`Generated summary for ID ${announcementId}`);

      // 2. Create embedding
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: summary,
      });
      const vector = embeddingResponse.data[0].embedding;
      logger.info(`Generated embedding for ID ${announcementId}`);

      // 3. Upsert to Pinecone
      await pineconeIndex.upsert([{
        id: announcementId.toString(),
        values: vector,
        metadata: { courseName, title, date, summary: summary }, // Ensure summary text is stored
      }]);
      logger.info(`Upserted vector to Pinecone for ID ${announcementId}`);

      // 4. Send success response
      res.status(200).send({ message: "Announcement indexed successfully." });

    } catch (error) {
      logger.error(`Error processing ID ${req.body?.announcementId}:`, error);
      res.status(500).send("Internal Server Error");
    }
  }
);
