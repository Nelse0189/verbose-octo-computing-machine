// server/test-enhanced-search.js

require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
const { OpenAI } = require('openai');
const admin = require('firebase-admin');

// Initialize services
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// Test the enhanced search functionality
async function testEnhancedSearch(query) {
  console.log(`\n🔍 Testing enhanced search for: "${query}"`);
  console.log('=' .repeat(50));

  try {
    const index = pinecone.index('huskybot-clubs');
    
    // Get embedding for the query
    console.log('1. Generating embedding for query...');
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query.replace(/\n/g, ' '),
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;
    console.log('✅ Embedding generated');

    // Search Pinecone
    console.log('2. Searching Pinecone for relevant clubs...');
    const searchResponse = await index.query({
      vector: queryEmbedding,
      topK: 5,
      includeMetadata: true
    });

    console.log(`✅ Found ${searchResponse.matches?.length || 0} matches in Pinecone`);

    // Extract Firestore IDs
    const firestoreIds = searchResponse.matches
      ?.map(match => match.metadata?.firestoreId)
      .filter(id => id) || [];

    console.log(`3. Fetching full details for ${firestoreIds.length} clubs from Firebase...`);

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
        console.error(`❌ Error fetching club ${firestoreId} from Firebase:`, error);
      }
    }

    console.log(`✅ Successfully fetched ${clubsWithFullDetails.length} clubs with full details`);

    // Display results
    console.log('\n📋 RESULTS:');
    console.log('=' .repeat(50));
    
    if (clubsWithFullDetails.length === 0) {
      console.log('❌ No relevant clubs found');
      return;
    }

    clubsWithFullDetails.forEach((club, index) => {
      console.log(`\n${index + 1}. ${club.name}`);
      console.log(`   Description: ${club.description || 'No description'}`);
      console.log(`   Summary: ${club.summary || 'No summary'}`);
      console.log(`   Email: ${club.email || 'No email'}`);
      console.log(`   Phone: ${club.phone || 'No phone'}`);
      console.log(`   Address: ${club.address || 'No address'}`);
      console.log(`   Website: ${club.url || 'No website'}`);
      if (club.socialLinks && club.socialLinks.length > 0) {
        console.log(`   Social Links: ${club.socialLinks.join(', ')}`);
      }
      console.log(`   Last Updated: ${club.scrapedAt ? new Date(club.scrapedAt.toDate()).toLocaleDateString() : 'Unknown'}`);
    });

    return clubsWithFullDetails;

  } catch (error) {
    console.error('❌ Error during enhanced search:', error);
    return [];
  }
}

// Test with different queries
async function runTests() {
  console.log('🚀 Testing Enhanced Club Search System');
  console.log('=' .repeat(50));

  const testQueries = [
    'sports clubs',
    'engineering organizations',
    'music groups',
    'environmental clubs',
    'business clubs'
  ];

  for (const query of testQueries) {
    await testEnhancedSearch(query);
    console.log('\n' + '=' .repeat(50));
  }

  console.log('✅ All tests completed');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testEnhancedSearch }; 