// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('search');
  const searchButton = document.getElementById('searchButton');
  const clearButton = document.getElementById('clearButton');
  const resultsDiv = document.getElementById('results');

  // Function to render results on the screen
  function renderResults(results) {
    resultsDiv.innerHTML = '';
    if (results && results.length > 0) {
      clearButton.classList.remove('inactive');
      results.forEach((result) => {
        const resultDiv = document.createElement('div');
        resultDiv.style.border = '1px solid #ccc';
        resultDiv.style.padding = '10px';
        resultDiv.style.marginBottom = '10px';

        const title = document.createElement('h3');
        const link = document.createElement('a');
        link.href = result.url;
        link.textContent = result.title;
        link.target = '_blank';
        title.appendChild(link);
        resultDiv.appendChild(title);

        const chunk = document.createElement('p');
        chunk.textContent = result.chunk;
        resultDiv.appendChild(chunk);

        const similarity = document.createElement('p');
        similarity.textContent = `Similarity: ${result.similarity.toFixed(4)}`;
        similarity.style.fontStyle = 'italic';
        resultDiv.appendChild(similarity);

        resultsDiv.appendChild(resultDiv);
      });
    } else {
      resultsDiv.innerHTML = 'No results found.';
      clearButton.classList.add('inactive');
    }
  }

  function performSearch() {
    const query = searchInput.value;

    if (query.length > 2) {
      resultsDiv.innerHTML = '<i>Searching...</i>';
      // Reset scroll position for the new search
      chrome.storage.session.set({ lastScrollPosition: 0 });
      chrome.runtime.sendMessage({ type: 'search', payload: query }, (results) => {
        renderResults(results);
        // Save state to session storage
        chrome.storage.session.set({ lastSearchQuery: query, lastSearchResults: results });
      });
    } else {
      resultsDiv.innerHTML = '';
      chrome.storage.session.remove(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition']);
      clearButton.classList.add('inactive');
    }
  }

  function clearSearch() {
    searchInput.value = '';
    resultsDiv.innerHTML = '';
    chrome.storage.session.remove(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition']);
    clearButton.classList.add('inactive');
  }

  // Event Listeners
  searchButton.addEventListener('click', performSearch);
  searchInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
      performSearch();
    }
  });
  clearButton.addEventListener('click', clearSearch);

  // Save scroll position when user scrolls
  let scrollTimeout;
  resultsDiv.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      chrome.storage.session.set({ lastScrollPosition: resultsDiv.scrollTop });
    }, 200); // Debounce to avoid saving on every single scroll event
  });

  // Restore state when popup opens
  chrome.storage.session.get(['lastSearchQuery', 'lastSearchResults', 'lastScrollPosition'], (data) => {
    if (data.lastSearchQuery && data.lastSearchResults) {
      searchInput.value = data.lastSearchQuery;
      renderResults(data.lastSearchResults);
      // Restore scroll position after results are rendered
      if (data.lastScrollPosition) {
        resultsDiv.scrollTop = data.lastScrollPosition;
      }
    } else {
      // If there's no state, ensure the button is inactive
      clearButton.classList.add('inactive');
    }
  });
});
