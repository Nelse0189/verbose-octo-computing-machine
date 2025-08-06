import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';

interface CustomInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: 'text' | 'password'; // Add type prop
  onEnterPress?: () => void; // New prop for Enter key press
}

const CustomInput: React.FC<CustomInputProps> = ({ value, onChange, placeholder, type = 'text', onEnterPress }) => {
  const [caretLeft, setCaretLeft] = useState(18);
  const [isFocused, setIsFocused] = useState(false);
  const [isBlinking, setIsBlinking] = useState(true);
  const editorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const lastValue = useRef(value);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // Prevent new line
      if (onEnterPress) {
        onEnterPress();
      }
    }
  };

  const updateCaretPosition = () => {
    const selection = window.getSelection();
    const editorNode = editorRef.current;
    const containerNode = containerRef.current;

    if (!selection || selection.rangeCount === 0 || !editorNode || !containerNode) return;

    const range = selection.getRangeAt(0);
    if (!editorNode.contains(range.commonAncestorContainer)) return;

    const containerRect = containerNode.getBoundingClientRect();
    let rect;

    if (range.collapsed) {
      const rects = range.getClientRects();
      if (rects.length > 0) {
        rect = rects[0];
      }
    }

    if (rect) {
      // Correctly calculate left relative to the container, not the inner div
      const newLeft = rect.left - containerRect.left;
      if (newLeft !== caretLeft) {
        setCaretLeft(newLeft);
      }
    } else if (editorNode.textContent === '') {
      const newLeft = 18; // Default left padding
      if (newLeft !== caretLeft) {
        setCaretLeft(newLeft);
      }
    }
  };

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    // Stop blinking when typing starts
    setIsBlinking(false);

    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set a new timeout to resume blinking after a pause
    typingTimeoutRef.current = window.setTimeout(() => {
      setIsBlinking(true);
    }, 500); // Resume blinking after 500ms of inactivity

    const newValue = e.currentTarget.textContent || '';
    lastValue.current = newValue;
    onChange(newValue);
  };

  useEffect(() => {
    if (editorRef.current && value !== lastValue.current) {
      editorRef.current.textContent = value;
      lastValue.current = value;
    }
  }, [value]);

  useLayoutEffect(() => {
    if (isFocused) {
      updateCaretPosition();
    }
  }, [value, isFocused]);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    }
  }, []);

  return (
    <div 
        ref={containerRef}
        className="custom-input-container modern-input"
        onClick={() => editorRef.current?.focus()}
    >
      <div 
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        className={`custom-input-editor ${type === 'password' ? 'password' : ''}`} // Conditionally apply class
        onInput={handleInput}
        onKeyUp={updateCaretPosition}
        onClick={updateCaretPosition}
        onFocus={() => {
          setIsFocused(true);
          setIsBlinking(true);
        }}
        onBlur={() => {
          setIsFocused(false);
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        }}
        onKeyDown={handleKeyDown} // Add key down handler
      />
      {!value && <span className="custom-input-placeholder">{placeholder}</span>}

      {isFocused && (
        <span 
          className="custom-smooth-caret"
          style={{
            transform: `translate(${caretLeft}px, -50%)`,
            animation: isBlinking ? 'vscodeBlink 1s infinite' : 'none',
            opacity: isBlinking ? undefined : 1,
          }}
        />
      )}
    </div>
  );
};

export default CustomInput; 