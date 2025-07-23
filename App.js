import React from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { FirebaseProvider } from './context/FirebaseContext';
import { GeminiProvider } from './context/GeminiContext';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import Journal from './pages/Journal';
import Feed from './pages/Feed';
import Profile from './pages/Profile';
import Wallet from './pages/Wallet';
import Onboarding from './pages/Onboarding';
import AdminModeration from './pages/AdminModeration';
import MobilePrompt from './components/MobilePrompt';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <Router>
        <FirebaseProvider>
          <GeminiProvider>
            <AuthProvider>
              <div className="min-h-screen bg-gradient-to-br from-blue-100 to-purple-100">
                <Navbar />
                <MobilePrompt />
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/journal" element={<Journal />} />
                  <Route path="/feed" element={<Feed />} />
                  <Route path="/profile/:userId" element={<Profile />} />
                  <Route path="/wallet" element={<Wallet />} />
                  <Route path="/onboarding" element={<Onboarding />} />
                  <Route path="/moderation" element={<AdminModeration />} />
                </Routes>
              </div>
            </AuthProvider>
          </GeminiProvider>
        </FirebaseProvider>
      </Router>
    </ErrorBoundary>
  );
}

export default App;
