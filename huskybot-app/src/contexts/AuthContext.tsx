import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { 
  User,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile
} from 'firebase/auth';
import { auth } from '../firebase/config';

interface AuthContextType {
  currentUser: User | null;
  loading: boolean;
  signup: (email: string, password: string, displayName?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateUserProfile: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID as string | undefined;

function pushUidToExtension(userId: string) {
  try {
    const chromeApi = (window as any).chrome;
    if (!chromeApi?.runtime?.sendMessage) return;
    if (!EXTENSION_ID) return;

    chromeApi.runtime.sendMessage(EXTENSION_ID, { type: 'SET_USER', userId }, (res: any) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError) {
        console.warn('[Auth] Failed to push uid to extension:', lastError.message);
        return;
      }
      if (res?.success) {
        console.log('[Auth] Pushed uid to extension');
      } else {
        console.warn('[Auth] Extension responded with failure', res);
      }
    });
  } catch (e) {
    console.warn('[Auth] Exception when pushing uid to extension:', e);
  }
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const signup = async (email: string, password: string, displayName?: string) => {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) {
      await updateProfile(user, { displayName });
    }
    // onAuthStateChanged will handle propagation
  };

  const login = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle propagation
  };

  const logout = async () => {
    await signOut(auth);
    try {
      localStorage.removeItem('huskybotUserId');
    } catch {}
  };

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  };

  const updateUserProfile = async (displayName: string) => {
    if (currentUser) {
      await updateProfile(currentUser, { displayName });
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setLoading(false);

      if (user) {
        // Store uid for frontend namespace
        try { localStorage.setItem('huskybotUserId', user.uid); } catch {}
        // Push uid to extension for indexing namespace
        pushUidToExtension(user.uid);
      }
    });

    return unsubscribe;
  }, []);

  const value: AuthContextType = {
    currentUser,
    loading,
    signup,
    login,
    logout,
    resetPassword,
    updateUserProfile
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export default AuthContext; 