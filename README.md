# Semantic Bookmarks

Chrome browser extension allows you to semantically search your Chrome bookmarks by the content of the web pages, not just by their titles.

## Installation (for Development)

1.  Open Google Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode" using the toggle in the top-right corner.
3.  Click the "Load unpacked" button.
4.  Select the directory containing this extension's code.

## Ollama Configuration

**Note:** You must have a local Ollama server running which provides embedding model for this extension to function.

For the extension to connect to your local Ollama server, you must configure Ollama to accept requests from the Chrome extension's origin.

### For Command-Line

If you run Ollama from the terminal, start it with the `OLLAMA_ORIGINS` environment variable set to allow Chrome extensions:

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

### For Desktop App (macOS)

If you use the Ollama desktop application, you should set a system-wide environment variable that the app can read on startup.

-  Run in terminal:
    ```bash
    launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
    ```
-  Quit and restart Ollama desktop app for the setting to take effect.

## Indexing Folders

Right click on the extension icon in the upper right part of the browser and select options. It will show the list of bookmarks folders in your browser. Select the ones you want indexed.

