# Enhanced Club Search System

This system combines Pinecone vector search with Firebase data retrieval to provide rich context to the LLM for answering questions about UConn clubs.

## How It Works

1. **Query Processing**: User asks a question about clubs
2. **Vector Search**: Query is embedded and searched in Pinecone to find relevant clubs
3. **Data Retrieval**: Full club details are fetched from Firebase using the club IDs
4. **Context Enhancement**: Rich club information is provided to the LLM
5. **Response Generation**: LLM generates a comprehensive response using the detailed context

## Architecture

```
User Query → OpenAI Embedding → Pinecone Search → Firebase Fetch → LLM Context → Response
```

## Key Components

### 1. Enhanced Search Function (`searchClubsInPinecone`)
- Generates embeddings for user queries
- Searches Pinecone for relevant clubs
- Fetches complete club details from Firebase
- Returns rich club information

### 2. Enhanced Response Generation (`generateResponseWithGemini`)
- Uses comprehensive club data from Firebase
- Includes contact information, descriptions, social links
- Provides detailed context to the LLM

### 3. New API Endpoints
- `/api/chat` - Enhanced chat with full club context
- `/api/search-clubs` - Test endpoint for club search

## Setup Instructions

### 1. Environment Variables
Make sure you have these environment variables set in your `.env` file:
```
OPENAI_API_KEY=your_openai_api_key
PINECONE_API_KEY=your_pinecone_api_key
GEMINI_API_KEY=your_gemini_api_key
```

### 2. Install Dependencies
```bash
cd server
npm install
```

### 3. Create Pinecone Index
```bash
node create-pinecone-index.js
```

### 4. Start the Server
```bash
node index.js
```

## Testing the System

### 1. Test Enhanced Search
```bash
node test-enhanced-search.js
```

### 2. Test Chat Endpoint
```bash
node test-chat-endpoint.js
```

### 3. Test via Frontend
Start your frontend application and use the chatbot to ask questions about clubs.

## Example Queries to Test

- "What sports clubs are available?"
- "I want to join an engineering club"
- "Are there any music groups I can join?"
- "Tell me about environmental clubs"
- "What business organizations exist?"
- "I need help finding a club related to computer science"

## Data Flow

1. **User Input**: "What sports clubs are available?"

2. **Pinecone Search**: 
   - Query gets embedded
   - Vector search finds relevant clubs
   - Returns club IDs and basic metadata

3. **Firebase Fetch**:
   - Uses club IDs to fetch complete details
   - Gets descriptions, contact info, social links, etc.

4. **LLM Context**:
   ```
   Club: UConn Men's Basketball Club
   Description: Competitive basketball team for UConn students
   Contact Information:
   - Email: basketball@uconn.edu
   - Phone: (860) 555-0123
   - Address: Gampel Pavilion
   Website: https://uconn.edu/basketball
   Last Updated: 12/15/2024
   ```

5. **Response**: Comprehensive answer with specific club information

## Benefits

- **Rich Context**: LLM has access to complete club information
- **Accurate Responses**: Based on actual club data, not just metadata
- **Contact Information**: Users get direct contact details
- **Up-to-date Data**: Uses latest information from Firebase
- **Scalable**: Can handle large numbers of clubs efficiently

## Troubleshooting

### No Clubs Found
- Check if Pinecone index exists and has data
- Verify Firebase has club documents
- Ensure environment variables are set correctly

### Poor Search Results
- Re-run the Pinecone indexing script
- Check if club descriptions are comprehensive
- Verify embeddings are being generated correctly

### API Errors
- Check server logs for detailed error messages
- Verify all API keys are valid
- Ensure server is running on correct port (8080)

## Future Enhancements

- Add club categories and tags for better search
- Implement fuzzy matching for club names
- Add club activity schedules and events
- Include member testimonials and reviews
- Add club popularity metrics 