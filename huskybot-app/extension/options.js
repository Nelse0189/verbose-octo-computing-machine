// huskybot-app/extension/options.js

// Saves options to chrome.storage
function save_options() {
  const openaiKey = document.getElementById('openaiKey').value;
  const pineconeKey = document.getElementById('pineconeKey').value;
  const pineconeIndexUrl = document.getElementById('pineconeIndexUrl').value;

  chrome.storage.sync.set({
    openaiKey: openaiKey,
    pineconeKey: pineconeKey,
    pineconeIndexUrl: pineconeIndexUrl
  }, function() {
    // Update status to let user know options were saved.
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(function() {
      status.textContent = '';
    }, 1500);
  });
}

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
function restore_options() {
  chrome.storage.sync.get({
    openaiKey: '',
    pineconeKey: '',
    pineconeIndexUrl: ''
  }, function(items) {
    document.getElementById('openaiKey').value = items.openaiKey;
    document.getElementById('pineconeKey').value = items.pineconeKey;
    document.getElementById('pineconeIndexUrl').value = items.pineconeIndexUrl;
  });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options); 