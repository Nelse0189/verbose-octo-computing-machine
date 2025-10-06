import { useState } from 'react';
import { Flashcard } from '../lib/textbookRetrieval';

interface FlashcardViewerProps {
  flashcards: Flashcard[];
  onClose: () => void;
}

export default function FlashcardViewer({ flashcards, onClose }: FlashcardViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  if (flashcards.length === 0) {
    return (
      <div className="text-center p-8">
        <p className="text-muted-foreground">No flashcards available</p>
        <button onClick={onClose} className="mt-4 modern-button">Close</button>
      </div>
    );
  }

  const currentCard = flashcards[currentIndex];

  const nextCard = () => {
    setCurrentIndex((prev) => (prev + 1) % flashcards.length);
    setIsFlipped(false);
  };

  const prevCard = () => {
    setCurrentIndex((prev) => (prev - 1 + flashcards.length) % flashcards.length);
    setIsFlipped(false);
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy': return 'text-green-600 bg-green-100';
      case 'medium': return 'text-yellow-600 bg-yellow-100';
      case 'hard': return 'text-red-600 bg-red-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  return (
    <div className="w-full h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">Flashcards</h3>
          <span className="text-sm text-muted-foreground">
            {currentIndex + 1} of {flashcards.length}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-xl">×</button>
      </div>

      {/* Flashcard */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl">
          <div 
            className={`relative w-full h-80 cursor-pointer transition-transform duration-500 preserve-3d ${
              isFlipped ? 'rotate-y-180' : ''
            }`}
            onClick={() => setIsFlipped(!isFlipped)}
            style={{ transformStyle: 'preserve-3d' }}
          >
            {/* Front of card (Question) */}
            <div 
              className={`absolute inset-0 w-full h-full backface-hidden bg-white border-2 border-gray-200 rounded-lg p-6 flex flex-col justify-center items-center shadow-lg ${
                isFlipped ? 'rotate-y-180' : ''
              }`}
              style={{ backfaceVisibility: 'hidden' }}
            >
              <div className="text-center">
                <div className="mb-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${getDifficultyColor(currentCard.difficulty)}`}>
                    {currentCard.difficulty.toUpperCase()}
                  </span>
                </div>
                <h4 className="text-lg font-medium text-gray-800 mb-4">Question:</h4>
                <p className="text-gray-700 text-lg leading-relaxed">{currentCard.question}</p>
                <p className="text-sm text-gray-500 mt-6">Click to reveal answer</p>
              </div>
            </div>

            {/* Back of card (Answer) */}
            <div 
              className={`absolute inset-0 w-full h-full backface-hidden bg-blue-50 border-2 border-blue-200 rounded-lg p-6 flex flex-col justify-center items-center shadow-lg rotate-y-180 ${
                isFlipped ? '' : 'rotate-y-180'
              }`}
              style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
            >
              <div className="text-center">
                <div className="mb-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${getDifficultyColor(currentCard.difficulty)}`}>
                    {currentCard.difficulty.toUpperCase()}
                  </span>
                </div>
                <h4 className="text-lg font-medium text-blue-800 mb-4">Answer:</h4>
                <p className="text-blue-700 text-lg leading-relaxed">{currentCard.answer}</p>
                <p className="text-sm text-blue-500 mt-6">Click to see question</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between p-4 border-t bg-gray-50">
        <button 
          onClick={prevCard}
          disabled={flashcards.length <= 1}
          className="modern-button disabled:opacity-50"
        >
          ← Previous
        </button>
        
        <div className="flex gap-2">
          <button 
            onClick={() => setIsFlipped(!isFlipped)}
            className="modern-button"
          >
            {isFlipped ? '🔄 Show Question' : '🔄 Show Answer'}
          </button>
        </div>
        
        <button 
          onClick={nextCard}
          disabled={flashcards.length <= 1}
          className="modern-button disabled:opacity-50"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
