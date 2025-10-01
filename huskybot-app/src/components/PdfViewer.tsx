import { useEffect, useRef } from 'react';

interface PdfViewerProps {
  url: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}

export default function PdfViewer({ url, pageStart, pageEnd }: PdfViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    // Don't modify the signed URL - it will break the signature
    // Instead, use the URL as-is and handle page navigation via PDF.js fragment
    let finalUrl = url;
    
    // Only add page fragment if it's not already a signed URL with query params
    if (pageStart && pageStart > 0 && !url.includes('X-Goog-')) {
      // For non-signed URLs, we can add page fragment
      finalUrl = `${url}#page=${pageStart}`;
    } else if (pageStart && pageStart > 0 && url.includes('X-Goog-')) {
      // For signed URLs, we need to handle this differently
      // The page navigation will need to be handled by the PDF viewer itself
      // We'll display the page info but can't modify the URL
      console.log(`[PdfViewer] Signed URL detected, target page: ${pageStart}`);
    }
    
    if (iframeRef.current && iframeRef.current.src !== finalUrl) {
      iframeRef.current.src = finalUrl;
    }
  }, [url, pageStart, pageEnd]);

  if (!url) return null;
  
  return (
    <div className="w-full h-full flex flex-col">
      {pageStart && pageStart > 0 && (
        <div className="p-2 bg-blue-50 text-blue-800 text-xs border-b">
          📄 Target: Page {pageStart}{pageEnd && pageEnd !== pageStart ? `-${pageEnd}` : ''} 
          {url.includes('X-Goog-') && (
            <span className="ml-2 text-blue-600">(Use PDF viewer controls to navigate to this page)</span>
          )}
        </div>
      )}
      <div className="flex-1">
        <iframe 
          ref={iframeRef} 
          src={url} 
          title={`PDF${pageStart ? ` - Page ${pageStart}` : ''}`} 
          className="w-full h-full border-0" 
          allow="clipboard-read; clipboard-write" 
        />
      </div>
    </div>
  );
}

 