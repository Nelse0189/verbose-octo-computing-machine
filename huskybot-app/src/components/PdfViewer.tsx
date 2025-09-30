import { useEffect, useRef } from 'react';

interface PdfViewerProps {
  url: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}

export default function PdfViewer({ url }: PdfViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    // Nothing special; signed URL already set to inline
  }, [url]);

  if (!url) return null;
  return (
    <div className="w-full h-full">
      <iframe ref={iframeRef} src={url} title="PDF" className="w-full h-full border-0" allow="clipboard-read; clipboard-write" />
    </div>
  );
}

 