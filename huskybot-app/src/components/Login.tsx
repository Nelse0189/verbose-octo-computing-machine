import { useState, useEffect } from 'react';

const Popup = () => {
  const [status, setStatus] = useState('Idle');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'disconnected'>('unknown');
  const [courseCount, setCourseCount] = useState<number>(0);

  // This effect runs once when the popup opens
  useEffect(() => {
    // Get initial data from storage
    chrome.storage.local.get(['lastSyncTime', 'courses'], (result) => {
      if (result.lastSyncTime) {
        setLastSync(new Date(result.lastSyncTime).toLocaleString());
      }
      if (result.courses && Array.isArray(result.courses)) {
        setCourseCount(result.courses.length);
        setStatus(`${result.courses.length} courses found.`);
      }
    });

    // Test connection on popup open
    testConnection();

    // Listen for future changes in storage
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes.courses) {
        const newCourses = changes.courses.newValue || [];
        setCourseCount(newCourses.length);
        setStatus(`✅ Sync complete! Found ${newCourses.length} courses.`);
        const now = new Date();
        setLastSync(now.toLocaleString());
        chrome.storage.local.set({ lastSyncTime: now.toISOString() });
      }
    };

    chrome.storage.onChanged.addListener(storageListener);

    // Cleanup listener when the popup closes
    return () => {
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, []);

  const testConnection = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.id) {
        // The content script now only responds to 'ping'
        chrome.tabs.sendMessage(activeTab.id, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) {
            setConnectionStatus('disconnected');
          } else if (response && response.status === 'pong') {
            setConnectionStatus('connected');
          } else {
            setConnectionStatus('disconnected');
          }
        });
      } else {
        setConnectionStatus('disconnected');
      }
    });
  };

  const handleSync = () => {
    setStatus('Asking page to sync...');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab || !activeTab.id || !activeTab.url) {
        setStatus('Error: No active HuskyCT tab found.');
        return;
      }

      if (!activeTab.url.includes('huskyct.uconn.edu') && !activeTab.url.includes('lms.uconn.edu')) {
        setStatus('Error: Please navigate to the HuskyCT courses page.');
        return;
      }
      
      // We don't need to send a message. We just need to reload the page
      // so the content script runs again. This is the simplest way.
      setStatus('Refreshing page to find courses...');
      chrome.tabs.reload(activeTab.id);
      // The storage listener will automatically update the UI
    });
  };

  const handleClearData = () => {
    chrome.storage.local.clear(() => {
      setStatus('Data cleared');
      setLastSync(null);
      setCourseCount(0);
      console.log('All local extension data has been cleared.');
    });
  };

  const handleTestConnection = () => {
    setStatus('Testing connection...');
    testConnection();
    setTimeout(() => {
      // Re-check state after a delay to give testConnection time to complete
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab && activeTab.id) {
          chrome.tabs.sendMessage(activeTab.id, { action: 'ping' }, (response) => {
            if (response && response.status === 'pong') {
              setStatus('✅ Connection test successful!');
            } else {
              setStatus('❌ Connection test failed. Try refreshing the HuskyCT tab.');
            }
          });
        }
      });
    }, 500);
  };

  const handleTestNavigation = () => {
    setStatus('Starting navigation test...');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.id) {
        // This message tells the content script to start the process
        chrome.tabs.sendMessage(activeTab.id, { action: 'startNavigationTest' });
      } else {
        setStatus('Error: Could not find active tab.');
      }
    });
  };

  const getConnectionBadge = () => {
    switch (connectionStatus) {
      case 'connected':
        return <span className="text-green-600 text-xs">● Connected</span>;
      case 'disconnected':
        return <span className="text-red-600 text-xs">● Disconnected</span>;
      default:
        return <span className="text-gray-600 text-xs">● Unknown</span>;
    }
  };

  return (
    <div className="w-80 p-4 bg-gray-50">
      <div className="flex items-center mb-4">
        <img src="assets/icon48.png" alt="HuskyBot" className="w-10 h-10 mr-3" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-800">HuskyBot</h1>
          <p className="text-sm text-gray-500">Your AI-powered course assistant.</p>
        </div>
        <div className="text-right">
          {getConnectionBadge()}
        </div>
      </div>

      <div className="space-y-3">
        <button
          onClick={handleSync}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors duration-200"
        >
          Sync Courses
        </button>
        
        <button
          onClick={handleTestConnection}
          className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors duration-200"
        >
          Test Connection
        </button>
        
        <button
          onClick={handleClearData}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors duration-200"
        >
          Clear All Data
        </button>

        <button
          onClick={handleTestNavigation}
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors duration-200"
        >
          Test Course Navigation
        </button>
      </div>
      
      <div className="mt-4 text-center">
        <p className="text-sm text-gray-600">Status: <span className="font-semibold">{status}</span></p>
        <p className="text-sm text-gray-500 mt-1">Courses Found: <span className="font-bold">{courseCount}</span></p>
        {lastSync && (
          <p className="text-xs text-gray-400 mt-1">Last Sync: {lastSync}</p>
        )}
      </div>
      
      <div className="mt-3 p-2 bg-blue-50 rounded text-xs text-gray-600">
        💡 <strong>Tip:</strong> If connection fails, refresh the HuskyCT page and try again.
      </div>
    </div>
  );
};

export default Popup; 