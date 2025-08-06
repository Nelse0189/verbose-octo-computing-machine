import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { ThemeToggle } from './components/ThemeToggle';
import { ThemeProvider } from './contexts/ThemeProvider';
import VantaClouds from './components/VantaClouds';
import AuthModal from './components/AuthModal';
import ChatBot from './components/ChatBot';
import DiningHallMenu from './components/Menu';
import Typewriter from 'typewriter-effect';

function App() {
  const { user, loading } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  if (loading) {
    return <div>Loading...</div>; // Or a proper loading spinner
  }

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <Router>
        <div className="relative min-h-screen bg-background text-foreground">
          <VantaClouds />
          <div className="absolute inset-0 flex flex-col items-center p-4">
            <header className="w-full max-w-6xl mx-auto flex justify-between items-center mb-8">
              <Link to="/" className="text-4xl font-bold text-center flex-grow title-glow no-underline">
                HuskyBot
              </Link>
              <nav className="flex items-center gap-4">
                {user && <Link to="/chat" className="text-lg">Chat</Link>}
                {user && <Link to="/menu" className="text-lg">Dining Menu</Link>}
                {user ? (
                  <button onClick={() => useAuth().logout()} className="text-lg">Logout</button>
                ) : (
                  <button onClick={() => setIsAuthModalOpen(true)} className="text-lg">Login</button>
                )}
                <ThemeToggle />
              </nav>
            </header>
            <main className="w-full flex-grow flex items-center justify-center">
              <Routes>
                <Route path="/" element={
                  user ? <Navigate to="/chat" /> : <IntroPage openAuthModal={() => setIsAuthModalOpen(true)} />
                } />
                <Route path="/chat" element={user ? <ChatBot /> : <Navigate to="/" />} />
                <Route path="/menu" element={user ? <DiningHallMenu /> : <Navigate to="/" />} />
              </Routes>
            </main>
            <AuthModal isOpen={isAuthModalOpen} onClose={() => setIsAuthModalOpen(false)} onSuccess={() => {}} />
          </div>
        </div>
      </Router>
    </ThemeProvider>
  );
}

const IntroPage = ({ openAuthModal }: { openAuthModal: () => void; }) => (
  <div className="text-center">
    <h2 className="text-5xl font-bold mb-4">
      <Typewriter
        options={{
          strings: ['Welcome to HuskyBot', 'Your UConn Campus Assistant'],
          autoStart: true,
          loop: true,
        }}
      />
    </h2>
    <p className="text-xl mb-8">Get instant answers about announcements, dining hall menus, and more.</p>
    <button onClick={openAuthModal} className="bg-primary text-primary-foreground px-8 py-4 rounded-lg text-xl font-bold">
      Get Started
    </button>
  </div>
);

export default App;

