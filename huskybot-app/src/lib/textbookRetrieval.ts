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
  const res = await fetch('/textbookTopicSummary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, textbookId, namespace, limit })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`textbookTopicSummary failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function getSignedPdfUrl(storagePath: string, minutes = 15): Promise<string> {
  const res = await fetch('/getSignedPdfUrl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storagePath, minutes })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getSignedPdfUrl failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.url as string;
}

 