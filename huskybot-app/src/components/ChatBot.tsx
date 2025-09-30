import React, { useState, useRef, useEffect } from 'react';
import CustomInput, { CustomInputRef } from './CustomInput';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'bot';
  timestamp: Date;
  sources?: any[];
}

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID as string | undefined;

const ChatBot: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [bottomPad, setBottomPad] = useState<number>(160);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<CustomInputRef>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [popupContent, setPopupContent] = useState<{ title: string; content: string; courseName?: string; date?: string } | null>(null);

  const getNamespace = () => {
    try {
      const val = localStorage.getItem('huskybotUserId');
      if (val && val.trim().length > 0) return val.trim();
      return 'anonymous';
    } catch {
      return 'anonymous';
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: 'nearest' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const measure = () => {
      const h = composerRef.current?.offsetHeight ?? 0;
      setBottomPad(Math.max(120, h + 40));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const fetchFullAnnouncement = async (src: any) => {
    try {
      if (!EXTENSION_ID || !(window as any).chrome?.runtime?.sendMessage) {
        alert('Extension not available to fetch full announcement.');
        return;
      }
      const payload: any = { type: 'GET_ANNOUNCEMENT' };
      if (src.idbKey) payload.idbKey = src.idbKey;
      else {
        payload.courseName = src.courseName;
        payload.title = src.title;
        payload.date = src.date;
      }
      (window as any).chrome.runtime.sendMessage(EXTENSION_ID, payload, (res: any) => {
        const lastError = (window as any).chrome?.runtime?.lastError;
        if (lastError) {
          console.warn('Extension error:', lastError.message);
          alert('Failed to fetch full announcement from extension.');
          return;
        }
        if (res?.success && res.data) {
          const item = res.data;
          setPopupContent({ title: item.title || src.title || 'Announcement', content: item.content || '(no content)', courseName: item.courseName || src.courseName, date: item.date || src.date });
        } else {
          alert('Announcement not found in IndexedDB.');
        }
      });
    } catch (e) {
      console.error('fetchFullAnnouncement error', e);
      alert('Error fetching full announcement.');
    }
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputText,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const currentInputText = inputText;
    setInputText('');
    setIsLoading(true);

    setTimeout(() => inputRef.current?.focus(), 0);

    try {
      const namespace = getNamespace();
      const response = await fetch('https://us-central1-huskybot-dabab.cloudfunctions.net/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: currentInputText, namespace }),
      });

      if (!response.ok) throw new Error('Failed to get response from the chat function');

      const data = await response.json();
      const combinedSources = [...(data.announcements || []), ...(data.clubs || [])];

      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: data.response,
        sender: 'bot',
        timestamp: new Date(),
        sources: combinedSources,
      };

      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      console.error('Error in chat:', error);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        text: "I'm sorry, I encountered an error. Please try again.",
        sender: 'bot',
        timestamp: new Date(),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-card" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      width: '100%',
      position: 'relative',
    }}>
      {/* Scrollable Message Area */}
      <div className="bg-card" style={{
        flex: 1,
        overflowY: 'auto',
        padding: `20px 20px ${bottomPad}px`,
        overscrollBehavior: 'contain',
      }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          {/* Messages */}
          {messages.map((m) => {
            const isUser = m.sender === 'user';
            return (
              <div key={m.id} style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', padding: '1rem 0' }}>
                <div style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', gap: '1rem', maxWidth: '90%' }}>
                  {/* Avatar */}
                  <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: isUser ? 'rgba(74, 144, 226, 0.4)' : 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem', color: 'white' }}>
                    {isUser ? '👤' : '🤖'}
                  </div>
                  {/* Message Bubble */}
                  <div style={{ padding: '1rem', borderRadius: '1rem', background: isUser ? 'rgba(74, 144, 226, 0.2)' : 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.95)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '1rem' }}>
                    {m.text}
                    {!isUser && m.sources && m.sources.length > 0 && (
                      <div style={{ marginTop: 12, fontSize: '0.9rem', color: 'rgba(255,255,255,0.8)', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}>
                        <strong>Sources:</strong>
                        {m.sources.map((s: any, i: number) => (
                          <div key={i} style={{ marginTop: 6, paddingLeft: '1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>- Announcement: {s.courseName || 'Course'} • {s.date || 'Date unknown'} • {s.title || 'Untitled'}</span>
                            <button onClick={() => fetchFullAnnouncement(s)} style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.06)', color: 'white', fontSize: 12, cursor: 'pointer' }}>View</button>
                            {typeof s.score === 'number' && (
                              <span style={{ marginLeft: 'auto', opacity: 0.7, fontSize: 12 }}>Score: {s.score.toFixed(2)}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {isLoading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '1rem 0' }}>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem' }}>🤖</div>
                <div className="typing-indicator" style={{ alignSelf: 'center' }}><span></span><span></span><span></span></div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Simple popup modal */}
      {popupContent && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }} onClick={() => setPopupContent(null)}>
          <div style={{ maxWidth: 720, width: '90%', background: 'rgba(0,0,0,0.9)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 12, padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: 'white', fontSize: 18 }}>{popupContent.title}</h3>
              <button onClick={() => setPopupContent(null)} style={{ border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: 'white', borderRadius: 8, padding: '4px 8px', cursor: 'pointer' }}>Close</button>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginBottom: 8 }}>
              {popupContent.courseName && <div>Course: {popupContent.courseName}</div>}
              {popupContent.date && <div>Date: {popupContent.date}</div>}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 15, whiteSpace: 'pre-wrap' }}>{popupContent.content}</div>
          </div>
        </div>
      )}

      {/* Bottom Input Area */}
      <div ref={composerRef} className="bg-card" style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '14px 12px', width: '100%', borderTop: '1px solid rgba(255,255,255,0.08)', zIndex: 1000 }}>
        <div style={{ maxWidth: 820, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <CustomInput ref={inputRef} value={inputText} onChange={setInputText} placeholder="Message HuskyBot..." onEnterPress={handleSendMessage} autoFocus={true} />
            <button onClick={handleSendMessage} disabled={!inputText.trim() || isLoading} className="modern-button enhanced-button" style={{ width: 80, height: 52, flexShrink: 0 }}>
              Send
            </button>
          </div>
          <div style={{ marginTop: 10, textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            HuskyBot may make mistakes. Consider checking important information.
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatBot; 