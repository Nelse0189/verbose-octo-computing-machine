// server/create-pinecone-index.js

require('dotenv').config(); // Use environment variables for keys
const { Pinecone } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
const admin = require('firebase-admin');

// 1. --- Initialize Services ---
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Make sure to set this!
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY, // Make sure to set this!
});

const PINECONE_INDEX_NAME = 'huskybot-clubs';

// 2. --- Helper function to get embeddings ---
async function getEmbedding(text) {
  if (!text || typeof text !== 'string') {
    console.log("Skipping embedding for invalid text.");
    return null;
  }
  
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.replace(/\n/g, ' '), // Clean up newlines
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error(`Error getting embedding for text: "${text}"`, error);
    throw error;
  }
}

// 3. --- Main execution logic ---
async function main() {
  console.log("Starting indexing process...");

  // Get Pinecone index, or create it if it doesn't exist
  const existingIndexes = await pinecone.listIndexes();
  const indexNames = existingIndexes.indexes.map(index => index.name);
  
  if (!indexNames.includes(PINECONE_INDEX_NAME)) {
    console.log(`Creating new Pinecone index: "${PINECONE_INDEX_NAME}"`);
    await pinecone.createIndex({
      name: PINECONE_INDEX_NAME,
      dimension: 1536, // Dimension for text-embedding-3-small
      metric: 'cosine',
      spec: { 
	      serverless: { 
	        cloud: 'aws', 
	        region: 'us-east-1' 
	      } 
	    } 
    });
  }
  const index = pinecone.index(PINECONE_INDEX_NAME);

  // Get all clubs from Firestore
  console.log("Fetching clubs from Firestore...");
  const clubsSnapshot = await db.collection('clubs').get();
  if (clubsSnapshot.empty) {
    console.log("No clubs found in Firestore. Exiting.");
    return;
  }
  
  console.log(`Found ${clubsSnapshot.docs.length} clubs to process.`);
  
  // Create vectors in batches
  const batchSize = 100;
  for (let i = 0; i < clubsSnapshot.docs.length; i += batchSize) {
    const batch = clubsSnapshot.docs.slice(i, i + batchSize);
    console.log(`--- Processing batch ${i / batchSize + 1} ---`);
    
    const vectorsToUpsert = [];
    for (const doc of batch) {
      const club = doc.data();
      const textToEmbed = `${club.name}\n${club.description || ''}\n${club.summary || ''}`;
      
      const embedding = await getEmbedding(textToEmbed);
      
      if (embedding) {
        vectorsToUpsert.push({
          id: doc.id.replace(/[^a-zA-Z0-9_-]/g, '_'), // Sanitize ID to ASCII only
          values: embedding,
          metadata: {
            name: club.name,
            description: club.description || '',
            summary: club.summary || '',
            url: club.url || '',
            firestoreId: doc.id // Keep original ID in metadata
          }
        });
      }
    }

    if (vectorsToUpsert.length > 0) {
      console.log(`Upserting ${vectorsToUpsert.length} vectors to Pinecone...`);
      await index.upsert(vectorsToUpsert);
    }
  }

  console.log("✅ Indexing process complete!");
}

main().catch(console.error);