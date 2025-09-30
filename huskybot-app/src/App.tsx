import { useState, useEffect, useRef } from 'react';
import useWebSocket, { ReadyState } from 'react-use-websocket';
import logo from './assets/logo.png';
import logoDark from './assets/logo_dark.png';
import { useTheme } from './contexts/ThemeProvider';
import CustomInput from './components/CustomInput';
import AuthModal from './components/AuthModal';
import ChatBot from './components/ChatBot';
import DiningHallMenu from './components/Menu';
import CalendarView from './components/CalendarView';
import SavedDataView from './components/SavedDataView';
import { useAuth } from './contexts/AuthContext';
import { Button } from './components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetFooter } from './components/ui/sheet';
import { initDB, saveCourseMaterial, saveAnnouncements, CourseData } from './lib/idb'; // Import IndexedDB helpers
import { ThemeToggle } from './components/ThemeToggle';
import './App.css';

const WEBSOCKET_URL = 'ws://localhost:8080';
const WS_ENABLED = (import.meta as any).env?.VITE_WS_ENABLED === 'true';

// Sidebar component
const Sidebar = ({
  onOpenChat,
  onOpenMenu,
  onLogout,
  onShowAuthModal,
  onOpenCalendar,
  onOpenSaved,
  currentUser,
  connectionStatus,
  readyState,
}: {
  onOpenChat: () => void;
  onOpenMenu: () => void;
  onLogout: () => void;
  onShowAuthModal: () => void;
  onOpenCalendar: () => void;
  onOpenSaved: () => void;
  currentUser: any;
  connectionStatus: string;
  readyState: ReadyState;
}) => {
  const { theme } = useTheme();
  const [isOpen, setIsOpen] = useState(false); // Internal state for the sheet
  const { sendJsonMessage } = useWebSocket(WS_ENABLED ? WEBSOCKET_URL : null, {
    share: true,
    shouldReconnect: () => WS_ENABLED,
  });

  const handleScrapeClubs = () => {
    console.log('Requesting to scrape clubs...');
    sendJsonMessage({ type: 'scrapeClubs', url: 'https://uconntact.uconn.edu/organizations' });
    setIsOpen(false); // Close sidebar
  };

  // Wrapper functions to close sidebar on action
  const handleOpenChat = () => { onOpenChat(); setIsOpen(false); };
  const handleOpenMenu = () => { onOpenMenu(); setIsOpen(false); };
  const handleLogout = () => { onLogout(); setIsOpen(false); };
  const handleShowAuthModal = () => { onShowAuthModal(); setIsOpen(false); };
  const handleOpenCalendar = () => { onOpenCalendar(); setIsOpen(false); };
  const handleOpenSaved = () => { onOpenSaved(); setIsOpen(false); };

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          className="fixed top-5 left-5 h-auto p-0 bg-transparent z-[1000]"
        >
          <img
            src={theme === 'light' ? logoDark : logo}
            alt="HuskyBot Logo"
            className="h-14 w-auto block rounded-lg"
          />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex flex-col bg-card text-card-foreground">
        <SheetHeader>
          <SheetTitle>HuskyBot Menu</SheetTitle>
        </SheetHeader>
        <div className="flex-grow grid gap-4 py-4">
          <Button variant="outline" onClick={handleScrapeClubs}>Scrape Clubs</Button>
          <Button variant="outline" onClick={handleOpenChat}>Chat with AI</Button>
          <Button variant="outline" onClick={handleOpenMenu}>Dining Hall Menu</Button>
          <Button variant="outline">Dashboard</Button>
          <Button variant="outline" onClick={handleOpenCalendar}>Calendar</Button>
          <Button variant="outline" onClick={handleOpenSaved}>Saved Data</Button>
        </div>
        <SheetFooter className="mt-auto">
          <div className="w-full">
            <div className="flex justify-between items-center w-full mb-4">
              <Button variant="ghost" size="sm" onClick={() => console.log('Info clicked')}>Info</Button>
              <Button variant="ghost" size="sm" onClick={() => console.log('Settings clicked')}>Settings</Button>
              {currentUser ? (
                <Button variant="ghost" size="sm" onClick={handleLogout}>Logout</Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={handleShowAuthModal}>Sign In</Button>
              )}
            </div>
            <div
              className={`h-10 px-4.5 rounded-lg flex items-center justify-center gap-2.5 ${
                readyState === ReadyState.OPEN
                  ? 'bg-blue-500/20 border-2 border-blue-500/40 text-foreground'
                  : 'bg-red-500/20 border-2 border-red-500/40 text-foreground'
              }`}
            >
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  readyState === ReadyState.OPEN ? 'bg-blue-600' : 'bg-red-600'
                }`}
                style={{
                  animation: readyState === ReadyState.OPEN ? 'bluePulse 2s infinite' : 'none',
                }}
              />
              {connectionStatus}
            </div>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

// Loading component with UConn colors
const LoadingComponent = ({ message, showSpinner = true }: { message: string; showSpinner?: boolean }) => {
  const [dots, setDots] = useState('');

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => {
        if (prev === '...') return '';
        return prev + '.';
      });
    }, 500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center gap-5 p-6 opacity-100 transition-opacity duration-800 ease-in-out delay-400">
      {/* Spinner with UConn colors */}
      {showSpinner && (
        <div className="uconn-spinner w-8 h-8" />
      )}

      {/* Main loading message */}
      <div className="text-center text-foreground/90 text-base font-medium tracking-tight">
        {message}{dots}
      </div>

      {/* Progress bar with UConn colors */}
      {showSpinner && (
        <div className="w-full h-1 bg-primary/30 rounded-full overflow-hidden relative">
          <div className="uconn-progress h-full rounded-full w-full -translate-x-full" />
        </div>
      )}

      {/* Additional info */}
      {showSpinner && (
        <div className="text-center text-muted-foreground text-xs font-normal italic">
          This may take a few moments depending on server response...
        </div>
      )}
    </div>
  );
};

function App() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('Please enter your HuskyCT credentials to begin.');
  const [scrapedData, setScrapedData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [duoCode, setDuoCode] = useState('');
  const [backendMessage, setBackendMessage] = useState('');
  const [showChatBot, setShowChatBot] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  
  // WebSocket connection
  const { sendJsonMessage, lastJsonMessage, readyState } = useWebSocket(WS_ENABLED ? WEBSOCKET_URL : null, {
    shouldReconnect: () => WS_ENABLED,
    share: true,
  });

  // Authentication
  const { currentUser, logout } = useAuth();

  // Animation sequence
  useEffect(() => {
    const timer1 = setTimeout(() => setIsInfoButtonVisible(true), 200);
    const timer2 = setTimeout(() => setIsMainComponentVisible(true), 400);
    const timer3 = setTimeout(() => setIsTextVisible(true), 800);
    
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, []);
  
  // Animation states
  const [isInfoButtonVisible, setIsInfoButtonVisible] = useState(false);
  const [isMainComponentVisible, setIsMainComponentVisible] = useState(false);
  const [isTextVisible, setIsTextVisible] = useState(false);
  
  // Final, correct state for the typewriter
  const [displayText, setDisplayText] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [isTypewriterComplete, setIsTypewriterComplete] = useState(false);
  const measureRef = useRef<HTMLSpanElement>(null);

  // New state to manage which view is active
  const [activeView, setActiveView] = useState('intro'); // 'intro', 'login', 'chat', 'menu', 'calendar', 'saved'

  useEffect(() => {
    // This effect now correctly handles the initial state
    if (activeView === 'login') {
      if (message === 'Please enter your HuskyCT credentials to begin.') {
        setIsTyping(false);
        setIsTypewriterComplete(true);
        setDisplayText(message);
        if (measureRef.current) {
          measureRef.current.textContent = message;
          setCursorPosition(measureRef.current.offsetWidth);
        }
      } else {
        setIsTyping(true);
        setIsTypewriterComplete(false);
      }
    } else {
      setIsTyping(false);
      setIsTypewriterComplete(true);
    }
  }, [activeView, isLoading, message]);
  
  useEffect(() => {
    if (!isTyping) {
      setDisplayText(message);
      // Position cursor at the end of the initial message
      if (measureRef.current) {
         measureRef.current.textContent = message;
         setCursorPosition(measureRef.current.offsetWidth);
      }
      setIsTypewriterComplete(true);
      return;
    };

    const fullMessage = message;
    let animationId: number;
    let targetChars = 0;
    let displayedChars = 0;
    let targetCursorX = 0;
    let currentCursorX = 0;
    const startTime = performance.now();

    const type = () => {
      const elapsed = performance.now() - startTime;
      
      let timeAccumulator = 0;
      let newTargetChars = 0;
      for (let i = 0; i < fullMessage.length; i++) {
        const char = fullMessage[i];
        let charDelay = 40;
        if (char === ' ') charDelay = 20;
        else if ('.!'.includes(char)) charDelay = 100;
        else if (char.toUpperCase() === char && char.match(/[A-Z]/)) charDelay = 50;
        timeAccumulator += charDelay;
        if (elapsed >= timeAccumulator) {
          newTargetChars = i + 1;
        } else {
          break;
        }
      }
      targetChars = Math.min(newTargetChars, fullMessage.length);

      displayedChars += (targetChars - displayedChars) * 0.15;
      const wholeChars = Math.floor(displayedChars);
      const currentText = fullMessage.slice(0, wholeChars);

      if (measureRef.current) {
        measureRef.current.textContent = currentText;
        targetCursorX = measureRef.current.offsetWidth;
      }

      currentCursorX += (targetCursorX - currentCursorX) * 0.2;

      let newDisplayText = currentText;
      const fractionalPart = displayedChars - wholeChars;
      if (wholeChars < fullMessage.length && fractionalPart > 0.1) {
        const nextChar = fullMessage[wholeChars];
        const opacity = Math.min(fractionalPart * 3, 1);
        newDisplayText += `<span style="opacity: ${opacity.toFixed(3)};">${nextChar}</span>`;
      }

      setDisplayText(newDisplayText);
      setCursorPosition(currentCursorX);

      if (displayedChars < fullMessage.length - 0.01) {
        animationId = requestAnimationFrame(type);
      } else {
        setDisplayText(fullMessage);
         if (measureRef.current) {
            measureRef.current.textContent = fullMessage;
            setCursorPosition(measureRef.current.offsetWidth);
         }
        setIsTyping(false);
        setIsTypewriterComplete(true);
      }
    };

    const timer = setTimeout(type, 1200);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(animationId);
    };
  }, [isTyping, message]);
  
  const connectionStatus = WS_ENABLED
    ? ({
        [ReadyState.CONNECTING]: 'Connecting',
        [ReadyState.OPEN]: 'Connected to server',
        [ReadyState.CLOSING]: 'Closing',
        [ReadyState.CLOSED]: 'Disconnected from server',
        [ReadyState.UNINSTANTIATED]: 'Uninstantiated',
      } as Record<ReadyState, string>)[readyState]
    : 'Offline';

  useEffect(() => {
    if (lastJsonMessage) {
      const { type, code, message: msg, data } = lastJsonMessage as { type: string; code?: string; message: string; data?: any; };
      
      if (type === 'duo_passcode') {
        setDuoCode(code);
      } else if (type === 'message') {
        setBackendMessage(msg);
        if (activeView === 'login') {
          setMessage(msg);
        }
      } else if (type === 'error') {
        setMessage(msg);
        setIsLoading(false);
        setBackendMessage('');
      } else if (type === 'clientjs_error' || type === 'credential_error') {
        // Handle ClientJS errors and credential errors specifically
        setMessage(msg);
        setIsLoading(false);
        setBackendMessage('');
        setDuoCode('');
        setScrapedData(null);
        // Clear the input fields to prompt user to re-enter credentials
        setUsername('');
        setPassword('');
      } else if (type === 'data') {
        setScrapedData(data);
        setIsLoading(false);
        setBackendMessage('');

        // NEW: Handle the detailed course data structure
        if (data && data.allCourses && data.username) {
            console.log(`[App.tsx] Received full course data from server for user ${data.username}:`, data.allCourses);
            
            // Save course materials
            const materialPromises = data.allCourses.flatMap((course: any) => 
                course.materials.map(material => saveCourseMaterial(course.courseName, material))
            );

            // Save course announcements
            const announcementPromises = data.allCourses
                .filter((course: any) => course.announcements && course.announcements.length > 0)
                .map((course: any) => saveAnnouncements(course.courseName, course.announcements));

            Promise.all([...materialPromises, ...announcementPromises])
                .then(() => {
                    const materialCount = data.allCourses.reduce((acc, course) => acc + (course.materials?.length || 0), 0);
                    const announcementCount = data.allCourses.reduce((acc, course) => acc + (course.announcements?.length || 0), 0);
                    const courseCount = data.allCourses.length;
                    
                    console.log(`All ${materialCount} materials and ${announcementCount} announcements from ${courseCount} courses saved locally!`);
                    setMessage(`Successfully saved ${materialCount} materials and ${announcementCount} announcements from ${courseCount} courses.`);
                })
                .catch(err => {
                    console.error('Failed to save one or more items locally:', err);
                    setMessage('Could not save all course data to your device.');
                });
        } else {
          console.log('[App.tsx] Received "data" message, but it was missing the expected allCourses structure or the username.');
        }
      }
    }
  }, [lastJsonMessage, activeView]); // Removed username from dependency array

  useEffect(() => {
    initDB(); // Initialize the DB when the app loads
  }, []);

  // If the extension id is already known, drop user into Saved view automatically
  useEffect(() => {
    try {
      const extId = localStorage.getItem('huskybot_extension_id');
      if (extId) setActiveView('saved');
    } catch {}
  }, []);

  // Parse URL params e.g. ?ext=<extensionId> and auto-open Saved view
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ext = params.get('ext');
      const view = params.get('view');
      if (ext) {
        localStorage.setItem('huskybot_extension_id', ext);
        setActiveView('saved');
      } else if (view === 'saved') {
        setActiveView('saved');
      }
    } catch {}
  }, []);

  const handleScrape = async () => {
    setIsLoading(true);
    setScrapedData(null);
    setDuoCode('');
    setBackendMessage('');
    setMessage('Starting scraping process...');

    sendJsonMessage({
      type: 'scrape',
      username,
      password,
    });
  };

  const handleContinueAfterDuo = () => {
    sendJsonMessage({ type: 'continueAfterDuo' });
    // Keep isLoading true, but maybe change the message
    setMessage('Continuing scraping process...');
  };

  // Determine what message to show
  const getDisplayMessage = () => {
      return isLoading ? (backendMessage || message) : displayText;
  };
  
  const shouldShowSpinner = isLoading && !duoCode;

  // Function to handle opening the chat
  const handleOpenChat = () => {
    setActiveView('chat');
    setShowChatBot(false);
  };

  const handleOpenMenu = () => {
    setActiveView('menu');
  };

  const handleOpenCalendar = () => {
    setActiveView('calendar');
  };

  const handleOpenSaved = () => {
    setActiveView('saved');
  };

  const handleLogout = async () => {
    try {
      await logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const handleShowAuthModal = () => {
    setShowAuthModal(true);
  }

  const getContainerStyle = (view: string) => {
    const baseClasses = "w-full flex flex-col transition-transform duration-600 ease-[cubic-bezier(0.34,1.56,0.64,1)] p-6 rounded-2xl";
    const visibleClass = isMainComponentVisible ? 'scale-100' : 'scale-0';

    if (view === 'menu' || view === 'saved' || view === 'calendar') {
      return `${baseClasses} ${visibleClass} max-w-[95vw] bg-transparent border-none shadow-none p-0 gap-0`;
    }

    if (view === 'intro') {
      return `${baseClasses} ${visibleClass} max-w-4xl bg-transparent border-none shadow-none gap-4`;
    }

    // Default (login view)
    return `${baseClasses} ${visibleClass} max-w-lg bg-card/80 backdrop-blur-xl border-2 border-border shadow-lg gap-7`;
  };

  const renderContent = () => {
    switch (activeView) {
      case 'intro':
        return (
          <div className="w-full pb-24 space-y-4">
            {/* Hero Section */}
            <div className={`opacity-0 transition-opacity duration-800 ease-in-out delay-200 mt-10 ${isTextVisible ? 'opacity-100' : ''}`}>
              <h1 className="text-4xl font-extrabold m-0 mb-2 tracking-tighter leading-tight bg-gradient-to-r from-foreground to-foreground/80 text-transparent bg-clip-text">
                {currentUser ? `Welcome back, ${currentUser.displayName || 'User'}!` : 'Welcome to HuskyBot'}
              </h1>
              <p className="text-base text-muted-foreground m-0 mb-4 font-normal leading-normal">
                Your intelligent academic assistant powered by AI
              </p>
            </div>

            {/* Features Grid */}
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-3.5 my-1 opacity-0 transition-opacity duration-800 ease-in-out delay-400 ${isTextVisible ? 'opacity-100' : ''}`}>
              {/* Feature 1 */}
              <div className="p-3.5 rounded-lg bg-card/50 border border-border text-left">
                <div className="text-xl mb-1.5">🤖</div>
                <h3 className="text-sm font-semibold m-0 mb-1 text-card-foreground">
                  AI-Powered Data Parsing
                </h3>
                <p className="text-xs text-muted-foreground m-0 leading-snug">
                  Automatically extracts and organizes your HuskyCT course data using advanced artificial intelligence
                </p>
              </div>

              {/* Feature 2 */}
              <div className="p-3.5 rounded-lg bg-card/50 border border-border text-left">
                <div className="text-xl mb-1.5">📅</div>
                <h3 className="text-sm font-semibold m-0 mb-1 text-card-foreground">
                  Intelligent Calendar
                </h3>
                <p className="text-xs text-muted-foreground m-0 leading-snug">
                  Get a personalized daily agenda with all assignments, deadlines, and class activities organized intelligently
                </p>
              </div>

              {/* Feature 3 */}
              <div className="p-3.5 rounded-lg bg-card/50 border border-border text-left">
                <div className="text-xl mb-1.5">📋</div>
                <h3 className="text-sm font-semibold m-0 mb-1 text-card-foreground">
                  Daily Feed
                </h3>
                <p className="text-xs text-muted-foreground m-0 leading-snug">
                  Never miss important tasks with a curated feed of everything you need to do for the day across all classes
                </p>
              </div>

              {/* Feature 4 */}
              <div className="p-3.5 rounded-lg bg-card/50 border border-border text-left">
                <div className="text-xl mb-1.5">💬</div>
                <h3 className="text-sm font-semibold m-0 mb-1 text-card-foreground">
                  AI Chat Assistant
                </h3>
                <p className="text-xs text-muted-foreground m-0 leading-snug">
                  Chat with an AI that has access to all your assignments and course materials for instant help
                </p>
              </div>
            </div>

            {/* How it Works */}
            <div className={`p-4 rounded-lg bg-gradient-to-r from-blue-500/20 to-blue-600/30 border border-blue-500/40 text-left opacity-0 transition-opacity duration-800 ease-in-out delay-600 ${isTextVisible ? 'opacity-100' : ''}`}>
              <h3 className="text-base font-semibold m-0 mb-2 text-foreground/95 text-center">
                How HuskyBot Works
              </h3>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-4.5 h-4.5 rounded-full bg-foreground/30 flex items-center justify-center text-xs font-semibold">1</div>
                  <span className="text-foreground/90 text-sm">
                    Securely connect to your HuskyCT account
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4.5 h-4.5 rounded-full bg-foreground/30 flex items-center justify-center text-xs font-semibold">2</div>
                  <span className="text-foreground/90 text-sm">
                    AI analyzes and organizes your course data
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4.5 h-4.5 rounded-full bg-foreground/30 flex items-center justify-center text-xs font-semibold">3</div>
                  <span className="text-foreground/90 text-sm">
                    Get your personalized academic dashboard
                  </span>
                </div>
              </div>
            </div>

            {/* Privacy Notice */}
            <div className={`p-3 rounded-lg bg-card/20 border border-border/50 opacity-0 transition-opacity duration-800 ease-in-out delay-700 ${isTextVisible ? 'opacity-100' : ''}`}>
              <p className="text-xs text-muted-foreground m-0 leading-snug text-center">
                🔒 <strong>Privacy First:</strong> Your credentials are never stored. All data stays on your device. 
                HuskyBot only accesses your course information to provide you with a better academic experience.
              </p>
            </div>
          </div>
        );
      case 'login':
        return (
          <>
            <div className={`opacity-0 transition-opacity duration-800 ease-in-out delay-200 ${isTextVisible ? 'opacity-100' : ''}`}>
              <h1 className="text-4xl font-bold m-0 mb-2.5 tracking-tighter leading-snug bg-gradient-to-r from-foreground to-foreground/80 text-transparent bg-clip-text">
                HuskyBot Scraper
              </h1>
              <p className="text-muted-foreground m-0 mb-1.5 text-base font-medium">
                {connectionStatus}
              </p>
              <p className="text-foreground/90 m-0 text-base font-normal min-h-[23px] relative">
                <span 
                  className="typewriter-measure" 
                  ref={measureRef} 
                  style={{
                     fontSize: '15px',
                     fontWeight: '400',
                     fontFamily: `'Inter', sans-serif`,
                  }}
                />
                <span dangerouslySetInnerHTML={{ __html: getDisplayMessage() }} />
                {!isLoading && isTyping && !isTypewriterComplete && (
                  <span 
                    className="custom-smooth-cursor"
                    style={{ transform: `translateX(${cursorPosition}px)` }}
                  />
                )}
              </p>
            </div>

            {duoCode && (
              <div className={`duo-code-container opacity-0 transition-opacity duration-800 ease-in-out delay-400 ${isTextVisible ? 'opacity-100' : ''}`}>
                <h2 className="text-lg font-semibold m-0 mb-4 tracking-tight text-foreground/90">
                  Duo Passcode:
                </h2>
                <div className="duo-code">{duoCode}</div>
                <button
                  onClick={handleContinueAfterDuo}
                  className="modern-button enhanced-button mt-4"
                >
                  Continue After Duo Approval
                </button>
              </div>
            )}

            {!isLoading && !scrapedData && (
              <form onSubmit={(e) => { e.preventDefault(); handleScrape(); }} className={`flex flex-col gap-4.5 opacity-0 transition-opacity duration-800 ease-in-out delay-500 ${isTextVisible ? 'opacity-100' : ''}`}>
                <CustomInput
                  placeholder="NetID"
                  value={username}
                  onChange={setUsername}
                  onEnterPress={handleScrape}
                />
                <CustomInput
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={setPassword}
                  onEnterPress={handleScrape}
                />
                <button
                  type="submit"
                  disabled={isLoading || !username || !password}
                  className="modern-button enhanced-button"
                >
                  {isLoading ? 'Scraping...' : 'Login and Scrape Courses'}
                </button>
              </form>
            )}

            {isLoading && (
              <LoadingComponent message={getDisplayMessage()} showSpinner={shouldShowSpinner} />
            )}

            {scrapedData && (
              <div className={`opacity-0 transition-opacity duration-800 ease-in-out delay-400 ${isTextVisible ? 'opacity-100' : ''}`}>
                <h2 className="text-xl font-semibold m-0 mb-4.5 tracking-tight text-foreground/90">
                  Scraping Complete!
                </h2>
                <pre className="p-4.5 bg-primary/10 rounded-lg overflow-x-auto text-xs text-foreground/90 whitespace-pre-wrap break-words border border-border">
                  {JSON.stringify(scrapedData, null, 2)}
                </pre>
              </div>
            )}
          </>
        );
      case 'menu':
        return (
          <div className={`p-8 rounded-2xl bg-card/50 border border-border mt-6 w-full opacity-0 transition-opacity duration-800 ease-in-out delay-600 ${isTextVisible ? 'opacity-100' : ''}`}>
            <DiningHallMenu />
          </div>
        );
      case 'calendar':
        return (
          <div className={`p-4 rounded-2xl bg-card/50 border border-border mt-6 w-full opacity-0 transition-opacity duration-800 ease-in-out delay-600 ${isTextVisible ? 'opacity-100' : ''}`}>
            <CalendarView />
          </div>
        );
      case 'saved':
        return (
          <div className={`p-4 rounded-2xl bg-card/50 border border-border mt-6 w-full opacity-0 transition-opacity duration-800 ease-in-out delay-600 ${isTextVisible ? 'opacity-100' : ''}`}>
            <SavedDataView />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="App bg-card" style={{ minHeight: '100vh' }}>
       <div style={{ position: 'fixed', top: '20px', right: '20px', zIndex: 1001 }}>
        <ThemeToggle />
      </div>

      {/* Sidebar */}
      <Sidebar 
        onOpenChat={handleOpenChat}
        onOpenMenu={handleOpenMenu}
        onOpenCalendar={handleOpenCalendar}
        onOpenSaved={handleOpenSaved}
        onLogout={handleLogout}
        onShowAuthModal={handleShowAuthModal}
        currentUser={currentUser}
        connectionStatus={connectionStatus}
        readyState={readyState}
      />

      {/* Main Content Area */}
      {activeView === 'chat' ? (
        <ChatBot />
      ) : (
        <>
      <header className="App-header">
            <div className="flex flex-col items-center justify-center min-h-screen text-foreground p-5 text-center">
              <div className={getContainerStyle(activeView)}>
                {renderContent()}
              </div>
            </div>
          </header>
          
          {activeView === 'intro' && (
            <button
              onClick={() => setActiveView('login')}
              className={`fixed bottom-10 left-1/2 -translate-x-1/2 py-3 px-6 rounded-lg bg-gradient-to-r from-blue-600/80 to-blue-700/90 border-2 border-blue-600/60 text-white text-sm font-semibold cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] shadow-[0_8px_25px_rgba(74,144,226,0.3)] opacity-0 translate-y-2.5 hover:-translate-y-0.5 hover:shadow-[0_12px_35px_rgba(74,144,226,0.4)] ${isTextVisible ? 'opacity-100 translate-y-0' : ''}`}
              style={{ transitionProperty: 'all, opacity, transform', transitionDelay: '1s' }}
            >
              Get Started with HuskyBot
            </button>
          )}
        </>
      )}

      {/* Version text in bottom left corner */}
      <div
        className={`fixed bottom-5 left-5 text-muted-foreground/50 text-xs font-normal z-[1000] transition-all duration-600 ease-[cubic-bezier(0.34,1.56,0.64,1)] shadow-none ${isTextVisible ? 'opacity-100' : 'opacity-0'} ${isMainComponentVisible ? 'scale-100' : 'scale-0'}`}
      >
        HuskyBot v1.0
      </div>

      {/* Authentication Modal */}
      <AuthModal 
        isOpen={showAuthModal} 
        onClose={() => setShowAuthModal(false)}
        onSuccess={() => {
          console.log('Authentication successful!');
          // You can add any post-login logic here
        }}
      />
    </div>
  );
}

export default App;

