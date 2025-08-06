import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import CustomInput from './CustomInput';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { login, signup, resetPassword } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isLogin) {
        await login(email, password);
      } else {
        if (password !== confirmPassword) {
          setError('Passwords do not match');
          setLoading(false);
          return;
        }
        await signup(email, password, displayName);
      }
      onSuccess();
      onClose();
    } catch (error: any) {
      setError(error.message);
    }
    setLoading(false);
  };

  const handleForgotPassword = async () => {
    if (!email) {
      setError('Please enter your email address');
      return;
    }
    try {
      await resetPassword(email);
      setError('Password reset email sent!');
    } catch (error: any) {
      setError(error.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[2000]">
      <div className="p-8 rounded-2xl bg-card/80 backdrop-blur-xl border-2 border-border shadow-lg w-full max-w-md relative text-card-foreground">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 bg-transparent border-none text-muted-foreground cursor-pointer text-2xl w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-200 ease-in-out hover:bg-muted/50 hover:text-foreground"
        >
          ×
        </button>

        <h2 className="text-3xl font-bold m-0 mb-2 text-center">
          {isLogin ? 'Welcome Back' : 'Create Account'}
        </h2>

        <p className="text-muted-foreground text-center m-0 mb-6 text-sm">
          {isLogin 
            ? 'Sign in to access your HuskyBot dashboard' 
            : 'Join HuskyBot to get started with your intelligent academic assistant'
          }
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!isLogin && (
            <CustomInput
              placeholder="Display Name"
              value={displayName}
              onChange={setDisplayName}
              onEnterPress={() => handleSubmit(new Event('submit') as unknown as React.FormEvent)}
            />
          )}
          
          <CustomInput
            placeholder="Email"
            value={email}
            onChange={setEmail}
            onEnterPress={() => handleSubmit(new Event('submit') as unknown as React.FormEvent)}
          />
          
          <CustomInput
            type="password"
            placeholder="Password"
            value={password}
            onChange={setPassword}
            onEnterPress={() => handleSubmit(new Event('submit') as unknown as React.FormEvent)}
          />
          
          {!isLogin && (
            <CustomInput
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              onEnterPress={() => handleSubmit(new Event('submit') as unknown as React.FormEvent)}
            />
          )}

          {error && (
            <div className="p-3 rounded-lg bg-destructive/20 border border-destructive/40 text-destructive-foreground text-sm text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="p-3.5 rounded-lg text-white text-base font-semibold cursor-pointer transition-all duration-300 ease-in-out disabled:cursor-not-allowed disabled:bg-muted 
            enabled:bg-gradient-to-r enabled:from-blue-600/80 enabled:to-blue-700/90 enabled:border-2 enabled:border-blue-600/60"
          >
            {loading ? 'Please wait...' : (isLogin ? 'Sign In' : 'Create Account')}
          </button>

          {isLogin && (
            <button
              type="button"
              onClick={handleForgotPassword}
              className="bg-transparent border-none text-muted-foreground cursor-pointer text-sm underline"
            >
              Forgot Password?
            </button>
          )}

          <div className="text-center mt-4">
            <span className="text-muted-foreground text-sm">
              {isLogin ? "Don't have an account? " : "Already have an account? "}
            </span>
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError('');
              }}
              className="bg-transparent border-none text-primary cursor-pointer text-sm font-semibold underline"
            >
              {isLogin ? 'Sign Up' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AuthModal; 