import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle, useLayoutEffect } from 'react';

interface CustomInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: 'text' | 'password';
  onEnterPress?: () => void;
  autoFocus?: boolean;
}

export interface CustomInputRef {
  focus: () => void;
}

const CustomInput = forwardRef<CustomInputRef, CustomInputProps>(
  ({ value, onChange, placeholder, type = 'text', onEnterPress, autoFocus = false }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const measureRef = useRef<HTMLSpanElement>(null);
    const [cursorX, setCursorX] = useState<number>(0); // target x
    const [animatedX, setAnimatedX] = useState<number>(0); // smoothed x
    const rafRef = useRef<number | null>(null);
    const [isFocused, setIsFocused] = useState<boolean>(false);
    const [isTyping, setIsTyping] = useState<boolean>(false);
    const typingTimerRef = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
      }
    }));

    useEffect(() => {
      if (autoFocus && inputRef.current) {
        inputRef.current.focus();
      }
    }, [autoFocus]);

    const updateCaret = () => {
      const input = inputRef.current;
      const measure = measureRef.current;
      if (!input || !measure) return;

      const liveValue = input.value;
      const selectionEnd = input.selectionEnd ?? liveValue.length;
      const textToMeasure = (type === 'password')
        ? '*'.repeat(selectionEnd)
        : liveValue.slice(0, selectionEnd);

      const safe = textToMeasure.replace(/ /g, '\u00A0');
      measure.textContent = safe;
      const width = measure.offsetWidth;
      setCursorX(width);
    };

    // Smoothly animate animatedX toward cursorX
    const tick = () => {
      const lerpFactor = 0.25; // higher = faster tracking
      setAnimatedX(prev => {
        const next = prev + (cursorX - prev) * lerpFactor;
        return Math.abs(next - cursorX) < 0.25 ? cursorX : next;
      });
      // Continue if not very close
      rafRef.current = Math.abs(animatedX - cursorX) < 0.25 ? null : requestAnimationFrame(tick);
    };

    // Start/refresh animation when target changes or focus state changes
    useEffect(() => {
      if (!isFocused) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cursorX, isFocused]);

    // Recalculate immediately after React paints
    useLayoutEffect(() => {
      updateCaret();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, type, isFocused]);

    useEffect(() => {
      const onResize = () => updateCaret();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    const startTypingWindow = () => {
      setIsTyping(true);
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(() => setIsTyping(false), 250);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && onEnterPress) {
        e.preventDefault();
        onEnterPress();
      }
      startTypingWindow();
      updateCaret();
    };
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
      startTypingWindow();
      updateCaret();
    };

    const handleSelect = () => {
      updateCaret();
    };

    const handleInput = () => {
      startTypingWindow();
      updateCaret();
    };

    const handleCompositionUpdate = () => {
      startTypingWindow();
      updateCaret();
    };

    const handleFocus = () => {
      setIsFocused(true);
      updateCaret();
    };

    const handleBlur = () => {
      setIsFocused(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };

    return (
      <div className="custom-input-container modern-input" style={{ flex: 1, position: 'relative' }}>
        {/* Hidden measurement span to compute caret x */}
        <span
          ref={measureRef}
          className="typewriter-measure"
          style={{
            font: 'inherit',
            letterSpacing: 'inherit',
            whiteSpace: 'pre',
            visibility: 'hidden',
          }}
        />
        {/* Custom smooth caret overlay - only show when focused */}
        {isFocused && (
          <div
            className="custom-smooth-caret"
            style={{
              transform: `translateX(${Math.max(0, animatedX + 18)}px) translateY(-50%)`,
              animation: isTyping ? 'none' : undefined,
              transition: 'transform 0ms', // animation handled by RAF lerp
            }}
          />
        )}
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onInput={handleInput}
          onCompositionUpdate={handleCompositionUpdate}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          className="custom-input-editor"
          autoFocus={autoFocus}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            fontSize: 'inherit',
            fontFamily: 'inherit',
            padding: 0,
            margin: 0,
            caretColor: 'transparent',
          }}
        />
      </div>
    );
  }
);

CustomInput.displayName = 'CustomInput';

export default CustomInput; 