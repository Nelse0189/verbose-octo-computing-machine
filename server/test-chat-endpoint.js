// server/test-chat-endpoint.js

require('dotenv').config();
const fetch = require('node-fetch');

const SERVER_URL = 'http://localhost:8080';

async function testChatEndpoint(query) {
  console.log(`\n🤖 Testing chat endpoint with query: "${query}"`);
  console.log('=' .repeat(60));

  try {
    const response = await fetch(`${SERVER_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: query }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    console.log('✅ Response received successfully');
    console.log('\n📝 AI Response:');
    console.log('-' .repeat(40));
    console.log(data.response);
    
    if (data.clubs && data.clubs.length > 0) {
      console.log('\n🏛️ Clubs Used for Context:');
      console.log('-' .repeat(40));
      data.clubs.forEach((club, index) => {
        console.log(`${index + 1}. ${club.name}`);
        if (club.email) console.log(`   Email: ${club.email}`);
        if (club.phone) console.log(`   Phone: ${club.phone}`);
        if (club.url) console.log(`   Website: ${club.url}`);
        if (club.description) {
          const desc = club.description.length > 100 
            ? club.description.substring(0, 100) + '...' 
            : club.description;
          console.log(`   Description: ${desc}`);
        }
        console.log('');
      });
    } else {
      console.log('\n❌ No clubs found for this query');
    }

    return data;

  } catch (error) {
    console.error('❌ Error testing chat endpoint:', error);
    return null;
  }
}

async function runChatTests() {
  console.log('🚀 Testing Enhanced Chat System with Pinecone + Firebase');
  console.log('=' .repeat(60));

  const testQueries = [
    'What sports clubs are available?',
    'I want to join an engineering club',
    'Are there any music groups I can join?',
    'Tell me about environmental clubs',
    'What business organizations exist?',
    'I need help finding a club related to computer science'
  ];

  for (const query of testQueries) {
    await testChatEndpoint(query);
    console.log('\n' + '=' .repeat(60));
    
    // Add a small delay between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('✅ All chat tests completed');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runChatTests().catch(console.error);
}

module.exports = { testChatEndpoint }; 