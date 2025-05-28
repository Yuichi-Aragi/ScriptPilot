const { Plugin, Notice, Setting, PluginSettingTab, setIcon, debounce, Modal, SuggestModal, TFile, TextComponent, Events, requestUrl } = require('obsidian');

// --- Constants ---
/** @const {string} Prefix for console log messages from this plugin. Used for easier debugging and log filtering. */
const PLUGIN_CONSOLE_PREFIX = '[ScriptPilot]';

/** @const {string} Suffix for iframe success messages, ensuring message uniqueness. */
const IFRAME_MESSAGE_TYPE_SUCCESS_SUFFIX = '-loader-code-success';
/** @const {string} Suffix for iframe error messages, ensuring message uniqueness. */
const IFRAME_MESSAGE_TYPE_ERROR_SUFFIX = '-loader-code-error';
/** @const {string} Prefix for injected script tag IDs, allowing targeted removal. */
const SCRIPT_TAG_ID_PREFIX = 'scriptpilot-script-';
/** @const {number} Timeout in milliseconds for iframe loading, preventing indefinite hangs. */
const IFRAME_LOAD_TIMEOUT_MS = 30000; // 30 seconds
/** @const {number} Minimum update frequency in milliseconds for the real-time status panel, preventing overly frequent updates. */
const MIN_REALTIME_UPDATE_FREQUENCY = 500;
/** @const {number} Debounce time in milliseconds for settings updates affecting UI, preventing rapid re-renders. */
const DEBOUNCE_SETTINGS_UPDATE_MS = 300;

/**
 * @typedef {Object} LibraryConfig
 * @property {string} id - Unique identifier for the library.
 * @property {'http' | 'localFile' | 'http-iframe'} type - The method used to load the library.
 * @property {string} name - User-friendly name for the library.
 * @property {string} [url] - URL for 'http' or 'http-iframe' types.
 * @property {string} [filePath] - Vault-relative path for 'localFile' type.
 * @property {boolean} isEnabled - Whether the library should be loaded (on startup or manually).
 * @property {number} loadOrder - Numeric order for loading; lower numbers load first. Used to manage dependencies.
 * @property {string} [globalObjectName] - Expected global object name exposed by the library (e.g., 'jQuery', 'moment'). Used for status checking and attempted cleanup.
 * @property {string} [initializationScript] - User-defined JavaScript to run after the library loads successfully.
 * @property {string} [destructionScript] - User-defined JavaScript to run before the library unloads.
 */

/**
 * Default settings for the ScriptPilot plugin.
 * These values are used if no settings are found or if specific settings are missing.
 * @type {{libraries: LibraryConfig[], loadEnabledOnStartup: boolean, showStatusBar: boolean, showRealtimeStatusPanel: boolean, realtimePanelUpdateFrequency: number}}
 */
const DEFAULT_SETTINGS = {
    libraries: [],
    loadEnabledOnStartup: true,
    showStatusBar: true,
    showRealtimeStatusPanel: true,
    realtimePanelUpdateFrequency: 2500,
};

// --- Utility Functions ---
/**
 * Provides static utility functions used throughout the plugin.
 * This class is not meant to be instantiated.
 */
class Utils {
    /**
     * Generates a unique identifier string.
     * Commonly used for new library configurations to ensure distinct IDs.
     * @returns {string} A unique ID (e.g., "lib-1678886400000-abcdef123").
     */
    static generateUniqueId() {
        return `lib-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * Safely retrieves a nested property from an object using a dot-separated path.
     * @param {object} obj - The object to traverse.
     * @param {string} path - The dot-separated path to the property (e.g., "myLib.utils.version").
     * @returns {*} The value of the property if found, otherwise undefined.
     * Returns undefined if the path is invalid or any part of the path does not exist.
     */
    static getProperty(obj, path) {
        if (!path || typeof path !== 'string') return undefined;
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, part)) {
                return undefined;
            }
            current = current[part];
        }
        return current;
    }

    /**
     * Attempts to delete a nested property from an object (typically `window`) using a dot-separated path.
     * If the property is not configurable but is writable, it attempts to set the property to `undefined`.
     * This is a best-effort approach to clean up global namespace pollution by libraries.
     * @param {object} obj - The object from which to delete the property (e.g., `window`).
     * @param {string} path - The dot-separated path to the property.
     * @returns {boolean} True if the property was successfully deleted or set to undefined, false otherwise.
     * Logs a warning if the property is neither configurable nor writable.
     */
    static deleteProperty(obj, path) {
        if (!path || typeof path !== 'string') return false;
        const parts = path.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, part)) {
                return false; // Path does not exist up to this point
            }
            current = current[part];
        }

        const finalPart = parts[parts.length - 1];
        if (typeof current === 'object' && current !== null && Object.prototype.hasOwnProperty.call(current, finalPart)) {
            try {
                const descriptor = Object.getOwnPropertyDescriptor(current, finalPart);
                if (descriptor && descriptor.configurable) {
                    delete current[finalPart];
                    return true;
                } else if (descriptor && descriptor.writable) {
                    // If not configurable but writable, try setting to undefined.
                    // This makes the property behave as if it's gone for most practical purposes.
                    current[finalPart] = undefined;
                    return typeof current[finalPart] === 'undefined'; // Verify it was set to undefined
                } else {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Property '${path}' is not configurable and not writable. Cannot delete or set to undefined.`);
                    return false;
                }
            } catch (e) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Error attempting to delete or undefined property '${path}':`, e);
                return false;
            }
        }
        return false; // Property does not exist on the final object segment
    }

    /**
     * Executes user-provided JavaScript code safely in the global scope (`window`).
     * Used for running initialization and destruction scripts for libraries.
     * The script is wrapped in an async IIFE with "use strict".
     * @param {string} scriptCode - The JavaScript code to execute.
     * @param {string} libraryName - The name of the library this script belongs to (for logging and notices).
     * @param {'initialization' | 'destruction'} scriptType - The type of script being run (for logging and notices).
     * @param {boolean} showNotices - Whether to display Obsidian notices for script execution start/finish/error.
     * @param {string} [consolePrefix=PLUGIN_CONSOLE_PREFIX] - Prefix for console messages.
     * @returns {Promise<{success: boolean, error?: string}>} An object indicating success or failure.
     * If successful, `success` is true. If failed, `success` is false and `error` contains the error message.
     * Returns `{ success: true }` if `scriptCode` is empty or whitespace.
     */
    static async executeUserScript(scriptCode, libraryName, scriptType, showNotices, consolePrefix = PLUGIN_CONSOLE_PREFIX) {
        if (!scriptCode || typeof scriptCode !== 'string' || scriptCode.trim() === "") {
            return { success: true }; // No script to run, considered a success.
        }

        if (showNotices) new Notice(`ScriptPilot: Running ${scriptType} script for "${libraryName}"...`, 2000);
        try {
            // Using new Function to execute code in the global scope with 'use strict'.
            // The 'async' keyword allows top-level await within the user's script.
            // 'window' is passed as 'this' context.
            const scriptFunction = new Function(`return (async () => { "use strict"; ${scriptCode} })();`);
            await scriptFunction.call(window); 
            if (showNotices) new Notice(`ScriptPilot: "${libraryName}" ${scriptType} script finished successfully.`, 3000);
            console.log(`${consolePrefix} "${libraryName}" ${scriptType} script executed successfully.`);
            return { success: true };
        } catch (error) {
            const errorMessage = `Error running ${scriptType} script for "${libraryName}": ${error.message || String(error)}`;
            console.error(`${consolePrefix} ${errorMessage}`, error);
            if (showNotices) new Notice(`ScriptPilot: ${errorMessage}`, 7000);
            return { success: false, error: `${scriptType} script error: ${error.message || String(error)}` };
        }
    }
}

// --- Script Injection Service ---
/**
 * Manages the injection and removal of script tags into the document's head.
 * Ensures scripts are handled cleanly and idempotently.
 */
class ScriptInjectorService {
    /**
     * Injects JavaScript code into the document head as a script tag.
     * If a script tag with the same ID already exists, it is removed first to ensure a clean state.
     * @param {string} libraryId - The unique ID of the library, used to construct the script tag ID.
     * @param {string} libraryCode - The JavaScript code to inject.
     * @returns {HTMLScriptElement} The newly created and appended script element.
     * @throws {Error} If script content is invalid (not a string) or if `document.head` is unavailable.
     */
    injectScript(libraryId, libraryCode) {
        if (typeof libraryCode !== 'string') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Attempted to inject non-string code for library ${libraryId}.`);
            throw new Error("Invalid script content: must be a string.");
        }
        if (libraryCode.trim() === "") {
            // Allow injecting empty scripts if that's intended, but log a warning.
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Injecting empty script for library ${libraryId}. This might be intentional.`);
        }

        const scriptElementId = `${SCRIPT_TAG_ID_PREFIX}${libraryId}`;
        this.removeScriptElementById(scriptElementId); // Ensure idempotency by removing any old script with the same ID.

        const scriptElement = document.createElement('script');
        scriptElement.id = scriptElementId;
        scriptElement.type = 'text/javascript';
        scriptElement.textContent = libraryCode; // Using textContent is generally safer than innerHTML for script tags.
        
        if (!document.head) {
            // This should theoretically never happen in a browser/Electron environment after DOM load.
            console.error(`${PLUGIN_CONSOLE_PREFIX} document.head is not available. Cannot inject script for library ${libraryId}.`);
            throw new Error("document.head not available for script injection.");
        }
        document.head.appendChild(scriptElement);
        return scriptElement;
    }

    /**
     * Removes a script element from the DOM by its ID.
     * Safe to call even if the element doesn't exist.
     * @param {string} scriptElementId - The ID of the script element to remove.
     */
    removeScriptElementById(scriptElementId) {
        const oldScriptElement = document.getElementById(scriptElementId);
        if (oldScriptElement && oldScriptElement.parentNode) {
            oldScriptElement.parentNode.removeChild(oldScriptElement);
        }
    }

    /**
     * Removes a script element, identified by libraryId or by direct reference.
     * Prefers direct reference if provided, otherwise falls back to ID-based removal.
     * @param {string} libraryId - The ID of the library whose script should be removed (used for ID fallback).
     * @param {HTMLScriptElement} [scriptElement] - Optional direct reference to the script element.
     */
    removeScript(libraryId, scriptElement) {
        if (scriptElement && scriptElement.parentNode) {
            scriptElement.parentNode.removeChild(scriptElement);
        } else {
            // Fallback if scriptElement reference is lost, invalid, or not provided.
            this.removeScriptElementById(`${SCRIPT_TAG_ID_PREFIX}${libraryId}`);
        }
    }
}

// --- Library Loading Strategies ---
/**
 * Abstract base class for library loading strategies.
 * Subclasses implement specific methods for fetching script content (e.g., HTTP, local file).
 * @abstract
 */
class AbstractLoaderStrategy {
    /** The Obsidian application instance. @type {import('obsidian').App} */
    app;
    /** The configuration of the library to load. @type {LibraryConfig} */
    library;
    /** Whether to show Obsidian notices during loading. @type {boolean} */
    showNotices;

    /**
     * Creates an instance of AbstractLoaderStrategy.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {LibraryConfig} library - The library configuration.
     * @param {boolean} showNotices - Whether to display notices.
     */
    constructor(app, library, showNotices) {
        this.app = app;
        this.library = library;
        this.showNotices = showNotices;
    }

    /**
     * Fetches the script content. Must be implemented by subclasses.
     * @abstract
     * @returns {Promise<string>} A promise that resolves with the script code as a string.
     * @throws {Error} If fetching fails for any reason (e.g., network error, file not found).
     */
    async fetchScriptContent() {
        throw new Error("fetchScriptContent() must be implemented by concrete loader strategy subclasses.");
    }

    /**
     * Performs any necessary cleanup specific to the loader strategy.
     * For example, an iframe loader might remove the iframe and its event listeners.
     * This method is optional for strategies that don't require explicit cleanup (e.g., local file loader).
     * It should be idempotent (safe to call multiple times).
     */
    cleanup() {
        // Default implementation does nothing. Subclasses should override if cleanup is needed.
    }
}

/**
 * Loads libraries from HTTP(S) URLs using Capacitor's native HTTP plugin (`window.Capacitor.Plugins.CapacitorHttp`).
 * This strategy is primarily intended for Obsidian Mobile, where Capacitor is available.
 * It often bypasses CORS issues encountered by browser-based `fetch`.
 */
class HttpCapacitorLoader extends AbstractLoaderStrategy {
    /**
     * Fetches script content using `window.Capacitor.Plugins.CapacitorHttp.get`.
     * @returns {Promise<string>} The script content as a string.
     * @throws {Error} If the library URL is missing, CapacitorHttp plugin is unavailable, or the HTTP request fails.
     */
    async fetchScriptContent() {
        if (!this.library.url || this.library.url.trim() === "") {
            throw new Error(`Library URL is missing for "${this.library.name}". Please configure it in settings.`);
        }
        
        // Capacitor is globally available on mobile. Check for its presence.
        if (!window.Capacitor?.Plugins?.CapacitorHttp?.get) {
            throw new Error("CapacitorHttp plugin is not available. This loading method is primarily for Obsidian Mobile. Consider using 'HTTP (Iframe)' type for desktop or if CapacitorHttp is missing on mobile.");
        }

        if (this.showNotices) new Notice(`ScriptPilot: Fetching "${this.library.name}" via CapacitorHTTP...`, 3000);
        try {
            const response = await window.Capacitor.Plugins.CapacitorHttp.get({ url: this.library.url });
            if (response && response.status >= 200 && response.status < 300 && typeof response.data === 'string') {
                return response.data;
            } else {
                const statusInfo = response ? `Status: ${response.status}` : "No response object received";
                const dataInfo = response && response.data ? `Data preview (first 100 chars): ${String(response.data).substring(0, 100)}` : "No data in response";
                throw new Error(`Fetch failed. ${statusInfo}. ${dataInfo}. Please check the URL and your network connection.`);
            }
        } catch (error) {
            throw new Error(`CapacitorHttp request failed for ${this.library.url}: ${error.message || String(error)}. Ensure the URL is correct, accessible, and that the network is available.`);
        }
    }
}

/**
 * Loads libraries from HTTP(S) URLs using a hidden iframe.
 * This method works on both Desktop and Mobile but is subject to Cross-Origin Resource Sharing (CORS) policies
 * enforced by the server hosting the script.
 */
class HttpIframeLoader extends AbstractLoaderStrategy {
    /** The hidden iframe element used for fetching. @type {HTMLIFrameElement | null} */
    iframe = null;
    /** Listener for messages from the iframe. @type {EventListenerObject | null} */
    messageListener = null;
    /** Timeout ID for the iframe loading process. @type {number | null} */
    iframeTimeoutId = null;

    /**
     * Fetches script content by creating a hidden iframe. The iframe internally fetches the script
     * and uses `postMessage` to send the content back to the main window.
     * @returns {Promise<string>} The script content as a string.
     * @throws {Error} If URL is missing, `document.body` is unavailable, fetch fails (e.g., CORS, network error), or timeout occurs.
     */
    async fetchScriptContent() {
        if (!this.library.url || this.library.url.trim() === "") {
            throw new Error(`Library URL is missing for "${this.library.name}". Please configure it in settings.`);
        }

        if (this.showNotices) new Notice(`ScriptPilot: Fetching "${this.library.name}" via Iframe (CORS dependent)...`, 3000);
        this.cleanup(); // Ensure any previous iframe/listeners for this loader instance are cleared.

        this.iframe = document.createElement('iframe');
        this.iframe.style.display = 'none'; // Keep it hidden from the user.
        // Sandbox attribute restricts iframe capabilities for security.
        // 'allow-scripts' is needed for the iframe's internal script to run.
        // 'allow-same-origin' is needed for postMessage to work reliably with srcdoc iframes (origin can be 'null').
        this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin'); 

        if (!document.body) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} document.body is not available. Cannot inject iframe for "${this.library.name}".`);
            throw new Error("document.body not available for iframe injection.");
        }
        document.body.appendChild(this.iframe);

        const messageSuccessType = `${this.library.id}${IFRAME_MESSAGE_TYPE_SUCCESS_SUFFIX}`;
        const messageErrorType = `${this.library.id}${IFRAME_MESSAGE_TYPE_ERROR_SUFFIX}`;

        return new Promise((resolve, reject) => {
            this.iframeTimeoutId = window.setTimeout(() => {
                // Check if this specific timeout is still active (i.e., not cleared by a successful message or earlier cleanup)
                if (this.iframeTimeoutId !== null) { 
                    this.cleanup(); // Important: clean up resources on timeout
                    reject(new Error(`Timeout: Iframe did not return script for "${this.library.name}" within ${IFRAME_LOAD_TIMEOUT_MS / 1000}s. This could be due to network issues, CORS restrictions, an invalid URL, or the script itself being very large. Check the developer console for more details.`));
                }
            }, IFRAME_LOAD_TIMEOUT_MS);

            this.messageListener = (event) => {
                // Validate message origin and content to ensure it's from our iframe and relevant.
                if (!event.data || event.data.libId !== this.library.id || (event.data.type !== messageSuccessType && event.data.type !== messageErrorType)) {
                    return; // Not a message for us.
                }
                // Ensure message is from the iframe we created.
                if (!this.iframe || event.source !== this.iframe.contentWindow) {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Iframe message for "${this.library.name}" received from an unexpected source. Origin:`, event.origin);
                    return;
                }

                this.cleanup(); // Clear resources (timeout, listener, iframe) once a valid message is received.

                if (event.data.type === messageSuccessType) {
                    if (typeof event.data.code === 'string') {
                        resolve(event.data.code);
                    } else {
                        reject(new Error(`Iframe returned success for "${this.library.name}" but script code was missing or not a string.`));
                    }
                } else if (event.data.type === messageErrorType) {
                    reject(new Error(`Iframe reported error for "${this.library.name}": ${event.data.message || 'Unknown error from iframe.'} This is often a CORS issue or network problem. Check developer console for more specific errors from the iframe's fetch attempt.`));
                }
            };
            window.addEventListener('message', this.messageListener);

            // The content of the iframe: a script that fetches the library and posts it back to the parent window.
            // JSON.stringify is used for safe embedding of URL and IDs into the script string.
            // Using 'cors' mode for the fetch request.
            // The targetOrigin for postMessage is '*' - while specific origins are safer,
            // for srcdoc iframes, the origin can be 'null' or complex. Given the context
            // (parent controls iframe content, and iframe is sandboxed), this is generally acceptable here.
            // The main security concern is the script being loaded, not this specific postMessage channel.
            const iframeContent = `
                <!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
                (async () => {
                    try {
                        const response = await fetch(${JSON.stringify(this.library.url)}, { mode: 'cors' });
                        if (!response.ok) {
                            throw new Error(\`HTTP error! Status: \${response.status} for URL: \${${JSON.stringify(this.library.url)}}\`);
                        }
                        const scriptContent = await response.text();
                        window.parent.postMessage({ type: '${messageSuccessType}', code: scriptContent, libId: '${this.library.id}' }, '*');
                    } catch (error) {
                        window.parent.postMessage({ type: '${messageErrorType}', message: error.message || String(error), libId: '${this.library.id}' }, '*');
                    }
                })();
                <\/script></body></html>`; // Note: `<\/script>` is used to prevent issues if this string is embedded in another script tag.
            
            if (this.iframe && this.iframe.contentWindow) { // Ensure iframe and its contentWindow exist before setting srcdoc
                this.iframe.srcdoc = iframeContent;
            } else {
                this.cleanup(); // Cleanup if iframe became invalid before srcdoc could be set
                reject(new Error(`Iframe for "${this.library.name}" was removed or became invalid before its content could be loaded.`));
            }
        });
    }

    /**
     * Cleans up resources used by the iframe loader: the timeout, the message event listener, and the iframe element itself.
     * This method is idempotent and safe to call multiple times.
     */
    cleanup() {
        if (this.iframeTimeoutId !== null) {
            clearTimeout(this.iframeTimeoutId);
            this.iframeTimeoutId = null;
        }
        if (this.messageListener) {
            window.removeEventListener('message', this.messageListener);
            this.messageListener = null;
        }
        if (this.iframe) {
            if (this.iframe.parentNode) {
                this.iframe.parentNode.removeChild(this.iframe);
            }
            this.iframe = null;
        }
    }
}

/**
 * Loads libraries from local .js files within the Obsidian vault.
 * Uses Obsidian's Vault API to read file content.
 */
class LocalFileLoader extends AbstractLoaderStrategy {
    /**
     * Fetches script content from a local file in the vault.
     * @returns {Promise<string>} The script content as a string.
     * @throws {Error} If file path is missing, invalid (not .js), not found, or points to a folder.
     * Also throws if reading the file fails.
     */
    async fetchScriptContent() {
        if (!this.library.filePath || this.library.filePath.trim() === "") {
            throw new Error(`Library File Path is missing for "${this.library.name}". Please configure it in settings.`);
        }
        if (!this.library.filePath.toLowerCase().endsWith('.js')) {
            throw new Error(`File path "${this.library.filePath}" for "${this.library.name}" must end with .js. Please correct it in settings.`);
        }

        const abstractFile = this.app.vault.getAbstractFileByPath(this.library.filePath);
        if (!abstractFile) {
            throw new Error(`File not found at path "${this.library.filePath}" for "${this.library.name}". Ensure the path is correct and the file exists in your vault.`);
        }
        if (!(abstractFile instanceof TFile)) {
            throw new Error(`Path "${this.library.filePath}" for "${this.library.name}" points to a folder, not a file. Please select a .js file.`);
        }

        if (this.showNotices) new Notice(`ScriptPilot: Reading "${this.library.name}" from "${this.library.filePath}"...`, 3000);
        try {
            const libraryCode = await this.app.vault.read(abstractFile);
            if (typeof libraryCode !== 'string') {
                // This case should be rare with app.vault.read on a TFile but included for robustness.
                throw new Error(`File content from "${this.library.filePath}" for "${this.library.name}" could not be read as a string.`);
            }
            return libraryCode;
        } catch (error) {
            throw new Error(`Failed to read file "${this.library.filePath}" for "${this.library.name}": ${error.message || String(error)}`);
        }
    }
    // No specific cleanup needed for LocalFileLoader as it doesn't hold external resources like iframes or listeners.
}

// --- Library State Manager ---
/**
 * @typedef {Object} LibraryRuntimeState
 * @property {boolean} isLoading - Whether the library is currently in the process of loading.
 * @property {boolean} isLoaded - Whether the library has been successfully loaded and its init script (if any) run.
 * @property {HTMLScriptElement} [scriptElement] - The injected script tag element, if loaded. Stored for potential removal.
 * @property {string} [lastError] - The last error message encountered during loading, execution, or unloading.
 * @property {boolean} [globalObjectPresent] - Whether the specified `globalObjectName` (if any) is detected in `window`.
 * @property {AbstractLoaderStrategy} [activeLoader] - The loader strategy instance used for the current/last load attempt. Stored for cleanup.
 */

/**
 * Manages the runtime state of all configured libraries (e.g., loaded, loading, errors).
 * Emits events when states change, allowing other components (like UI) to react.
 * Extends Obsidian's Events class for a standard event emitting/listening mechanism.
 */
class LibraryStateManager extends Events {
    /**
     * Stores the runtime state of each library, keyed by library ID.
     * @type {Map<string, LibraryRuntimeState>}
     */
    libraryStates = new Map();

    /**
     * Ensures a state object exists for a given library ID, creating a default one if not.
     * This is an internal helper to simplify state management.
     * @private
     * @param {string} libraryId - The ID of the library.
     * @returns {LibraryRuntimeState} The state object for the library.
     */
    _ensureState(libraryId) {
        if (!this.libraryStates.has(libraryId)) {
            this.libraryStates.set(libraryId, { isLoading: false, isLoaded: false });
        }
        return this.libraryStates.get(libraryId);
    }

    /**
     * Updates the state for a given library ID with the provided changes.
     * Triggers a 'state-change' event with the library ID and a copy of its new state.
     * @param {string} libraryId - The ID of the library.
     * @param {Partial<LibraryRuntimeState>} changes - An object containing state properties to update.
     */
    updateState(libraryId, changes) {
        const state = this._ensureState(libraryId);
        Object.assign(state, changes);
        this.libraryStates.set(libraryId, state);
        this.trigger('state-change', libraryId, { ...state }); // Emit a copy to prevent external modification of internal state.
    }

    /**
     * Retrieves the current runtime state for a library.
     * @param {string} libraryId - The ID of the library.
     * @returns {LibraryRuntimeState | undefined} The state object, or undefined if no state is tracked for this ID.
     */
    getState(libraryId) {
        const state = this.libraryStates.get(libraryId);
        return state ? { ...state } : undefined; // Return a copy
    }

    /**
     * Counts how many of the configured libraries are currently marked as loaded.
     * @param {LibraryConfig[]} librariesConfig - Array of all configured libraries (from settings).
     * @returns {number} The number of loaded libraries.
     */
    getLoadedCount(librariesConfig) {
        let count = 0;
        librariesConfig.forEach(lib => {
            if (this.libraryStates.get(lib.id)?.isLoaded) {
                count++;
            }
        });
        return count;
    }

    /**
     * Counts how many libraries are currently in the process of loading.
     * @returns {number} The number of libraries currently being loaded.
     */
    getLoadingCount() {
        let count = 0;
        this.libraryStates.forEach(state => { // Iterate over internal map directly
            if (state.isLoading) {
                count++;
            }
        });
        return count;
    }

    /**
     * Checks if the expected global object for a specific library (if defined in its config) is present in `window`.
     * Updates the library's state (`globalObjectPresent`) if its presence status changes.
     * @param {LibraryConfig} libraryConfig - The configuration of the library to check.
     * @returns {boolean} True if the global object presence status changed as a result of this check, false otherwise.
     */
    checkGlobalObjectPresence(libraryConfig) {
        const state = this.libraryStates.get(libraryConfig.id); // Get direct reference for update
        if (!state) return false;

        let changed = false;
        if (state.isLoaded && libraryConfig.globalObjectName) {
            const oldGlobalObjectPresent = state.globalObjectPresent;
            const newGlobalObjectPresent = typeof Utils.getProperty(window, libraryConfig.globalObjectName) !== 'undefined';
            if (newGlobalObjectPresent !== oldGlobalObjectPresent) {
                this.updateState(libraryConfig.id, { globalObjectPresent: newGlobalObjectPresent });
                changed = true;
            }
        } else if (state.globalObjectPresent === true && !state.isLoaded) {
            // If library was unloaded but global object was previously marked as present, reset its status.
            this.updateState(libraryConfig.id, { globalObjectPresent: false });
            changed = true;
        }
        return changed;
    }

    /**
     * Checks the global object presence for all configured libraries.
     * @param {LibraryConfig[]} librariesConfig - Array of all configured libraries.
     * @returns {boolean} True if any library's global object presence status changed, false otherwise.
     */
    checkAllGlobalObjectsPresence(librariesConfig) {
        let changedOverall = false;
        librariesConfig.forEach(lib => {
            if (this.checkGlobalObjectPresence(lib)) {
                changedOverall = true;
            }
        });
        return changedOverall;
    }

    /**
     * Deletes the state for a library and performs cleanup for its active loader (e.g., remove iframe).
     * Triggers a 'state-delete' event with the library ID.
     * @param {string} libraryId - The ID of the library whose state is to be deleted.
     */
    deleteState(libraryId) {
        const state = this.libraryStates.get(libraryId);
        if (state?.activeLoader) {
            state.activeLoader.cleanup(); // Crucial for releasing resources like iframes or listeners.
        }
        this.libraryStates.delete(libraryId);
        this.trigger('state-delete', libraryId);
    }

    /**
     * Cleans up all library states. This involves calling `cleanup()` on any active loaders
     * and removing associated script elements from the DOM.
     * This is typically called when the plugin is unloading to ensure a clean shutdown.
     * Triggers an 'all-states-cleared' event.
     * @param {LibraryConfig[]} librariesConfig - Array of all configured libraries.
     * @param {ScriptInjectorService} scriptInjector - The service used to remove script tags.
     */
    cleanupAllStates(librariesConfig, scriptInjector) {
        librariesConfig.forEach(lib => {
            const state = this.libraryStates.get(lib.id);
            if (state) {
                if (state.activeLoader) {
                    state.activeLoader.cleanup();
                }
                // Script element removal is primarily handled by LibraryController during unload,
                // but this ensures cleanup if a script was injected but its state is being cleared abruptly.
                if (state.scriptElement) {
                    scriptInjector.removeScript(lib.id, state.scriptElement);
                }
            }
        });
        this.libraryStates.clear();
        this.trigger('all-states-cleared');
    }
}


// --- Library Controller ---
/**
 * Orchestrates the loading and unloading of libraries.
 * It selects the appropriate loader strategy, manages script injection via `ScriptInjectorService`,
 * and updates library states through `LibraryStateManager`.
 */
class LibraryController {
    /** The Obsidian application instance. @type {import('obsidian').App} */
    app;
    /** Function to get current plugin settings. @type {() => typeof DEFAULT_SETTINGS} */
    getSettings;
    /** Manages library runtime states. @type {LibraryStateManager} */
    stateManager;
    /** Injects/removes script tags. @type {ScriptInjectorService} */
    scriptInjector;

    /**
     * Creates an instance of LibraryController.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {() => typeof DEFAULT_SETTINGS} settingsGetter - A function that returns the current plugin settings.
     * @param {LibraryStateManager} stateManager - The library state manager instance.
     * @param {ScriptInjectorService} scriptInjector - The script injector service instance.
     */
    constructor(app, settingsGetter, stateManager, scriptInjector) {
        this.app = app;
        this.getSettings = settingsGetter;
        this.stateManager = stateManager;
        this.scriptInjector = scriptInjector;
    }

    /**
     * Selects and instantiates the appropriate loader strategy based on the library's configured type.
     * @private
     * @param {LibraryConfig} library - The library configuration.
     * @param {boolean} showNotices - Whether to display notices during loading.
     * @returns {AbstractLoaderStrategy} The chosen loader strategy instance.
     * @throws {Error} If the library type is unknown or invalid.
     */
    _getLoaderStrategy(library, showNotices) {
        switch (library.type) {
            case 'http':
                return new HttpCapacitorLoader(this.app, library, showNotices);
            case 'http-iframe':
                return new HttpIframeLoader(this.app, library, showNotices);
            case 'localFile':
                return new LocalFileLoader(this.app, library, showNotices);
            default:
                throw new Error(`Unknown library type: "${library.type}" for library "${library.name}". Please select a valid type in settings.`);
        }
    }

    /**
     * Loads a specified library.
     * This involves:
     * 1. Selecting a loader strategy.
     * 2. Fetching the library's code using the strategy.
     * 3. Injecting the code as a script tag.
     * 4. Running its initialization script (if provided).
     * Updates the library's state via the `LibraryStateManager` throughout the process.
     * @param {LibraryConfig} library - The configuration of the library to load.
     * @param {boolean} showNotices - Whether to display Obsidian notices during the process.
     * @returns {Promise<void>} A promise that resolves when the loading process is complete (successfully or with an error).
     */
    async loadLibrary(library, showNotices) {
        if (!library || !library.id) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Attempted to load an invalid library object (missing ID or object itself).`);
            if (showNotices) new Notice("ScriptPilot: Cannot load library: Invalid library configuration data.", 5000);
            return;
        }
        if (!library.type) {
            const errorMsg = `Cannot load "${library.name || library.id}": Library type is not defined. Please edit the library settings and choose a type (e.g., Local File, HTTP).`;
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 7000);
            console.warn(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            this.stateManager.updateState(library.id, { lastError: "Library type undefined.", isLoading: false, isLoaded: false });
            return;
        }

        const state = this.stateManager._ensureState(library.id); // Get direct ref to update
        if (state.isLoading) {
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" is already in the process of loading. Please wait.`, 3000);
            return;
        }
        if (state.isLoaded) {
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" is already loaded. To reload, please unload it first.`, 3000);
            return;
        }

        this.stateManager.updateState(library.id, { isLoading: true, lastError: undefined, scriptElement: undefined, activeLoader: undefined });
        let loaderStrategy; // To hold the strategy instance for potential cleanup

        try {
            loaderStrategy = this._getLoaderStrategy(library, showNotices);
            this.stateManager.updateState(library.id, { activeLoader: loaderStrategy });

            const libraryCode = await loaderStrategy.fetchScriptContent();
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" content fetched. Injecting script...`, 2000);

            const scriptElement = this.scriptInjector.injectScript(library.id, libraryCode);
            this.stateManager.updateState(library.id, { scriptElement });

            // Run initialization script if provided
            if (library.initializationScript && library.initializationScript.trim() !== "") {
                const initResult = await Utils.executeUserScript(
                    library.initializationScript, library.name, 'initialization', showNotices
                );
                if (!initResult.success) {
                    // Error from init script is considered a load failure for the library.
                    throw new Error(initResult.error || `Initialization script for "${library.name}" failed without a specific error message.`);
                }
            }

            this.stateManager.updateState(library.id, {
                isLoaded: true,
                isLoading: false,
                globalObjectPresent: library.globalObjectName ? (typeof Utils.getProperty(window, library.globalObjectName) !== 'undefined') : undefined,
                lastError: undefined // Clear any previous errors on successful load
            });
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" loaded and injected successfully!`, 4000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) loaded and injected.`);

        } catch (error) {
            const errorMsg = `Failed to load "${library.name}": ${error.message || String(error)}`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, error);
            
            // Cleanup partially loaded resources if an error occurred
            const currentState = this.stateManager.getState(library.id); // Get a fresh copy of state
            if (currentState?.scriptElement) { // Check if scriptElement was set in state
                this.scriptInjector.removeScript(library.id, currentState.scriptElement);
            }
            if (loaderStrategy) { // Cleanup loader strategy if it was instantiated (e.g., remove iframe)
                loaderStrategy.cleanup();
            }

            this.stateManager.updateState(library.id, {
                isLoaded: false,
                isLoading: false,
                scriptElement: undefined, // Ensure scriptElement is cleared from state
                lastError: error.message || String(error),
                activeLoader: undefined // Clear active loader from state on failure
            });
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 7000);
        }
    }

    /**
     * Unloads a specified library.
     * This involves:
     * 1. Running its destruction script (if provided).
     * 2. Removing its injected script tag from the DOM.
     * 3. Attempting to delete its global object from `window` (if specified in config).
     * 4. Cleaning up any resources used by its loader strategy (e.g., iframe).
     * Updates the library's state via `LibraryStateManager`.
     * @param {LibraryConfig} library - The configuration of the library to unload.
     * @param {boolean} showNotices - Whether to display Obsidian notices during the process.
     * @returns {Promise<void>} A promise that resolves when the unloading process is complete.
     */
    async unloadLibrary(library, showNotices) {
        if (!library || !library.id) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Attempted to unload an invalid library object (missing ID or object itself).`);
            if (showNotices) new Notice("ScriptPilot: Cannot unload library: Invalid library configuration data.", 5000);
            return;
        }

        const state = this.stateManager.getState(library.id); // Get a copy of state
        if (!state || (!state.isLoaded && !state.isLoading)) {
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" is not currently loaded or loading. Nothing to unload.`, 3000);
            if (state) this.stateManager.updateState(library.id, { isLoading: false }); // Ensure isLoading is false if state exists but not loaded/loading
            return;
        }
        // Prevent unloading if it's in the middle of loading. This should ideally be handled by UI disabling unload actions.
        if (state.isLoading) {
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" is currently loading. Please wait for loading to complete before attempting to unload.`, 4000);
            return;
        }

        if (showNotices) new Notice(`ScriptPilot: Unloading "${library.name}"...`, 2000);
        let unloadedGracefully = true;
        let destructionErrorOccurred = false;
        let accumulatedErrors = state.lastError ? [state.lastError] : []; // Preserve previous errors if any

        try {
            // Run destruction script if provided
            if (library.destructionScript && library.destructionScript.trim() !== "") {
                const destroyResult = await Utils.executeUserScript(
                    library.destructionScript, library.name, 'destruction', showNotices
                );
                if (!destroyResult.success) {
                    destructionErrorOccurred = true;
                    unloadedGracefully = false; // Destruction failure means not fully graceful
                    if(destroyResult.error) accumulatedErrors.push(destroyResult.error);
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Destruction script for "${library.name}" encountered errors. See details above.`);
                }
            }

            // Remove the script tag
            // Use scriptElement from the state map, as the direct state variable might be a copy
            const liveState = this.stateManager.libraryStates.get(library.id);
            if (liveState?.scriptElement) {
                this.scriptInjector.removeScript(library.id, liveState.scriptElement);
                console.log(`${PLUGIN_CONSOLE_PREFIX} Script tag for "${library.name}" removed.`);
            }

            // Attempt to delete the global object if specified
            if (library.globalObjectName && library.globalObjectName.trim() !== "") {
                if (Utils.deleteProperty(window, library.globalObjectName.trim())) {
                    console.log(`${PLUGIN_CONSOLE_PREFIX} Attempted to delete global object 'window.${library.globalObjectName}' for "${library.name}".`);
                } else {
                    // This is a warning, not necessarily a critical failure of unload.
                    // Some global objects might be non-configurable or have already been removed by the destruction script.
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Global object 'window.${library.globalObjectName}' for "${library.name}" was not found or could not be deleted/undefined. It might persist if not handled by its destruction script.`);
                }
            }
        } catch (e) {
            // Catch any unexpected errors during the unload process itself (e.g., error in scriptInjector)
            unloadedGracefully = false;
            const errorMsg = `Unexpected error during "${library.name}" unload process: ${e.message || String(e)}`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, e);
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 5000);
            accumulatedErrors.push(`Unload process error: ${e.message || String(e)}`);
        } finally {
            // Cleanup loader strategy (e.g., remove iframe) - crucial step
            // Use activeLoader from the state map
            const liveState = this.stateManager.libraryStates.get(library.id);
            if (liveState?.activeLoader) {
                liveState.activeLoader.cleanup();
            }

            const finalStateUpdate = {
                isLoaded: false,
                isLoading: false,
                scriptElement: undefined, // Ensure scriptElement is cleared from state
                globalObjectPresent: false, // Assume not present after unload attempt; will be re-checked if reloaded
                activeLoader: undefined, // Clear active loader from state
                lastError: unloadedGracefully ? undefined : (accumulatedErrors.join("; ") || "Unload completed with unspecified issues. Check console.")
            };
            this.stateManager.updateState(library.id, finalStateUpdate);

            if (unloadedGracefully) {
                if (showNotices) new Notice(`ScriptPilot: "${library.name}" unloaded. For complex libraries that deeply integrate with Obsidian or modify global state extensively, restarting Obsidian is the most reliable way to ensure complete removal of their effects.`, 6000);
                console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) unloaded.`);
            } else {
                const noticeMsg = destructionErrorOccurred ?
                    `"${library.name}" unloaded, but its destruction script had errors. Some state or effects might persist.` :
                    `"${library.name}" unloaded, but there might have been issues during the process. Some state or effects might persist.`;
                if (showNotices) new Notice(`ScriptPilot: ${noticeMsg} Check console for details. Restart Obsidian for a full cleanup if issues occur.`, 8000);
            }
        }
    }

    /**
     * Cleans up all loaded scripts and their associated resources (script tags, loader-specific resources like iframes).
     * Typically called when the plugin is being unloaded to ensure no resources are left behind.
     * @param {LibraryConfig[]} librariesConfig - Array of all configured libraries.
     */
    cleanupAllLoadedScripts(librariesConfig) {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Cleaning up all loaded scripts and loader resources.`);
        // StateManager's cleanupAllStates will handle loader cleanup and script tag removal.
        this.stateManager.cleanupAllStates(librariesConfig, this.scriptInjector);
    }
}

// --- Settings Manager ---
/**
 * Manages loading and saving of plugin settings.
 * Handles migration of older settings formats and ensures data integrity by merging with defaults.
 */
class PluginSettingsManager {
    /** The main plugin instance. @type {ScriptPilotPlugin} */
    plugin;

    /**
     * Creates an instance of PluginSettingsManager.
     * @param {ScriptPilotPlugin} plugin - The main plugin instance.
     */
    constructor(plugin) {
        this.plugin = plugin;
    }

    /**
     * Loads plugin settings from Obsidian's storage.
     * Merges loaded data with default settings to ensure all keys are present.
     * Performs basic data validation and migration for older settings formats.
     * Initializes runtime states for each configured library.
     * @returns {Promise<void>}
     */
    async load() {
        const loadedData = await this.plugin.loadData();
        // Deep clone DEFAULT_SETTINGS to prevent modification of the constant, then merge with loaded data.
        this.plugin.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), loadedData);
        
        let settingsChanged = false; // Flag to trigger a save if migrations or defaults application occur.

        if (!Array.isArray(this.plugin.settings.libraries)) {
            this.plugin.settings.libraries = []; // Ensure libraries is always an array.
            settingsChanged = true;
        }

        // Ensure each library has essential fields and a corresponding runtime state entry.
        (this.plugin.settings.libraries || []).forEach(lib => {
            if (!lib.id) {
                lib.id = Utils.generateUniqueId(); // Assign a new ID if missing.
                settingsChanged = true;
            }
            // Basic type inference / migration for older settings formats.
            if (!lib.type) {
                if (lib.url && (lib.url.startsWith('http://') || lib.url.startsWith('https://'))) {
                     lib.type = 'http-iframe'; // Default to iframe for http for broader compatibility initially.
                } else if (lib.filePath) {
                    lib.type = 'localFile';
                } else if (lib.cdnUrl) { // Example: Legacy migration from a hypothetical older version field.
                    lib.type = 'http-iframe'; 
                    lib.url = lib.cdnUrl; 
                    delete lib.cdnUrl; // Remove old field.
                }
                // If type was inferred or migrated, mark settings as changed.
                if(lib.type) {
                    settingsChanged = true;
                } else {
                    // Log a warning if type cannot be inferred, user needs to manually set it.
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Library "${lib.name || lib.id}" has no type and it could not be automatically inferred. Please edit this library in settings and assign a valid type (e.g., Local File, HTTP).`);
                }
            }
            // Ensure essential fields have default values if missing.
            // This makes the plugin more resilient to partially formed settings.
            if (typeof lib.url === 'undefined') { lib.url = ''; settingsChanged = true; }
            if (typeof lib.filePath === 'undefined') { lib.filePath = ''; settingsChanged = true; }
            if (typeof lib.isEnabled === 'undefined') { lib.isEnabled = false; settingsChanged = true; }
            if (typeof lib.loadOrder === 'undefined' || isNaN(parseInt(String(lib.loadOrder),10))) { lib.loadOrder = 0; settingsChanged = true; }
            if (typeof lib.name === 'undefined' || String(lib.name).trim() === "") { lib.name = `Library ${lib.id.substring(0,8)}`; settingsChanged = true; }
            if (typeof lib.initializationScript === 'undefined') { lib.initializationScript = ''; settingsChanged = true; }
            if (typeof lib.destructionScript === 'undefined') { lib.destructionScript = ''; settingsChanged = true; }
            if (typeof lib.globalObjectName === 'undefined') { lib.globalObjectName = ''; settingsChanged = true; }

            // Ensure a runtime state entry exists for this library in the LibraryStateManager.
            this.plugin.libraryStateManager._ensureState(lib.id); 
        });

        if (settingsChanged) {
            console.log(`${PLUGIN_CONSOLE_PREFIX} Settings were migrated or defaults applied. Saving updated settings configuration.`);
            await this.save(); // Persist changes if any occurred during load.
        }
    }

    /**
     * Saves the current plugin settings to Obsidian's storage.
     * @returns {Promise<void>}
     */
    async save() {
        await this.plugin.saveData(this.plugin.settings);
    }
}

// --- Command Orchestrator ---
/**
 * Manages the registration and cleanup of Obsidian commands for the plugin.
 * This includes global plugin commands (e.g., load all, unload all) and
 * library-specific commands (e.g., load/unload individual library).
 */
class CommandOrchestrator {
    /** The main plugin instance. @type {ScriptPilotPlugin} */
    plugin;
    /**
     * Stores IDs of commands registered for each library, to facilitate their removal when
     * libraries are deleted or plugin unloads. Key: library ID, Value: array of command IDs.
     * @type {Map<string, string[]>}
     */
    libraryCommandIds = new Map();

    /**
     * Creates an instance of CommandOrchestrator.
     * @param {ScriptPilotPlugin} plugin - The main plugin instance.
     */
    constructor(plugin) {
        this.plugin = plugin;
    }

    /**
     * Adds global plugin commands (e.g., load all, unload all, open settings).
     * These commands are generally static throughout the plugin's lifecycle.
     */
    addPluginCommands() {
        this.plugin.addCommand({
            id: 'load-all-enabled-scripts',
            name: 'ScriptPilot: Load All Enabled Libraries',
            callback: async () => {
                new Notice('ScriptPilot: Initiating load for all enabled libraries...', 2000);
                await this.plugin.loadAllEnabledLibraries(true); // Show individual notices for each library
            },
        });

        this.plugin.addCommand({
            id: 'unload-all-loaded-scripts',
            name: 'ScriptPilot: Unload All Loaded Libraries',
            callback: async () => {
                new Notice('ScriptPilot: Initiating unload for all loaded libraries...', 2000);
                await this.plugin.unloadAllLoadedLibraries(true); // Show individual notices
            },
        });

        this.plugin.addCommand({
            id: 'open-scriptpilot-settings',
            name: 'ScriptPilot: Open Settings',
            callback: () => {
                // Official way to open a plugin's settings tab.
                this.plugin.app.setting.open();
                this.plugin.app.setting.openTabById(this.plugin.manifest.id);
            },
        });
    }

    /**
     * Adds specific commands for a given library (load, unload, toggle).
     * Commands are only added if the library configuration is valid (has an ID and type).
     * These commands are dynamic and depend on the library's current state.
     * @param {LibraryConfig} library - The library configuration.
     */
    addLibrarySpecificCommands(library) {
        if (!library || !library.id || !library.type) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Cannot add commands for library "${library.name || library.id}" due to missing ID or type information.`);
            return;
        }
        // Clean up any old commands for this library first to prevent duplicates if this is an update.
        this.removeLibrarySpecificCommands(library.id); 

        // Sanitize library ID for use in command ID (Obsidian command IDs have restrictions).
        const sanitizedId = library.id.replace(/[^a-zA-Z0-9-_]/g, ''); 
        const commandIdBase = `scriptpilot:${sanitizedId}`;
        const currentCommandIds = []; // Track IDs of commands added in this call.

        let typePrefix = 'Unknown Type';
        if (library.type === 'http') typePrefix = 'HTTP (Mobile)';
        else if (library.type === 'localFile') typePrefix = 'Local File';
        else if (library.type === 'http-iframe') typePrefix = 'HTTP (Iframe)';

        const loadCmd = this.plugin.addCommand({
            id: `${commandIdBase}:load`,
            name: `ScriptPilot: Load (${typePrefix}) - ${library.name}`,
            checkCallback: (checking) => { // checkCallback controls command visibility and execution
                const state = this.plugin.libraryStateManager.getState(library.id);
                const canLoad = !!library.type && (!state || (!state.isLoaded && !state.isLoading));
                if (checking) return canLoad; // For command palette to show/hide based on canLoad
                if (canLoad) {
                    this.plugin.libraryController.loadLibrary(library, true);
                }
                return true; // Indicate command was handled (or would have been)
            }
        });
        if (loadCmd) currentCommandIds.push(loadCmd.id);

        const unloadCmd = this.plugin.addCommand({
            id: `${commandIdBase}:unload`,
            name: `ScriptPilot: Unload (${typePrefix}) - ${library.name}`,
            checkCallback: (checking) => {
                const state = this.plugin.libraryStateManager.getState(library.id);
                const canUnload = !!library.type && !!state && state.isLoaded && !state.isLoading;
                if (checking) return canUnload;
                if (canUnload) {
                    this.plugin.libraryController.unloadLibrary(library, true);
                }
                return true;
            }
        });
        if (unloadCmd) currentCommandIds.push(unloadCmd.id);

        const toggleCmd = this.plugin.addCommand({
            id: `${commandIdBase}:toggle`,
            name: `ScriptPilot: Toggle Load/Unload (${typePrefix}) - ${library.name}`,
            checkCallback: (checking) => {
                const state = this.plugin.libraryStateManager.getState(library.id);
                // Can toggle if type is defined and not currently in the middle of loading/unloading.
                const canToggle = !!library.type && (!state || !state.isLoading);
                if (checking) return canToggle;
                if (canToggle) {
                    if (state?.isLoaded) {
                        this.plugin.libraryController.unloadLibrary(library, true);
                    } else {
                        this.plugin.libraryController.loadLibrary(library, true);
                    }
                }
                return true;
            }
        });
        if (toggleCmd) currentCommandIds.push(toggleCmd.id);

        if (currentCommandIds.length > 0) {
            this.libraryCommandIds.set(library.id, currentCommandIds);
        }
    }

    /**
     * Removes all library-specific commands previously registered for a given library ID.
     * This is used when a library is deleted or when commands are being updated.
     * @param {string} libraryId - The ID of the library whose commands should be removed.
     */
    removeLibrarySpecificCommands(libraryId) {
        const commandIds = this.libraryCommandIds.get(libraryId);
        if (commandIds?.length > 0) {
            commandIds.forEach(cmdId => {
                try {
                    // Use Obsidian's API to remove a command.
                    // This might be `this.plugin.app.commands.removeCommand(cmdId);`
                    // or `(this.plugin.app as any).commands.removeCommand(cmdId);` if types are strict.
                    // For a standard JS plugin, it's often available directly.
                    if (this.plugin.app.commands && typeof this.plugin.app.commands.removeCommand === 'function') {
                        this.plugin.app.commands.removeCommand(cmdId);
                    } else {
                        // Fallback for older Obsidian versions or different API structure if necessary
                        // This part might need adjustment based on exact Obsidian API version.
                        // However, `app.commands.removeCommand` is standard.
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} app.commands.removeCommand API not available as expected. Command ${cmdId} might not be removed.`);
                    }
                } catch (e) {
                    // This can happen if Obsidian already cleaned it up (e.g., during unload) or it was never fully added.
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Could not remove command ${cmdId} (may have already been removed or failed to add initially):`, e.message);
                }
            });
            this.libraryCommandIds.delete(libraryId);
        }
    }

    /**
     * Updates all library-specific commands.
     * This typically involves removing all existing ones and re-adding them based on current library configurations.
     * Useful after settings changes (e.g., library name change, type change, addition/removal of libraries).
     */
    updateAllLibraryCommands() {
        // Remove all existing library-specific commands to ensure a clean state and prevent orphans.
        const allLibIds = Array.from(this.libraryCommandIds.keys());
        allLibIds.forEach(libId => this.removeLibrarySpecificCommands(libId));

        // Re-add commands for all currently configured and valid libraries.
        this.plugin.settings.libraries.forEach(lib => {
            if (lib.id && lib.type) { // Ensure library is valid for command creation.
                this.addLibrarySpecificCommands(lib);
            }
        });
    }

    /**
     * Cleans up all library-specific commands. Called when the plugin unloads.
     * Global plugin commands added via `plugin.addCommand` are automatically removed by Obsidian.
     * However, explicit removal of dynamically added commands is good practice.
     */
    cleanupAllCommands() {
        const allLibIds = Array.from(this.libraryCommandIds.keys());
        allLibIds.forEach(libId => this.removeLibrarySpecificCommands(libId));
        this.libraryCommandIds.clear(); // Clear the tracking map.
        console.log(`${PLUGIN_CONSOLE_PREFIX} All library-specific commands cleaned up.`);
    }
}


// --- Main Plugin Class ---
/**
 * ScriptPilotPlugin allows users to load and manage custom JavaScript libraries within Obsidian.
 * It supports loading scripts from local vault files or remote HTTP(S) URLs (via Capacitor or Iframe),
 * provides initialization and destruction script capabilities for fine-grained control,
 * and offers a settings UI for configuration and status monitoring.
 *
 * @extends Plugin
 */
class ScriptPilotPlugin extends Plugin {
    /**
     * Plugin settings, managed by `settingsManager` and persisted by Obsidian.
     * @type {typeof DEFAULT_SETTINGS}
     */
    settings;
    /** Manages loading and saving of settings, including migration. @type {PluginSettingsManager} */
    settingsManager;
    /** Manages runtime state of libraries (loaded, errors, etc.) and emits events. @type {LibraryStateManager} */
    libraryStateManager;
    /** Handles the actual injection and removal of script tags in the DOM. @type {ScriptInjectorService} */
    scriptInjector;
    /** Orchestrates the logic for loading and unloading libraries. @type {LibraryController} */
    libraryController;
    /** Manages registration and cleanup of Obsidian commands. @type {CommandOrchestrator} */
    commandOrchestrator;
    /** Instance of the plugin's settings tab UI. @type {ScriptPilotSettingTab} */
    settingTab;

    /** DOM element for the status bar item, if enabled. @type {HTMLElement | null} */
    statusBarItemEl = null;
    /** Interval ID for real-time status updates (e.g., global object presence). @type {number | null} */
    realtimeStatusIntervalId = null;
    /** Current frequency of real-time updates, used to detect changes. @type {number} */
    currentRealtimeUpdateFrequency = 0;

    // Bound event handlers for correct `this` context and proper removal during unload.
    /** @private Bound version of _handleLibraryStateChange. */
    boundHandleLibraryStateChange;
    /** @private Bound version of _handleLibraryStateDelete. */
    boundHandleLibraryStateDelete;
    /** @private Bound version of _handleAllLibraryStatesCleared. */
    boundHandleAllLibraryStatesCleared;


    /**
     * Creates an instance of ScriptPilotPlugin.
     * Initializes all core components of the plugin.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {any} manifest - The plugin manifest, providing ID, version, etc.
     */
    constructor(app, manifest) {
        super(app, manifest);

        this.settingsManager = new PluginSettingsManager(this);
        this.libraryStateManager = new LibraryStateManager();
        this.scriptInjector = new ScriptInjectorService();
        // Pass a getter for settings to ensure LibraryController always has the latest version.
        this.libraryController = new LibraryController(app, () => this.settings, this.libraryStateManager, this.scriptInjector);
        this.commandOrchestrator = new CommandOrchestrator(this);

        // Bind event handlers to `this` context for correct registration and removal.
        this.boundHandleLibraryStateChange = this._handleLibraryStateChange.bind(this);
        this.boundHandleLibraryStateDelete = this._handleLibraryStateDelete.bind(this);
        this.boundHandleAllLibraryStatesCleared = this._handleAllLibraryStatesCleared.bind(this);
    }

    /**
     * Called when the plugin is loaded by Obsidian.
     * Sets up settings, UI elements (ribbon, status bar, settings tab), commands, event listeners,
     * and performs startup loading of libraries if configured.
     * @async
     */
    async onload() {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Loading plugin (Version: ${this.manifest.version}).`);
        await this.settingsManager.load(); // Load settings first, as other components depend on them.

        // Register event listeners for library state changes to update UI components (status bar, settings tab).
        this.libraryStateManager.on('state-change', this.boundHandleLibraryStateChange);
        this.libraryStateManager.on('state-delete', this.boundHandleLibraryStateDelete);
        this.libraryStateManager.on('all-states-cleared', this.boundHandleAllLibraryStatesCleared);

        // Add a ribbon icon to open plugin settings for easy access.
        // 'code-glyph' or 'code' are suitable icons. 'file-code' is also an option.
        this.addRibbonIcon('code-glyph', 'ScriptPilot: Manage Script Libraries', () => {
            this.app.setting.open();
            this.app.setting.openTabById(this.manifest.id);
        });
        // Obsidian automatically cleans up ribbon icons on unload.

        // Register plugin commands (global and library-specific).
        this.commandOrchestrator.addPluginCommands();
        this.commandOrchestrator.updateAllLibraryCommands(); // Initial setup for library-specific commands based on loaded settings.

        // Setup status bar item if enabled in settings.
        if (this.settings.showStatusBar) {
            this.statusBarItemEl = this.addStatusBarItem(); // Obsidian handles cleanup of this on unload.
            this.updateStatusBar(); // Initial update of status bar content.
        }

        // Add the settings tab.
        this.settingTab = new ScriptPilotSettingTab(this.app, this);
        this.addSettingTab(this.settingTab); // Obsidian handles cleanup of settings tabs on unload.

        // Auto-load enabled libraries on startup if configured.
        if (this.settings.loadEnabledOnStartup) {
            // Debounce startup loading to allow Obsidian and other plugins to fully initialize,
            // preventing potential conflicts or premature execution.
            const startupLoader = debounce(async () => {
                console.log(`${PLUGIN_CONSOLE_PREFIX} Auto-loading enabled libraries on startup as per settings.`);
                await this.loadAllEnabledLibraries(false); // Show fewer notices on startup to be less intrusive.
                const loadedCount = this.libraryStateManager.getLoadedCount(this.settings.libraries);
                if (loadedCount > 0) {
                    new Notice(`ScriptPilot: ${loadedCount} libraries auto-loaded successfully.`, 4000);
                } else {
                    console.log(`${PLUGIN_CONSOLE_PREFIX} No enabled libraries found to auto-load on startup, or all failed.`);
                }
            }, 3000, true); // 3-second debounce, execute on leading edge (first call after quiescence).
            startupLoader();
        }

        this._updateRealtimeStatusInterval(); // Initialize or update real-time status monitoring interval based on settings.

        console.log(`${PLUGIN_CONSOLE_PREFIX} Plugin loaded successfully.`);
    }

    /**
     * Called when the plugin is unloaded by Obsidian.
     * Cleans up all resources: unloads libraries, removes commands, clears intervals, removes event listeners,
     * and ensures no lingering effects.
     * @async
     */
    async onunload() {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Unloading plugin.`);

        // Clear real-time status interval.
        // While Obsidian unregisters registered intervals, explicit clearing is good practice.
        if (this.realtimeStatusIntervalId) {
            window.clearInterval(this.realtimeStatusIntervalId);
            this.realtimeStatusIntervalId = null;
        }

        // Unload libraries in reverse load order to handle potential dependencies gracefully.
        const librariesToUnload = [...this.settings.libraries] // Create a copy to avoid modifying settings during iteration.
            .filter(lib => this.libraryStateManager.getState(lib.id)?.isLoaded) // Only unload currently loaded libraries.
            .sort((a, b) => (b.loadOrder || 0) - (a.loadOrder || 0)); // Sort by loadOrder descending.

        console.log(`${PLUGIN_CONSOLE_PREFIX} Unloading ${librariesToUnload.length} libraries.`);
        for (const lib of librariesToUnload) {
            try {
                // Use false for showNotices during plugin unload to avoid spamming the user with notices.
                await this.libraryController.unloadLibrary(lib, false);
            } catch (e) {
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error unloading library "${lib.name}" during plugin unload:`, e);
            }
        }
        
        // Final cleanup of any remaining script tags and loader resources (e.g., iframes).
        // This ensures that even if individual unloads failed, a general cleanup is attempted.
        this.libraryController.cleanupAllLoadedScripts(this.settings.libraries);
        
        // Clean up commands.
        this.commandOrchestrator.cleanupAllCommands();

        // Unregister event listeners to prevent memory leaks and errors after unload.
        if (this.libraryStateManager) {
            this.libraryStateManager.off('state-change', this.boundHandleLibraryStateChange);
            this.libraryStateManager.off('state-delete', this.boundHandleLibraryStateDelete);
            this.libraryStateManager.off('all-states-cleared', this.boundHandleAllLibraryStatesCleared);
        }

        // Status bar item (if created with `addStatusBarItem`), ribbon icon, and settings tab
        // are automatically cleaned up by Obsidian when the plugin unloads.
        // If statusBarItemEl was managed completely manually (not via addStatusBarItem), it would need explicit removal here.
        // Since `addStatusBarItem` is used, Obsidian handles it.
        this.statusBarItemEl = null; // Clear reference.
        
        console.log(`${PLUGIN_CONSOLE_PREFIX} Plugin resources cleaned up and plugin unloaded.`);
    }

    /**
     * Saves current plugin settings and triggers necessary UI updates (status bar, commands, settings tab).
     * This is the primary method other parts of the plugin should call to persist settings changes.
     * @async
     */
    async saveSettings() {
        await this.settingsManager.save();
        this.updateStatusBarDisplay(); // Handles creation/removal of status bar based on settings.
        this._updateRealtimeStatusInterval(); // Update interval based on new settings for real-time panel.
        this.commandOrchestrator.updateAllLibraryCommands(); // Commands might need update if library names/types changed.
        
        // If settings tab is currently open and visible, refresh its display to reflect changes.
        if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
            this.settingTab.debouncedDisplay();
        }
    }
    
    /**
     * Manages the visibility of the status bar item based on current settings.
     * Creates or removes the status bar item as needed.
     */
    updateStatusBarDisplay() {
        if (this.settings.showStatusBar && !this.statusBarItemEl) {
            // If setting enabled and no item exists, create it.
            this.statusBarItemEl = this.addStatusBarItem(); // Let Obsidian manage this.
        } else if (!this.settings.showStatusBar && this.statusBarItemEl) {
            // If setting disabled and item exists, remove it.
            // Obsidian's `addStatusBarItem` returns an element that can be removed.
            this.statusBarItemEl.remove(); 
            this.statusBarItemEl = null;
        }
        this.updateStatusBar(); // Update content if visible.
    }

    /**
     * Updates the content (text and icon) of the status bar item.
     * Reflects the number of loaded and loading scripts, providing at-a-glance status.
     */
    updateStatusBar() {
        if (!this.settings.showStatusBar || !this.statusBarItemEl) return; // Do nothing if status bar is disabled or element doesn't exist.

        const loadedCount = this.libraryStateManager.getLoadedCount(this.settings.libraries);
        const loadingCount = this.libraryStateManager.getLoadingCount();

        this.statusBarItemEl.empty(); // Clear previous content before setting new.

        let statusText = 'ScriptPilot: ';
        let iconKey = 'code-glyph'; // Default/neutral icon

        if (loadingCount > 0) {
            statusText += `Loading ${loadingCount}...`;
            iconKey = 'loader'; // Obsidian's built-in spinning loader icon.
        } else if (loadedCount > 0) {
            statusText += `${loadedCount} active`;
            iconKey = 'check-circle'; // Green check for active/successful state.
        } else {
            statusText += 'None active';
            // iconKey remains 'code-glyph' or similar neutral icon.
        }
        
        setIcon(this.statusBarItemEl, iconKey);
        this.statusBarItemEl.appendText(statusText);
        this.statusBarItemEl.ariaLabel = statusText; // For accessibility.
        this.statusBarItemEl.title = statusText; // Tooltip for hover.
    }

    /**
     * Loads all libraries that are marked as 'enabled' in settings and have a valid type.
     * Libraries are loaded in their specified `loadOrder` to respect dependencies.
     * @param {boolean} showIndividualNotices - Whether to show notices for each library's load attempt.
     * @async
     */
    async loadAllEnabledLibraries(showIndividualNotices) {
        if (showIndividualNotices) new Notice('ScriptPilot: Loading all enabled libraries...', 3000);
        
        const sortedLibraries = [...this.settings.libraries] // Create a copy.
            .filter(lib => lib.isEnabled && lib.type) // Only enabled libraries with a defined type.
            .sort((a, b) => (a.loadOrder || 0) - (b.loadOrder || 0)); // Sort by loadOrder ascending.

        if (sortedLibraries.length === 0) {
            if (showIndividualNotices) new Notice('ScriptPilot: No enabled libraries to load.', 3000);
            this.updateStatusBar(); // Ensure status bar reflects no libraries loaded.
            return;
        }

        let loadedCount = 0;
        for (const lib of sortedLibraries) {
            const state = this.libraryStateManager.getState(lib.id);
            if (!state || (!state.isLoaded && !state.isLoading)) {
                await this.libraryController.loadLibrary(lib, showIndividualNotices);
                // Check state again after load attempt
                if (this.libraryStateManager.getState(lib.id)?.isLoaded) loadedCount++;
            } else if (state.isLoaded && showIndividualNotices) {
                new Notice(`ScriptPilot: "${lib.name}" is already loaded. Skipping.`, 2000);
                loadedCount++;
            } else if (state.isLoading && showIndividualNotices) {
                new Notice(`ScriptPilot: "${lib.name}" is currently loading. Skipping.`, 2000);
            }
        }
        if (showIndividualNotices) {
            new Notice(`ScriptPilot: Finished attempting to load ${sortedLibraries.length} enabled libraries. ${loadedCount} reported as loaded. Check status bar or settings for details.`, 4000);
        }
        this.updateStatusBar(); // Update status bar after all attempts.
    }

    /**
     * Unloads all currently loaded libraries.
     * Libraries are unloaded in reverse `loadOrder` to manage dependencies during shutdown.
     * @param {boolean} showIndividualNotices - Whether to show notices for each library's unload attempt.
     * @async
     */
    async unloadAllLoadedLibraries(showIndividualNotices) {
        if (showIndividualNotices) new Notice('ScriptPilot: Unloading all loaded libraries...', 3000);
        
        const sortedLibraries = [...this.settings.libraries] // Create a copy.
            .filter(lib => this.libraryStateManager.getState(lib.id)?.isLoaded) // Only currently loaded libraries.
            .sort((a, b) => (b.loadOrder || 0) - (a.loadOrder || 0)); // Unload in reverse loadOrder.

        if (sortedLibraries.length === 0) {
            if (showIndividualNotices) new Notice('ScriptPilot: No libraries were loaded to unload.', 3000);
            this.updateStatusBar(); // Ensure status bar reflects this.
            return;
        }

        for (const lib of sortedLibraries) {
            await this.libraryController.unloadLibrary(lib, showIndividualNotices);
        }
        if (showIndividualNotices) new Notice(`ScriptPilot: Finished attempting to unload ${sortedLibraries.length} libraries.`, 4000);
        this.updateStatusBar(); // Update status bar after all unloads.
    }

    /**
     * Manages the interval for real-time status checking of libraries (e.g., global object presence).
     * Starts, stops, or updates the interval based on plugin settings (`showRealtimeStatusPanel` and `realtimePanelUpdateFrequency`).
     * The actual check logic is only performed if the settings tab is visible, to save resources.
     * @private
     */
    _updateRealtimeStatusInterval() {
        const shouldRunPanel = this.settings.showRealtimeStatusPanel;
        const newFrequency = Math.max(MIN_REALTIME_UPDATE_FREQUENCY, this.settings.realtimePanelUpdateFrequency || DEFAULT_SETTINGS.realtimePanelUpdateFrequency);

        // If panel should not run but interval exists, clear it.
        if (!shouldRunPanel && this.realtimeStatusIntervalId !== null) {
            window.clearInterval(this.realtimeStatusIntervalId);
            this.realtimeStatusIntervalId = null; // Mark as cleared.
            this.currentRealtimeUpdateFrequency = 0;
            console.log(`${PLUGIN_CONSOLE_PREFIX} Real-time status monitoring interval STOPPED as panel is disabled.`);
            return;
        }

        // If panel should run:
        if (shouldRunPanel) {
            // If interval exists but frequency changed, clear old one to force re-creation with new frequency.
            if (this.realtimeStatusIntervalId !== null && this.currentRealtimeUpdateFrequency !== newFrequency) {
                window.clearInterval(this.realtimeStatusIntervalId);
                this.realtimeStatusIntervalId = null; // Mark as cleared for re-creation.
            }

            // If no interval exists (or was just cleared for frequency update), create a new one.
            if (this.realtimeStatusIntervalId === null) {
                this.realtimeStatusIntervalId = window.setInterval(() => {
                    // Only perform checks if the settings tab is visible, to save resources when not actively viewed.
                    if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
                        // Check global objects and if any changed, trigger a settings tab re-render.
                        if (this.libraryStateManager.checkAllGlobalObjectsPresence(this.settings.libraries)) {
                            this.settingTab.debouncedDisplay(); // Refresh settings tab to show updated status.
                        }
                    }
                }, newFrequency);
                this.currentRealtimeUpdateFrequency = newFrequency;
                // IMPORTANT: Register with Obsidian for automatic cleanup on plugin unload.
                // This is a safety net if explicit clearInterval in onunload is missed or fails.
                this.registerInterval(this.realtimeStatusIntervalId); 
                console.log(`${PLUGIN_CONSOLE_PREFIX} Real-time status monitoring interval STARTED/UPDATED (frequency: ${newFrequency}ms). Checks active when settings tab is visible.`);
            }
        }
    }

    /**
     * Handles 'state-change' events from LibraryStateManager.
     * Updates UI elements (status bar, settings tab if visible) to reflect the change.
     * @private
     * @param {string} libraryId - The ID of the library whose state changed.
     * @param {LibraryRuntimeState} _stateChanges - The new state properties (not directly used here, but available).
     */
    _handleLibraryStateChange(libraryId, _stateChanges) {
        this.updateStatusBar();
        if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
            this.settingTab.debouncedDisplay();
        }
    }

    /**
     * Handles 'state-delete' events from LibraryStateManager.
     * Updates UI elements after a library's state has been removed.
     * @private
     * @param {string} _libraryId - The ID of the library whose state was deleted (not directly used here).
     */
    _handleLibraryStateDelete(_libraryId) {
        this.updateStatusBar();
        if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
            this.settingTab.debouncedDisplay();
        }
    }

    /**
     * Handles 'all-states-cleared' events from LibraryStateManager.
     * Updates UI after all library states have been cleared (e.g., during plugin unload).
     * @private
     */
    _handleAllLibraryStatesCleared() {
        this.updateStatusBar();
        if (this.settingTab && this.settingTab.containerEl && this.settingTab.containerEl.isShown()) {
            this.settingTab.debouncedDisplay();
        }
    }
}

// --- Settings Tab ---
/**
 * Manages the plugin's settings UI in Obsidian's settings panel.
 * Allows users to configure global plugin settings (like startup behavior, status bar)
 * and manage individual script libraries (add, edit, remove, load/unload).
 * @extends PluginSettingTab
 */
class ScriptPilotSettingTab extends PluginSettingTab {
    /** The main plugin instance. @type {ScriptPilotPlugin} */
    plugin;
    /** Debounced version of the display method to prevent rapid re-renders on frequent state changes. @type {() => void} */
    debouncedDisplay;

    /**
     * Creates an instance of ScriptPilotSettingTab.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {ScriptPilotPlugin} plugin - The main plugin instance.
     */
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        // Debounce display to avoid flickering or performance issues on rapid state changes.
        // `false` for leading edge makes it wait until after the calls stop, then renders once.
        this.debouncedDisplay = debounce(() => {
            // Ensure containerEl is still part of the DOM and visible before re-rendering,
            // as display might be called after the tab is closed in some edge cases.
            if (this.containerEl && this.containerEl.isShown()) {
                this.display();
            }
        }, DEBOUNCE_SETTINGS_UPDATE_MS, false);
    }

    /**
     * Renders the content of the settings tab.
     * This method is called by Obsidian when the tab is displayed or when `display()` is called manually (or via debouncedDisplay).
     * It clears previous content and rebuilds the UI based on current settings and library states.
     */
    display() {
        const { containerEl } = this;
        containerEl.empty(); // Clear previous content to re-render fresh.

        containerEl.createEl('h1', { text: 'ScriptPilot: JavaScript Library Manager' });
        containerEl.createEl('p', { text: 'Load and manage custom JavaScript libraries within Obsidian. Use this plugin to extend Obsidian\'s functionality with your own scripts or trusted third-party libraries. Exercise extreme caution when loading external code.' });
        
        // --- General Settings ---
        containerEl.createEl('h2', { text: 'General Settings' });

        new Setting(containerEl)
            .setName('Load enabled libraries on Obsidian startup')
            .setDesc('If enabled, all libraries marked as "Enabled" in their configuration will be automatically loaded when Obsidian starts. This is useful for libraries you always want active.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.loadEnabledOnStartup)
                .onChange(async (value) => {
                    this.plugin.settings.loadEnabledOnStartup = value;
                    await this.plugin.saveSettings(); // saveSettings handles persisting and any related UI updates.
                }));

        new Setting(containerEl)
            .setName('Show status bar item')
            .setDesc('Display an icon in the Obsidian status bar showing the number of active/loading ScriptPilot libraries. Provides a quick overview and visual feedback.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.showStatusBar = value;
                    await this.plugin.saveSettings(); // saveSettings will handle status bar display update.
                }));

        // --- Security Warning ---
        const securitySection = containerEl.createDiv({ cls: 'scriptpilot-settings-section' });
        securitySection.createEl('h2', { text: '⚠️ Important Security & Stability Considerations' });
        const warningEl = securitySection.createDiv({ cls: 'scriptpilot-warning callout' }); // Using 'callout' for Obsidian's styling.
        warningEl.setAttribute('data-callout', 'error'); // Use 'error' type for high visibility.
        const warningHeader = warningEl.createDiv({ cls: 'callout-title' });
        const iconSpan = warningHeader.createSpan({ cls: 'callout-icon' });
        setIcon(iconSpan, 'alert-octagon'); // A more severe/warning icon.
        warningHeader.createSpan({ text: ' Read Before Use: Executing External Code Carries Risks', cls: 'callout-title-inner' });
        
        const warningContent = warningEl.createDiv({ cls: 'callout-content' });
        const warningList = warningContent.createEl('ul');
        warningList.createEl('li', { html: '<strong>High Risk:</strong> This plugin executes arbitrary JavaScript code from local files or remote URLs. Malicious scripts can compromise your data, damage your vault, or harm your computer.' });
        warningList.createEl('li', { html: '<strong>Trust Is Paramount:</strong> ONLY load scripts from sources you absolutely trust or that you have personally audited and fully understand. Verify URLs and file paths carefully.' });
        warningList.createEl('li', { text: 'HTTP (Mobile/Capacitor) type: Primarily for Obsidian Mobile. Uses native HTTP requests, generally safer and less prone to CORS issues for trusted URLs if CapacitorHttp is available.' });
        warningList.createEl('li', { text: 'HTTP (Iframe/CORS) type: Works on Desktop/Mobile. Subject to CORS (Cross-Origin Resource Sharing) policies set by the script\'s server. If a script fails to load, check the developer console (Ctrl+Shift+I or Cmd+Opt+I) for CORS errors or other network issues.' });
        warningList.createEl('li', { text: 'Local Vault File type: Scripts from your vault execute with the same permissions as Obsidian plugins. Be extremely cautious with local scripts if their origin or content is unknown or unverified.' });
        warningList.createEl('li', { html: '<strong>Full Cleanup May Require Restart:</strong> For complex libraries that deeply modify Obsidian or global state (e.g., `window` object, DOM outside plugin control), simply unloading them via ScriptPilot might not revert all changes. Restarting Obsidian is the most reliable method for a complete reset after experimenting with such libraries.' });
        warningList.createEl('li', { html: '<strong>No Additional Sandbox (Beyond Standard Web Environment):</strong> Scripts loaded by ScriptPilot are NOT sandboxed beyond the standard browser/Electron environment capabilities and restrictions. They have significant access within Obsidian\'s context.' });


        // --- Configured Libraries ---
        containerEl.createEl('h2', { text: 'Configured Libraries' });

        if (!this.plugin.settings.libraries || this.plugin.settings.libraries.length === 0) {
            containerEl.createEl('p', { text: 'No libraries configured yet. Click "Add New Library" below to get started!' });
        }

        // Display libraries sorted by load order for consistency.
        this.plugin.settings.libraries
            .sort((a,b) => (a.loadOrder || 0) - (b.loadOrder || 0)) 
            .forEach((library) => { // Removed index as it's not used.
            const libraryState = this.plugin.libraryStateManager.getState(library.id) || 
                                 { isLoading: false, isLoaded: false, lastError: undefined, globalObjectPresent: undefined };

            const libContainer = containerEl.createDiv({ cls: 'scriptpilot-entry setting-item' });
            const libMainRow = libContainer.createDiv({ cls: 'setting-item-info' });

            let typeText = 'Unknown Type'; // Default text if type is somehow invalid.
            if (library.type === 'http') typeText = 'HTTP (Mobile/Capacitor)';
            else if (library.type === 'localFile') typeText = 'Local Vault File';
            else if (library.type === 'http-iframe') typeText = 'HTTP (Iframe/CORS)';

            const nameEl = libMainRow.createEl('div', { cls: 'setting-item-name' });
            const statusIndicator = nameEl.createSpan({ cls: 'scriptpilot-status-indicator' });
            
            // Set status icon and tooltip based on library's current runtime state.
            if (libraryState.isLoading) { 
                setIcon(statusIndicator, 'loader'); // Spinning loader icon.
                statusIndicator.ariaLabel = "Status: Loading"; 
                statusIndicator.addClass('scriptpilot-status-loading');
                statusIndicator.title = `Status: Library "${library.name}" is currently loading.`;
            } else if (libraryState.isLoaded) { 
                setIcon(statusIndicator, 'check-circle'); // Green check for success.
                statusIndicator.ariaLabel = "Status: Loaded"; 
                statusIndicator.addClass('scriptpilot-status-loaded');
                statusIndicator.title = `Status: Library "${library.name}" is loaded and active.`;
            } else if (libraryState.lastError) { 
                setIcon(statusIndicator, 'x-circle'); // Red X for error.
                statusIndicator.ariaLabel = "Status: Error"; 
                statusIndicator.addClass('scriptpilot-status-error');
                statusIndicator.title = `Status: Error during last load/unload attempt for "${library.name}". Click 'Edit' for details. Error: ${libraryState.lastError}`;
            } else { 
                setIcon(statusIndicator, 'circle-dashed'); // Neutral/inactive icon.
                statusIndicator.ariaLabel = "Status: Unloaded/Inactive"; 
                statusIndicator.addClass('scriptpilot-status-unloaded');
                statusIndicator.title = `Status: Library "${library.name}" is configured but not currently loaded.`;
            }
            
            nameEl.appendText(` ${library.name || `Unnamed Library`} (${typeText})`);
            if (!library.isEnabled) {
                nameEl.appendText(' [Disabled]'); // Indicate if library is disabled in settings.
            }

            const sourceText = (library.type === 'http' || library.type === 'http-iframe') 
                ? `URL: ${library.url || "Not set. Please edit."}` 
                : `File: ${library.filePath || "Not set. Please edit."}`;
            libMainRow.createEl('div', { text: sourceText, cls: 'setting-item-description scriptpilot-source' });
            
            if (!library.type) { // Display error if library type is missing (should be caught by settings migration).
                 libMainRow.createEl('div', { text: `Configuration Error: Library type is missing for "${library.name}". Please edit this library and select a valid type.`, cls: 'setting-item-description scriptpilot-error-message' });
            }
            if (libraryState.lastError) { // Display last error message if any.
                libMainRow.createEl('div', { text: `Last Error: ${libraryState.lastError}`, cls: 'setting-item-description scriptpilot-error-message' });
            }
            if (libraryState.isLoaded && library.globalObjectName) { // Display status of global object if configured.
                const isPresent = libraryState.globalObjectPresent;
                const globalStatusEl = libMainRow.createEl('div', { 
                    text: `Global object 'window.${library.globalObjectName}' ${isPresent ? 'detected.' : 'NOT detected.'}`, 
                    cls: `setting-item-description scriptpilot-global-status-${isPresent ? 'present' : 'absent'}` 
                });
                if (!isPresent) globalStatusEl.title = `The expected global object 'window.${library.globalObjectName}' was not found after loading "${library.name}". The library might not have loaded correctly, the name might be misspelled in settings, or the library doesn't expose it as expected.`;
                else globalStatusEl.title = `The global object 'window.${library.globalObjectName}' for "${library.name}" was successfully detected.`;
            }

            const controlsEl = libContainer.createDiv({ cls: 'setting-item-control scriptpilot-controls' });
            // Using Setting for button alignment and standard Obsidian styling.
            new Setting(controlsEl) 
                .addButton(button => button
                    .setIcon(libraryState.isLoaded ? 'stop-circle' : 'play') // Toggle icon based on loaded state.
                    .setTooltip(libraryState.isLoaded ? `Unload Library "${library.name}"` : `Load Library "${library.name}"`)
                    .setDisabled(!library.type || libraryState.isLoading) // Disable if no type or currently loading/unloading.
                    .onClick(async () => {
                        if (!library.type || libraryState.isLoading) return; // Extra safety check.
                        if (libraryState.isLoaded) {
                            await this.plugin.libraryController.unloadLibrary(library, true);
                        } else {
                            await this.plugin.libraryController.loadLibrary(library, true);
                        }
                        // State change callback from LibraryStateManager should trigger debouncedDisplay to update this tab.
                    }))
                .addButton(button => button
                    .setIcon('settings-2') // Gear icon for edit.
                    .setTooltip(`Edit Configuration for "${library.name}"`)
                    .onClick(() => {
                        new LibraryEditModal(this.app, this.plugin, library, (updatedLib) => {
                            const originalIndex = this.plugin.settings.libraries.findIndex(l => l.id === library.id);
                            if (originalIndex !== -1) {
                                this.plugin.settings.libraries[originalIndex] = updatedLib;
                            } else {
                                // This should not happen if UI is consistent with data.
                                console.error(`${PLUGIN_CONSOLE_PREFIX} Critical error: Could not find library to update after edit: ${library.id}`);
                                new Notice("ScriptPilot: Error - Could not find library to update. Please report this issue.", 5000);
                                return;
                            }
                            // Ensure state entry exists, especially if ID somehow changed (it shouldn't in edit).
                            this.plugin.libraryStateManager._ensureState(updatedLib.id); 
                            this.plugin.saveSettings().then(() => {
                                // saveSettings calls commandOrchestrator.updateAllLibraryCommands and other UI updates.
                                this.debouncedDisplay(); // Re-render this settings tab.
                            });
                        }).open();
                    }))
                .addButton(button => button
                    .setIcon('trash-2') // Trash icon for remove.
                    .setTooltip(`Remove Library Configuration for "${library.name}"`)
                    .setWarning() // Makes button red, indicating a destructive action.
                    .onClick(async () => {
                        const confirmMsg = `Are you sure you want to remove the library configuration for "${library.name}"?` +
                                           (libraryState.isLoaded ? " It is currently loaded and will be unloaded first." : "") +
                                           "\nThis action cannot be undone and will delete its settings entry.";
                        if (!confirm(confirmMsg)) return; // User cancelled.

                        if (libraryState.isLoaded) { // Unload first if loaded.
                            await this.plugin.libraryController.unloadLibrary(library, true);
                        }
                        
                        this.plugin.commandOrchestrator.removeLibrarySpecificCommands(library.id); // Remove associated commands.
                        // Remove from settings array by ID.
                        this.plugin.settings.libraries = this.plugin.settings.libraries.filter(l => l.id !== library.id);
                        this.plugin.libraryStateManager.deleteState(library.id); // Remove runtime state and cleanup loader resources.
                        
                        await this.plugin.saveSettings(); // Save changes and trigger global updates.
                        this.debouncedDisplay(); // Re-render this settings tab.
                    }));
        });

        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add New Library')
                .setCta() // Call To Action style for prominent button.
                .onClick(() => {
                    const newLibDefaults = {
                        id: Utils.generateUniqueId(),
                        type: 'localFile', // Sensible default type.
                        name: `New Library ${this.plugin.settings.libraries.length + 1}`,
                        url: '', 
                        filePath: '', 
                        isEnabled: false, 
                        loadOrder: (this.plugin.settings.libraries.length) * 10, // Default load order, spaced by 10.
                        globalObjectName: '',
                        initializationScript: "// Example: console.log('My New Library initialized!');\n// window.myGlobalObject = { version: '1.0' };\n// Use 'await' for async operations if needed within this script.",
                        destructionScript: "// Example: console.log('My New Library destroyed!');\n// if(window.myGlobalObject) { delete window.myGlobalObject; }\n// Use 'await' for async operations if needed.",
                    };
                    new LibraryEditModal(this.app, this.plugin, newLibDefaults, (createdLib) => {
                        this.plugin.settings.libraries.push(createdLib);
                        this.plugin.libraryStateManager._ensureState(createdLib.id); // Ensure runtime state entry is created.
                        this.plugin.saveSettings().then(() => {
                            // saveSettings calls commandOrchestrator.updateAllLibraryCommands and other UI updates.
                            this.debouncedDisplay(); // Re-render settings tab to show the new library.
                        });
                    }).open();
                }));

        // --- Real-time Library Status Monitoring (Advanced) ---
        containerEl.createEl('h3', { text: 'Real-time Library Status Monitoring (Advanced)' });
        new Setting(containerEl)
            .setName('Enable Real-time Status Panel (in this tab)')
            .setDesc('When this settings tab is open, ScriptPilot can periodically check and display the live status of loaded libraries (e.g., if their specified "Global Object Name" is present in `window`). This is for diagnostic purposes. Disable if not needed or if you notice performance impact on very slow systems while this tab is open (though checks are minimal).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showRealtimeStatusPanel)
                .onChange(async (value) => {
                    this.plugin.settings.showRealtimeStatusPanel = value;
                    await this.plugin.saveSettings(); // saveSettings updates the interval.
                    this.debouncedDisplay(); // Re-render to show/hide panel and frequency setting.
                }));

        if (this.plugin.settings.showRealtimeStatusPanel) {
            new Setting(containerEl)
                .setName('Status Update Frequency (milliseconds)')
                .setDesc(`How often the real-time status panel (below) updates when this tab is open and the panel is enabled. Lower values mean more frequent updates but slightly more CPU usage during checks. Minimum: ${MIN_REALTIME_UPDATE_FREQUENCY}ms.`)
                .addText(text => {
                    text.setPlaceholder(String(DEFAULT_SETTINGS.realtimePanelUpdateFrequency))
                        .setValue(String(this.plugin.settings.realtimePanelUpdateFrequency))
                        .onChange(async (value) => {
                            let num = parseInt(value, 10);
                            if (isNaN(num) || num < MIN_REALTIME_UPDATE_FREQUENCY) {
                                num = Math.max(MIN_REALTIME_UPDATE_FREQUENCY, DEFAULT_SETTINGS.realtimePanelUpdateFrequency); // Ensure it's at least min.
                                new Notice(`ScriptPilot: Update frequency set to minimum allowed: ${num}ms`, 2000);
                            }
                            this.plugin.settings.realtimePanelUpdateFrequency = num;
                            await this.plugin.saveSettings(); // saveSettings updates the interval.
                            text.setValue(String(this.plugin.settings.realtimePanelUpdateFrequency)); // Reflect validated value in UI.
                        });
                    text.inputEl.type = 'number'; // Use number input type for better UX.
                    text.inputEl.min = String(MIN_REALTIME_UPDATE_FREQUENCY); // Set min attribute for browser validation hint.
                });

            const statusArea = containerEl.createDiv('scriptpilot-realtime-status-panel');
            statusArea.createEl('h4', {text: 'Live Library Status:'});
            if (!this.plugin.settings.libraries || this.plugin.settings.libraries.length === 0) {
                statusArea.createEl('p', { text: 'No libraries configured to monitor.' });
            }
            let activeLibsMonitored = 0;
            this.plugin.settings.libraries.forEach(lib => {
                const state = this.plugin.libraryStateManager.getState(lib.id);
                // Display status for libraries that are loaded, loading, or have errors, as these are most relevant for live monitoring.
                if (state && (state.isLoaded || state.isLoading || state.lastError)) {
                    activeLibsMonitored++;
                    const libStatusEl = statusArea.createDiv({cls: 'scriptpilot-realtime-item'});
                    let statusText = `"${lib.name}": `;
                    if (state.isLoading) statusText += "Loading...";
                    else if (state.isLoaded) {
                        statusText += "Loaded.";
                        if (lib.globalObjectName) {
                            // globalObjectPresent is updated by the interval check via libraryStateManager.
                            statusText += ` Global 'window.${lib.globalObjectName}' ${state.globalObjectPresent ? 'detected.' : 'NOT detected.'}`;
                        }
                    } else if (state.lastError) {
                        // Truncate long errors for display in this panel. Full error in main list item tooltip.
                        statusText += `Error - ${state.lastError.substring(0, 100)}${state.lastError.length > 100 ? '...' : ''}`; 
                    } else { 
                        // This case should ideally not be hit if filter above is (state.isLoaded || state.isLoading || state.lastError).
                        statusText += "Inactive or Unloaded (should not appear here).";
                    }
                    libStatusEl.setText(statusText);
                }
            });
            if (activeLibsMonitored === 0 && this.plugin.settings.libraries && this.plugin.settings.libraries.length > 0) {
                statusArea.createEl('p', { text: 'No libraries currently active or all are in a clean unloaded state. Monitoring is idle.' });
            } else if (activeLibsMonitored > 0) {
                 statusArea.createEl('p', {text: `Monitoring ${activeLibsMonitored} active/problematic libraries. Status updates every ${this.plugin.settings.realtimePanelUpdateFrequency / 1000} seconds while this tab is open.`, cls: 'scriptpilot-subtle-text'});
            }
        }
    }
}

// --- Modals ---
/**
 * A suggest modal for selecting .js files from the Obsidian vault.
 * Used in the `LibraryEditModal` for choosing local script files, providing a search interface.
 * @extends SuggestModal<TFile>
 */
class VaultFileSuggestModal extends SuggestModal {
    /** Callback function when a file is chosen. @type {(filePath: string) => void} */
    onChoose;

    /**
     * Creates an instance of VaultFileSuggestModal.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {(filePath: string) => void} onChoose - Callback function to execute with the chosen file path.
     */
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Search for .js files in your vault...");
        this.setInstructions([
            { command: '↵', purpose: 'to select file' }, 
            { command: '↑↓', purpose: 'to navigate' },
            { command: 'esc', purpose: 'to dismiss' }
        ]);
        this.scope.register([], " популярных ", () => {}); // Workaround for up/down keys not working if no hotkey is registered
    }

    /**
     * Gets suggestions based on the query. Filters for .js files only.
     * @param {string} query - The search query entered by the user.
     * @returns {TFile[]} An array of matching TFile objects (JavaScript files).
     */
    getSuggestions(query) {
        const jsFiles = this.app.vault.getFiles().filter(file => file.extension === 'js');
        const lowerCaseQuery = query.toLowerCase();
        return jsFiles
            .filter(file => file.path.toLowerCase().includes(lowerCaseQuery)) // Filter by path matching query.
            .sort((a, b) => a.path.localeCompare(b.path)); // Sort alphabetically by path for consistent ordering.
    }

    /**
     * Renders a suggestion item in the modal list.
     * Displays the file name and its full path.
     * @param {TFile} file - The file to render.
     * @param {HTMLElement} el - The HTML element to render into.
     */
    renderSuggestion(file, el) {
        el.createEl("div", { text: file.name }); // Display file name prominently.
        el.createEl("small", { text: file.path, cls: "setting-item-description" }); // Display full path subtly.
    }

    /**
     * Called when a suggestion is chosen by the user (e.g., by clicking or pressing Enter).
     * Executes the `onChoose` callback with the path of the selected file.
     * @param {TFile} file - The chosen file.
     * @param {MouseEvent | KeyboardEvent} _evt - The event that triggered the choice (not used here).
     */
    onChooseSuggestion(file, _evt) {
        if (file && typeof file.path === 'string') {
            this.onChoose(file.path);
        } else {
            // This should not happen if getSuggestions and renderSuggestion are correct and return valid TFile objects.
            console.warn(`${PLUGIN_CONSOLE_PREFIX} VaultFileSuggestModal: Invalid file chosen or file path missing.`);
            new Notice("ScriptPilot: Error - Could not select the file. Please try again or enter the path manually.", 3000);
        }
    }
}

/**
 * Modal for adding a new library configuration or editing an existing one.
 * Provides form fields for all library configuration options (name, type, source, scripts, etc.).
 * Includes prominent security warnings due to the nature of executing custom code.
 * @extends Modal
 */
class LibraryEditModal extends Modal {
    /** The main plugin instance. @type {ScriptPilotPlugin} */
    plugin;
    /**
     * A deep copy of the library configuration being edited or created.
     * Modifications are made to this copy, which is then passed to `onSubmit`.
     * @type {LibraryConfig}
     */
    library;
    /** Callback function when the form is submitted with valid data. @type {(updatedLibrary: LibraryConfig) => void} */
    onSubmit;
    /** True if editing a new library (defaults provided), false if editing an existing one. @type {boolean} */
    isNew;

    /**
     * Creates an instance of LibraryEditModal.
     * @param {import('obsidian').App} app - The Obsidian application instance.
     * @param {ScriptPilotPlugin} plugin - The main plugin instance.
     * @param {LibraryConfig} libraryConfig - The library configuration to edit (or defaults for a new one).
     * @param {(updatedLibrary: LibraryConfig) => void} onSubmit - Callback for successful submission with the updated/created library config.
     */
    constructor(app, plugin, libraryConfig, onSubmit) {
        super(app);
        this.plugin = plugin;
        // Deep copy the library config to avoid modifying the original object in settings directly
        // until the user explicitly saves. This allows for a "cancel" operation.
        this.library = JSON.parse(JSON.stringify(libraryConfig));
        this.onSubmit = onSubmit;
        // Determine if it's a new library by checking if its ID exists in current settings.
        // This helps tailor the modal title and button text.
        this.isNew = !this.plugin.settings.libraries.some(l => l.id === this.library.id);

        this.modalEl.addClass('scriptpilot-edit-modal'); // Add class for potential custom styling of the modal itself.
    }

    /**
     * Called when the modal is opened. Renders the form content.
     */
    onOpen() {
        const { contentEl } = this;
        contentEl.empty(); // Clear any previous content from prior openings.
        contentEl.addClass("scriptpilot-modal-content"); // For specific styling of the modal's content area.

        contentEl.createEl('h2', { text: this.isNew ? 'Add New Script Library' : `Edit Script Library: ${this.library.name}` });

        // --- Prominent Security Warning ---
        const securityWarningContainer = contentEl.createDiv({ cls: 'scriptpilot-modal-security-warning' });
        const securityWarning = securityWarningContainer.createDiv({ cls: 'callout' });
        securityWarning.setAttribute('data-callout', 'error'); // High-visibility 'error' style.
        const warningHeader = securityWarning.createDiv({ cls: 'callout-title' });
        const iconSpan = warningHeader.createSpan({ cls: 'callout-icon' });
        setIcon(iconSpan, 'shield-alert'); // Prominent security icon.
        warningHeader.createSpan({ text: ' CRITICAL SECURITY WARNING: Code Execution Risk', cls: 'callout-title-inner' });
        const warningContent = securityWarning.createDiv({ cls: 'callout-content' });
        warningContent.createEl('p', { html: '<strong>You are configuring code that will be executed by Obsidian with significant permissions.</strong> Malicious scripts (from remote URLs or local files) can potentially:' });
        const riskList = warningContent.createEl('ul'); // Corrected variable name
        riskList.createEl('li', {text: 'Access, modify, or delete your vault data.'});
        riskList.createEl('li', {text: 'Access information on your computer (depending on script capabilities and Electron/browser sandboxing).'});
        riskList.createEl('li', {text: 'Compromise your security and privacy.'});
        warningContent.createEl('p', { html: '<strong>ONLY use scripts from sources you absolutely trust or that you have personally audited and understand completely.</strong> When in doubt, do not load the script. Verify URLs and file paths meticulously.' });
        warningContent.createEl('p', { html: 'Initialization and Destruction scripts also run with these permissions and should be treated with the same caution.' });


        let typeSpecificSettingsContainer; // To re-render type-specific part of the form when type changes.

        // --- Library Type ---
        new Setting(contentEl)
            .setName('Library Type')
            .setDesc('Choose how ScriptPilot should load this library. Each type has different use cases and considerations (especially regarding security, CORS for HTTP types, and platform availability).')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('localFile', 'Local Vault File (.js)')
                    .addOption('http-iframe', 'HTTP(S) URL (via Iframe - Desktop/Mobile, CORS dependent)')
                    .addOption('http', 'HTTP(S) URL (via Capacitor - Mobile Only, Native HTTP)')
                    .setValue(this.library.type || 'localFile') // Default to localFile if type is somehow missing.
                    .onChange(value => {
                        this.library.type = value;
                        // When type changes, clear the irrelevant source field to avoid confusion and potential errors.
                        if (value === 'localFile') {
                            this.library.url = ''; // Clear URL if switching to local file.
                        } else { // 'http' or 'http-iframe'
                            this.library.filePath = ''; // Clear file path if switching to HTTP.
                        }
                        // Re-render the part of the form that depends on the library type (URL or File Path input).
                        this.renderTypeSpecificSettings(typeSpecificSettingsContainer); 
                    });
            });

        typeSpecificSettingsContainer = contentEl.createDiv(); // Placeholder for type-specific settings.
        this.renderTypeSpecificSettings(typeSpecificSettingsContainer); // Initial render based on current library type.

        // --- Library Name ---
        new Setting(contentEl)
            .setName('Library Name')
            .setDesc('A user-friendly name for this library. This name will be used in status messages, commands, and the settings list. Make it descriptive and unique if possible.')
            .addText(text => text
                .setPlaceholder('e.g., My Custom Charting Library')
                .setValue(this.library.name || '')
                .onChange(value => this.library.name = value.trim())); // Trim whitespace.

        // --- Initialization Script ---
        new Setting(contentEl)
            .setName('Initialization Script (Optional)')
            .setDesc(el => {
                el.appendText('JavaScript code to run immediately after the main library script is successfully loaded and injected. Useful for setup, configuration, calling an entry point of the library, or integrating it with Obsidian.');
                el.createEl('br');
                el.appendText('Use "await" for asynchronous operations if needed. The script is executed in the global (`window`) scope.');
                el.createEl('br');
                el.createStrong(strong => strong.appendText('Security: This script runs with full permissions. Only use trusted code.'));
            })
            .addTextArea(text => {
                text.setPlaceholder("// Example:\n// if (window.myLoadedLib && typeof window.myLoadedLib.initialize === 'function') {\n//   await window.myLoadedLib.initialize({ apiKey: '123' });\n// }\n// console.log('My Library has been initialized.');")
                    .setValue(this.library.initializationScript || '')
                    .onChange(value => this.library.initializationScript = value); // Store raw value, including newlines.
                text.inputEl.rows = 5; // Provide more space for code input.
                text.inputEl.classList.add('scriptpilot-code-input'); // For potential custom styling.
            });

        // --- Destruction Script ---
        new Setting(contentEl)
            .setName('Destruction Script (Optional)')
            .setDesc(el => {
                el.appendText('JavaScript code to run when this library is unloaded (either manually or when ScriptPilot/Obsidian shuts down). Essential for cleaning up resources, removing event listeners added by the library, or nullifying global objects/state created by the library to prevent memory leaks or interference.');
                el.createEl('br');
                el.appendText('Use "await" for asynchronous operations if needed. Executed in the global (`window`) scope.');
                el.createEl('br');
                el.createStrong(strong => strong.appendText('Security: This script also runs with full permissions. Ensure it is safe and correct.'));
            })
            .addTextArea(text => {
                text.setPlaceholder("// Example:\n// if (window.myLoadedLib && typeof window.myLoadedLib.destroy === 'function') {\n//   await window.myLoadedLib.destroy();\n// }\n// delete window.myLoadedLib;")
                    .setValue(this.library.destructionScript || '')
                    .onChange(value => this.library.destructionScript = value);
                text.inputEl.rows = 5;
                text.inputEl.classList.add('scriptpilot-code-input');
            });

        // --- Global Object Name ---
        new Setting(contentEl)
            .setName('Global Object Name (Optional)')
            .setDesc('If this library exposes a primary object or namespace on the `window` (e.g., "jQuery", "moment", "MyCompany.MyLib"), specify its full path here. ScriptPilot uses this for: (1) Status checking in the settings tab (presence detection). (2) Attempting to `delete window.YourObjectName` during unload (if the property is configurable). This aids in cleanup but is not foolproof for all libraries; a good destruction script is more reliable.')
            .addText(text => text
                .setPlaceholder('e.g., MyLib, Utils.MyModule, $')
                .setValue(this.library.globalObjectName || '')
                .onChange(value => this.library.globalObjectName = value.trim()));

        // --- Enabled for Loading ---
        new Setting(contentEl)
            .setName('Enabled for Loading')
            .setDesc('If checked, this library will be loaded if "Load All Enabled Libraries" command is triggered or if "Load enabled libraries on Obsidian startup" setting is active. Uncheck to keep the configuration but prevent automatic or mass loading.')
            .addToggle(toggle => toggle
                .setValue(this.library.isEnabled || false)
                .onChange(value => this.library.isEnabled = value));

        // --- Load Order ---
        new Setting(contentEl)
            .setName('Load Order')
            .setDesc('A number that determines the loading sequence when multiple libraries are loaded simultaneously (e.g., on startup or via "Load All"). Libraries with lower numbers are loaded first. Use this to manage dependencies (e.g., a utility library might have load order 10, while a library depending on it has 20).')
            .addText(text => {
                text.setPlaceholder('e.g., 10, 20, 100 (lower loads first)')
                    .setValue(String(this.library.loadOrder || 0))
                    .onChange(value => {
                        const num = parseInt(value, 10);
                        this.library.loadOrder = isNaN(num) ? 0 : num; // Default to 0 if input is not a valid number.
                         text.setValue(String(this.library.loadOrder)); // Reflect validated (or defaulted) value in the input field.
                    });
                text.inputEl.type = 'number'; // Use number input for better UX and semantic meaning.
            });

        // --- Action Buttons (Save/Cancel) ---
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' }); // For custom layout if needed.
        // Using Setting for consistent button styling and alignment with other settings items.
        new Setting(buttonContainer) 
            .addButton(button => button
                .setButtonText(this.isNew ? 'Add Library' : 'Save Changes')
                .setCta() // Call To Action style for the primary action button.
                .onClick(() => {
                    // --- Validation before submitting ---
                    if (!this.library.name || this.library.name.trim() === "") {
                        new Notice('ScriptPilot: Library Name is required. Please provide a descriptive name.', 4000); return;
                    }
                    if ((this.library.type === 'http' || this.library.type === 'http-iframe') && (!this.library.url || this.library.url.trim() === '')) {
                        new Notice('ScriptPilot: Library URL is required for HTTP-based library types.', 4000); return;
                    }
                    if (this.library.type === 'localFile' && (!this.library.filePath || this.library.filePath.trim() === '')) {
                        new Notice('ScriptPilot: Library File Path is required for Local File type.', 4000); return;
                    }
                    if (this.library.type === 'localFile' && this.library.filePath && !this.library.filePath.toLowerCase().endsWith('.js')) {
                        new Notice('ScriptPilot: For Local File type, the File Path must end with ".js".', 4000); return;
                    }
                    // Basic URL format validation (does not check reachability).
                    if ((this.library.type === 'http' || this.library.type === 'http-iframe') && this.library.url) {
                        try {
                            new URL(this.library.url); // Test if it's a structurally valid URL.
                        } catch (_) {
                            new Notice('ScriptPilot: The provided Library URL is not a valid URL format. Please check it (e.g., ensure it starts with http:// or https://).', 5000); return;
                        }
                    }

                    this.onSubmit(this.library); // Pass the (potentially modified) deep copy of library config.
                    this.close(); // Close the modal on successful submission.
                }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close())); // Simply close the modal, changes to `this.library` are discarded.
    }

    /**
     * Renders the settings specific to the selected library type (URL input for HTTP types, or File Path input for local files).
     * This method is called initially and whenever the library type dropdown changes.
     * @param {HTMLElement} containerEl - The HTML element to render these type-specific settings into.
     * @private
     */
    renderTypeSpecificSettings(containerEl) {
        containerEl.empty(); // Clear previous type-specific settings before rendering new ones.

        if (this.library.type === 'http' || this.library.type === 'http-iframe') {
            const descText = this.library.type === 'http' ?
                'Enter the full HTTP(S) URL of the JavaScript library. This method uses CapacitorHttp (if available, primarily on Mobile) for native HTTP requests. It is generally less prone to CORS issues than the Iframe method but might not be available on all platforms or Obsidian versions. Ensure the URL is from a trusted source.' :
                'Enter the full HTTP(S) URL of the JavaScript library. This method uses a hidden Iframe to fetch the script. It works on Desktop and Mobile but is highly dependent on the server\'s CORS (Cross-Origin Resource Sharing) policy. If loading fails, check the developer console (Ctrl+Shift+I or Cmd+Opt+I on Desktop) for CORS errors. Ensure the URL is from a trusted source.';
            
            new Setting(containerEl)
                .setName('Library URL')
                .setDesc(descText)
                .addText(text => {
                    text.setPlaceholder('https://example.com/path/to/library.js')
                        .setValue(this.library.url || '')
                        .onChange(value => this.library.url = value.trim());
                    text.inputEl.style.width = '100%'; // Make input wider to accommodate long URLs.
                    text.inputEl.type = 'url'; // Use URL input type for better semantics and potential browser validation.
                });
        } else if (this.library.type === 'localFile') {
            let filePathTextComponent; // To allow updating the text field from the "Browse" button's action.
            new Setting(containerEl)
                .setName('Library File Path (within vault)')
                .setDesc('Enter the path to the .js file, relative to your Obsidian vault root (e.g., "scripts/my-lib.js" or "assets/js/my-script.js"). The file must end with ".js". Click "Browse" to search for .js files in your vault. Ensure the file is from a trusted source or you have audited its content.')
                .addText(text => {
                    filePathTextComponent = text; // Store reference to the text component.
                    text.setPlaceholder('scripts/my-custom-library.js')
                        .setValue(this.library.filePath || '')
                        .onChange(v => this.library.filePath = v.trim()); // Trim whitespace.
                    // Adjust width to make space for the "Browse" button next to it.
                    text.inputEl.style.width = 'calc(100% - 100px)'; 
                })
                .addButton(btn => btn.setButtonText('Browse...')
                    .setTooltip('Browse vault for a .js file')
                    .onClick(() => {
                        new VaultFileSuggestModal(this.app, (path) => {
                            this.library.filePath = path; // Update internal state with selected path.
                            if (filePathTextComponent) filePathTextComponent.setValue(path); // Update text field UI to reflect selection.
                        }).open();
                    })
                    .buttonEl.style.marginLeft = '5px'); // Add some margin to the button for better spacing.
        }
    }

    /**
     * Called when the modal is closed. Cleans up the content and any added classes.
     */
    onClose() {
        this.contentEl.empty();
        this.contentEl.removeClass("scriptpilot-modal-content");
        this.modalEl.removeClass('scriptpilot-edit-modal');
    }
}

module.exports = ScriptPilotPlugin;