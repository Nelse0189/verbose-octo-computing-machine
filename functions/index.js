// functions/index.js
const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");
const cors = require("cors")({origin: true});

// Import SDKs
const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Global clients, initialized once
let pinecone, genAI, geminiModel, embeddingModel, pineconeIndex;
let clientsInitialized = false;

// Function to initialize clients to avoid re-initializing on every cold start
function initializeClients() {
  if (clientsInitialized) return;

  const { pinecone_key, pinecone_index_name, gemini_key } = functions.config().keys;
  
  if (!pinecone_key || !pinecone_index_name || !gemini_key) {
    logger.error("One or more secret keys are not available in functions.config(). Make sure you've set them with `firebase functions:config:set keys.pinecone_key=...` etc.");
    return;
  }
  
  pinecone = new Pinecone({ apiKey: pinecone_key });
  genAI = new GoogleGenerativeAI(gemini_key);
  geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
  embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
  pineconeIndex = pinecone.index(pinecone_index_name);
  
  clientsInitialized = true;
  logger.info("AI clients initialized successfully.");
}

/**
 * Main cloud function to process and index announcements.
 */
exports.indexAnnouncement = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
      const embeddingResponse = await embeddingModel.embedContent({
        content: {
          parts: [{ text: summary }],
        },
        outputDimensionality: 512,
      });
      const vector = embeddingResponse.embedding.values;
      logger.info(`Generated embedding for ID ${announcementId}`);

      // 3. Upsert to Pinecone
      await pineconeIndex.upsert([{
        id: announcementId.toString(),
        values: vector,
        metadata: { courseName, title, date, summary },
      }]);
      logger.info(`Upserted vector to Pinecone for ID ${announcementId}`);

      // 4. Send success response
      res.status(200).send({ message: "Announcement indexed successfully." });

    } catch (error) {
      logger.error(`Error processing ID ${req.body?.announcementId}:`, error);
      res.status(500).send("Internal Server Error");
    }
  });
});

exports.queryPinecone = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      initializeClients();
      if (!clientsInitialized) {
        throw new Error("Clients not initialized. Check logs for secret key errors.");
      }

      const { query } = req.body;
      if (!query) {
        return res.status(400).send("Bad Request: Missing query field.");
      }

      // Create embedding for the query
      const embeddingResponse = await embeddingModel.embedContent({
        content: {
          parts: [{ text: query }],
        },
        outputDimensionality: 512,
      });
      const queryVector = embeddingResponse.embedding.values;

      // Query Pinecone
      const queryRequest = {
        topK: 3,
        vector: queryVector,
        includeMetadata: true,
      };
      const queryResult = await pineconeIndex.query(queryRequest);
      
      const matches = queryResult.matches.map(match => ({
        id: match.id,
        score: match.score,
        summary: match.metadata.summary
      }));

      res.status(200).send({ matches });

    } catch (error) {
      logger.error(`Error querying Pinecone:`, error);
      res.status(500).send("Internal Server Error");
    }
  });
});
