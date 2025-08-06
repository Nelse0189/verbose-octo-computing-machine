import React, { useState, useRef, useEffect } from 'react';
import { openDB } from 'idb';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
  clubs?: Club[]; // Add clubs to message interface
  sources?: any[];
}

interface Club {
  name: string;
  description?: string;
  summary?: string;
  url?: string;
  email?: string;
  phone?: string;
  address?: string;
  socialLinks?: string[];
}

const DB_NAME = 'HuskyHelperDB';
const ANNOUNCEMENT_STORE = 'announcements';

async function getDb() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(ANNOUNCEMENT_STORE)) {
        db.createObjectStore(ANNOUNCEMENT_STORE, { keyPath: 'id' });
      }
    },
  });
}

async function getAnnouncementById(id: string) {
  const db = await getDb();
  return db.get(ANNOUNCEMENT_STORE, id);
}

const ChatBot: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: "Hi! I'm your UConn club assistant. I can help you find clubs, learn about their activities, and get contact information. What would you like to know?",
      sender: 'bot',
      timestamp: new Date()
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessageToServer = async (userMessage: string): Promise<{ response: string; clubs: Club[] }> => {
    try {
      const response = await fetch('http://localhost:8080/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response from server');
      }

      const data = await response.json();
      return { response: data.response, clubs: data.clubs || [] };
    } catch (error) {
      console.error('Error sending message to server:', error);
      return { 
        response: "I'm sorry, I'm having trouble connecting to the server right now. Please try again later.",
        clubs: []
      };
    }
  };

  const queryPinecone = async (query: string) => {
    try {
      const response = await fetch('https://us-central1-huskybot-dabab.cloudfunctions.net/queryPinecone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        throw new Error('Failed to get response from Pinecone query function');
      }
      const data = await response.json();
      return data.matches;
    } catch (error) {
      console.error('Error querying Pinecone:', error);
      return [];
    }
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputText,
      sender: 'user',
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInputText = inputText;
    setInputText('');
    setIsLoading(true);

    try {
      // RAG Flow
      // 1. Query Pinecone to get relevant announcement IDs
      const matches = await queryPinecone(currentInputText);
      const relevantIds = matches.map((match: any) => match.id);
      
      // 2. Retrieve full content from IndexedDB
      const announcements = await Promise.all(relevantIds.map(getAnnouncementById));
      const validAnnouncements = announcements.filter(Boolean);

      // 3. Construct a new, context-rich prompt
      let context = "Relevant announcements:\n";
      if (validAnnouncements.length > 0) {
        context += validAnnouncements.map(ann => ann.content).join("\n\n---\n\n");
      } else {
        context = "No relevant announcements found.";
      }
      
      const enrichedPrompt = `Based on the following context, answer the user's question.
Context:
${context}

User's question: ${currentInputText}`;

      // 4. Send the enriched prompt to the LLM
      const { response: botResponse, clubs } = await sendMessageToServer(enrichedPrompt);

      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: botResponse,
        sender: 'bot',
        timestamp: new Date(),
        clubs: clubs,
        sources: matches
      };

      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      console.error('Error in chat:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: "I'm sorry, I encountered an error while processing your request. Please try again.",
        sender: 'bot',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="chatbot-container" style={{
      width: '100%',
      maxWidth: '600px',
      height: '500px',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(255, 255, 255, 0.1)',
      backdropFilter: 'blur(20px)',
      borderRadius: '16px',
      border: '2px solid rgba(255, 255, 255, 0.2)',
      overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        background: 'linear-gradient(135deg, rgba(74, 144, 226, 0.2), rgba(0, 102, 204, 0.3))',
        borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
      }}>
        <h3 style={{
          margin: 0,
          color: 'white',
          fontSize: '18px',
          fontWeight: '600'
        }}>
          🤖 UConn Club Assistant
        </h3>
        <p style={{
          margin: '4px 0 0 0',
          color: 'rgba(255, 255, 255, 0.8)',
          fontSize: '14px'
        }}>
          Ask me about clubs, activities, and more!
        </p>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {messages.map((message) => (
          <div key={message.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: message.sender === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: '8px'
              }}
            >
              <div style={{
                maxWidth: '80%',
                padding: '12px 16px',
                borderRadius: '18px',
                background: message.sender === 'user' 
                  ? 'linear-gradient(135deg, rgba(74, 144, 226, 0.8), rgba(0, 102, 204, 0.9))'
                  : 'rgba(255, 255, 255, 0.15)',
                color: 'white',
                fontSize: '14px',
                lineHeight: '1.4',
                wordWrap: 'break-word'
              }}>
                {message.text}
              </div>
            </div>
            
            {/* Display clubs if available */}
            {message.sender === 'bot' && message.clubs && message.clubs.length > 0 && (
              <div style={{
                display: 'flex',
                justifyContent: 'flex-start',
                marginBottom: '8px'
              }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  fontSize: '12px',
                  color: 'rgba(255, 255, 255, 0.8)'
                }}>
                  <div style={{ marginBottom: '4px', fontWeight: '600' }}>
                    📋 Found {message.clubs.length} relevant club(s):
                  </div>
                  {message.clubs.map((club, index) => (
                    <div key={index} style={{ marginBottom: '4px' }}>
                      <strong>{club.name}</strong>
                      {club.email && <div>📧 {club.email}</div>}
                      {club.url && (
                        <div>
                          🌐 <a 
                            href={club.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{ color: 'rgba(255, 255, 255, 0.9)', textDecoration: 'underline' }}
                          >
                            Visit Website
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Display sources if available */}
            {message.sender === 'bot' && message.sources && message.sources.length > 0 && (
              <div style={{
                display: 'flex',
                justifyContent: 'flex-start',
                marginTop: '8px',
              }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  fontSize: '12px',
                  color: 'rgba(255, 255, 255, 0.8)'
                }}>
                  <div style={{ marginBottom: '4px', fontWeight: '600' }}>
                    📚 Sources:
                  </div>
                  {message.sources.map((source, index) => (
                    <div key={index} style={{ marginBottom: '4px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                      <strong>Summary:</strong> {source.summary} (Score: {source.score.toFixed(2)})
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
        
        {isLoading && (
          <div style={{
            display: 'flex',
            justifyContent: 'flex-start',
            marginBottom: '8px'
          }}>
            <div style={{
              padding: '12px 16px',
              borderRadius: '18px',
              background: 'rgba(255, 255, 255, 0.15)',
              color: 'white',
              fontSize: '14px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                Thinking...
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid rgba(255, 255, 255, 0.1)',
        background: 'rgba(255, 255, 255, 0.05)'
      }}>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-end'
        }}>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask me about UConn clubs..."
            disabled={isLoading}
            style={{
              flex: 1,
              minHeight: '40px',
              maxHeight: '120px',
              padding: '12px 16px',
              borderRadius: '20px',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              background: 'rgba(255, 255, 255, 0.1)',
              color: 'white',
              fontSize: '14px',
              resize: 'none',
              outline: 'none',
              fontFamily: 'inherit'
            }}
          />
          <button
            onClick={handleSendMessage}
            disabled={!inputText.trim() || isLoading}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              border: 'none',
              background: inputText.trim() && !isLoading 
                ? 'linear-gradient(135deg, rgba(74, 144, 226, 0.8), rgba(0, 102, 204, 0.9))'
                : 'rgba(255, 255, 255, 0.2)',
              color: 'white',
              cursor: inputText.trim() && !isLoading ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '16px',
              transition: 'all 0.2s ease'
            }}
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatBot; 