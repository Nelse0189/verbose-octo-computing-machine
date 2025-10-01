export interface TextbookSource {
  id: number;
  heading?: string | null;
  pages?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  textbookId?: string | null;
  storagePath?: string | null;
}

export interface TopicSummaryResponse {
  summary: string;
  sources: TextbookSource[];
}

export async function summarizeTopicWithTextbook(topic: string, textbookId?: string, namespace?: string, limit?: number): Promise<TopicSummaryResponse> {
  // Add timeout to frontend request (5 minutes)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
  
  try {
    const res = await fetch('/textbookTopicSummary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, textbookId, namespace, limit }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`textbookTopicSummary failed: ${res.status} ${text}`);
    }
    return res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out after 5 minutes. The AI is processing complex content - please try again.');
    }
    throw error;
  }
}

export async function getSignedPdfUrl(storagePath: string, minutes = 15, pageStart?: number): Promise<string> {
  const res = await fetch('/getSignedPdfUrl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storagePath, minutes, pageStart })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getSignedPdfUrl failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.url as string;
}

 