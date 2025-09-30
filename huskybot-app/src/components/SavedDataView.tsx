import { useEffect, useMemo, useState } from 'react';

// Allow using chrome.* in TS without type packages
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

type MaterialMeta = {
  id: number;
  title: string;
  courseName: string;
  hasFile: boolean;
  mimeType: string;
  size: number;
};

export default function SavedDataView() {
  const [extensionId, setExtensionId] = useState<string>(() => localStorage.getItem('huskybot_extension_id') || '');
  const [materials, setMaterials] = useState<MaterialMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  useEffect(() => {
    if (extensionId) localStorage.setItem('huskybot_extension_id', extensionId);
  }, [extensionId]);

  // Accept extension id via URL param (?ext=ID)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const ext = params.get('ext');
      if (ext && ext !== extensionId) {
        setExtensionId(ext);
        localStorage.setItem('huskybot_extension_id', ext);
      }
    } catch {}
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return materials;
    return materials.filter(m => m.title.toLowerCase().includes(f) || (m.courseName||'').toLowerCase().includes(f));
  }, [materials, filter]);

  const loadMaterials = async () => {
    setError(null);
    setLoading(true);
    setMaterials([]);
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        setError('chrome.runtime is not available. Open in Chrome and ensure extension is installed.');
        setLoading(false);
        return;
      }
      chrome.runtime.sendMessage(extensionId, { type: 'READ_MATERIALS_META' }, (resp: any) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          setError(lastErr.message || 'Message failed');
          setLoading(false);
          return;
        }
        if (!resp || !resp.success) {
          setError(resp?.error || 'Failed to read materials. Ensure the site has permission in the extension.');
          setLoading(false);
          return;
        }
        setMaterials(resp.materials || []);
        setLoading(false);
      });
    } catch (e: any) {
      setError(String(e?.message || e));
      setLoading(false);
    }
  };

  const openMaterial = (id: number) => {
    try {
      chrome.runtime.sendMessage(extensionId, { type: 'OPEN_MATERIAL_IN_TAB', id }, (_resp: any) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) setError(lastErr.message);
      });
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  // Auto-load on mount if an extension ID is already saved
  useEffect(() => {
    if (extensionId && materials.length === 0 && !loading) {
      loadMaterials();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full p-4 text-foreground">
      <h2 className="text-xl font-semibold mb-3">Saved Materials (from Extension)</h2>
      <div className="flex flex-col md:flex-row gap-2 items-start md:items-center mb-3">
        <input
          className="px-3 py-2 rounded border bg-card/60 w-full md:w-[380px]"
          placeholder="Your HuskyBot extension ID (chrome://extensions)"
          value={extensionId}
          onChange={e => setExtensionId(e.target.value.trim())}
        />
        <button className="modern-button enhanced-button" onClick={loadMaterials} disabled={!extensionId || loading}>
          {loading ? 'Loading…' : 'Load Materials'}
        </button>
      </div>
      <div className="flex gap-2 mb-3">
        <input
          className="px-3 py-2 rounded border bg-card/60 w-full md:w-[300px]"
          placeholder="Filter by title or course"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      {error && <div className="text-red-500 text-sm mb-3">{error}</div>}
      <div className="rounded border divide-y max-h-[70vh] overflow-y-auto">
        {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground">No materials loaded yet.</div>}
        {filtered.map((m) => (
          <div key={m.id} className="p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{m.title}</div>
              <div className="text-xs text-muted-foreground truncate">{m.courseName}</div>
              <div className="text-[11px] text-muted-foreground">{m.mimeType || 'n/a'} • {m.size} chars</div>
            </div>
            {m.hasFile && (
              <button className="modern-button" onClick={() => openMaterial(m.id)}>Open</button>
            )}
          </div>
        ))}
      </div>
      <div className="text-xs text-muted-foreground mt-2">Tip: Ensure the extension has site access. In the extension popup, use “Open HuskyBot Site” once to grant permission.</div>
    </div>
  );
}


