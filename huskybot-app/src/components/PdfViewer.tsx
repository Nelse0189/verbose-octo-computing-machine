import { useEffect, useRef } from 'react';

interface PdfViewerProps {
  url: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}

export default function PdfViewer({ url, pageStart, pageEnd }: PdfViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    // If we have specific page range, append to URL
    let finalUrl = url;
    if (pageStart && pageStart > 0) {
      // Add page parameter to PDF URL (works with most PDF viewers)
      const separator = url.includes('?') ? '&' : '#';
      finalUrl = `${url}${separator}page=${pageStart}`;
    }
    
    if (iframeRef.current && iframeRef.current.src !== finalUrl) {
      iframeRef.current.src = finalUrl;
    }
  }, [url, pageStart, pageEnd]);

  if (!url) return null;
  
  return (
    <div className="w-full h-full">
      <iframe 
        ref={iframeRef} 
        src={url} 
        title={`PDF${pageStart ? ` - Page ${pageStart}` : ''}`} 
        className="w-full h-full border-0" 
        allow="clipboard-read; clipboard-write" 
      />
    </div>
  );
}

 