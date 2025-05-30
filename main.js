const { Plugin, Notice, Setting, PluginSettingTab, setIcon, debounce, Modal, SuggestModal, TFile, TextComponent, Events } = require('obsidian');

const PLUGIN_CONSOLE_PREFIX = '[ScriptPilot]';
const IFRAME_MESSAGE_TYPE_SUCCESS_SUFFIX = '-loader-code-success';
const IFRAME_MESSAGE_TYPE_ERROR_SUFFIX = '-loader-code-error';
const SCRIPT_TAG_ID_PREFIX = 'scriptpilot-script-';
const IFRAME_LOAD_TIMEOUT_MS = 30000;
const MIN_REALTIME_UPDATE_FREQUENCY = 500;
const DEBOUNCE_SETTINGS_UPDATE_MS = 300;

const DEFAULT_SETTINGS = {
    libraries: [],
    loadEnabledOnStartup: true,
    showStatusBar: true,
    showRealtimeStatusPanel: true,
    realtimePanelUpdateFrequency: 2500,
};

class Utils {
    static generateUniqueId() {
        return `lib-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    static getProperty(obj, path) {
        if (typeof obj !== 'object' || obj === null) {
            return undefined;
        }
        if (typeof path !== 'string' || path.trim() === "") {
            return undefined;
        }

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

    static deleteProperty(obj, path) {
        if (typeof obj !== 'object' || obj === null) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} deleteProperty: Provided 'obj' is not a valid object.`);
            return false;
        }
        if (typeof path !== 'string' || path.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} deleteProperty: Provided 'path' is invalid or empty.`);
            return false;
        }

        const parts = path.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (typeof current !== 'object' || current === null || !Object.prototype.hasOwnProperty.call(current, part)) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Path segment '${part}' in '${path}' not found or not an object during deletion attempt.`);
                return false;
            }
            current = current[part];
        }

        const finalPart = parts[parts.length - 1];
        if (typeof current === 'object' && current !== null && Object.prototype.hasOwnProperty.call(current, finalPart)) {
            try {
                const descriptor = Object.getOwnPropertyDescriptor(current, finalPart);
                if (descriptor && descriptor.configurable) {
                    delete current[finalPart];
                    const success = !Object.prototype.hasOwnProperty.call(current, finalPart);
                    if (success) {
                    } else {
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} Property '${path}' failed to delete despite being configurable and existing.`);
                    }
                    return success;
                } else if (descriptor && descriptor.writable) {
                    current[finalPart] = undefined;
                    const success = typeof current[finalPart] === 'undefined';
                    if (success) {
                    } else {
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} Property '${path}' is writable but could not be set to undefined.`);
                    }
                    return success;
                } else {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Property '${path}' is not configurable and not writable. Cannot delete or set to undefined.`);
                    return false;
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error deleting property"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error attempting to delete or undefined property '${path}':`, typedError.message, typedError);
                return false;
            }
        }
        return true;
    }

    static async executeUserScript(scriptCode, libraryName, scriptType, showNotices, consolePrefix = PLUGIN_CONSOLE_PREFIX) {
        if (typeof scriptCode !== 'string' || scriptCode.trim() === "") {
            console.log(`${consolePrefix} No ${scriptType} script provided for "${libraryName || 'Unnamed Library'}" or script is empty. Skipping execution.`);
            return { success: true, message: "No script to execute or script was empty." };
        }
        const safeLibraryName = typeof libraryName === 'string' && libraryName.trim() !== "" ? libraryName : 'Unnamed Library';
        const safeScriptType = typeof scriptType === 'string' && scriptType.trim() !== "" ? scriptType : 'User Script';

        const noticeDurationShort = 2000;
        const noticeDurationMedium = 3000;
        const noticeDurationLong = 7000;

        if (showNotices) new Notice(`ScriptPilot: Running ${safeScriptType} for "${safeLibraryName}"...`, noticeDurationShort);
        console.log(`${consolePrefix} Attempting to run ${safeScriptType} script for "${safeLibraryName}".`);

        try {
            if (typeof window === 'undefined') {
                throw new Error("`window` object is not available. Cannot execute script in this environment.");
            }
            const scriptFunction = new Function(`return (async () => { "use strict"; ${scriptCode} })();`);
            await scriptFunction.call(window);

            if (showNotices) new Notice(`ScriptPilot: "${safeLibraryName}" ${safeScriptType} script finished successfully.`, noticeDurationMedium);
            console.log(`${consolePrefix} "${safeLibraryName}" ${safeScriptType} script executed successfully.`);
            return { success: true };
        } catch (error) {
            const typedError = error instanceof Error ? error : new Error(String(error || "Unknown error during script execution."));
            const errorMessage = `Error running ${safeScriptType} script for "${safeLibraryName}": ${typedError.message}`;

            console.error(`${consolePrefix} ${errorMessage}. Script content (first 200 chars): "${scriptCode.substring(0,200)}"`, typedError);
            if (showNotices) new Notice(`ScriptPilot: ${errorMessage}. Check console for details.`, noticeDurationLong);
            return { success: false, error: typedError, details: typedError };
        }
    }
}

class ScriptInjectorService {
    injectScript(libraryId, libraryCode) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Invalid libraryId (empty or not a string) provided for script injection.`);
            throw new Error("Invalid libraryId for script injection.");
        }
        if (typeof libraryCode !== 'string') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Invalid script content for library ${libraryId}: must be a string, but got ${typeof libraryCode}.`);
            throw new Error(`Invalid script content for library ${libraryId}: must be a string.`);
        }

        if (libraryCode.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Injecting empty script for library ${libraryId}. This might be intentional or indicate an issue with the source. An empty script tag will be created.`);
        }

        const scriptElementId = `${SCRIPT_TAG_ID_PREFIX}${libraryId}`;
        this.removeScriptElementById(scriptElementId);

        let scriptElement;
        try {
            scriptElement = document.createElement('script');
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error creating script element"));
            const errorMsg = `Failed to create script element for library ${libraryId}.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, typedError);
            throw new Error(`${errorMsg} Reason: ${typedError.message}`);
        }

        scriptElement.id = scriptElementId;
        scriptElement.type = 'text/javascript';
        scriptElement.textContent = libraryCode;

        if (!document.head || !(document.head instanceof Element)) {
            const errorMsg = `document.head is not available or not a valid Element. Cannot inject script for library ${libraryId}.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            throw new Error(errorMsg);
        }

        try {
            document.head.appendChild(scriptElement);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error appending script element"));
            const errorMsg = `Failed to append script element to document.head for library ${libraryId}.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, typedError);
            throw new Error(`${errorMsg} Reason: ${typedError.message}`);
        }

        console.log(`${PLUGIN_CONSOLE_PREFIX} Script for library ${libraryId} injected successfully.`);
        return scriptElement;
    }

    removeScriptElementById(scriptElementId) {
        if (typeof scriptElementId !== 'string' || scriptElementId.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} removeScriptElementById called with invalid or empty ID. Skipping.`);
            return;
        }
        try {
            const oldScriptElement = document.getElementById(scriptElementId);
            if (oldScriptElement && oldScriptElement.parentNode) {
                oldScriptElement.parentNode.removeChild(oldScriptElement);
            } else if (oldScriptElement) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Script element with ID ${scriptElementId} found but has no parentNode. Cannot remove.`);
            } else {
            }
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing script element"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing script element with ID ${scriptElementId}:`, typedError);
        }
    }

    removeScript(libraryId, scriptElement) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} removeScript called with invalid libraryId. Will attempt removal by scriptElement if provided.`);
        }

        try {
            if (scriptElement && scriptElement instanceof HTMLScriptElement && scriptElement.parentNode) {
                scriptElement.parentNode.removeChild(scriptElement);
            } else if (libraryId && typeof libraryId === 'string' && libraryId.trim() !== "") {
                this.removeScriptElementById(`${SCRIPT_TAG_ID_PREFIX}${libraryId}`);
            } else if (scriptElement) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} removeScript provided with a scriptElement that is not in the DOM or invalid for library ${libraryId || 'unknown'}.`);
            } else {
            }
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing script"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing script for library ${libraryId || 'unknown'}:`, typedError);
        }
    }
}

class AbstractLoaderStrategy {
    constructor(app, library, showNotices) {
        if (this.constructor === AbstractLoaderStrategy) {
            throw new TypeError("Abstract class 'AbstractLoaderStrategy' cannot be instantiated directly.");
        }
        if (!app || typeof app.vault === 'undefined') {
             throw new Error("AbstractLoaderStrategy: 'app' parameter is missing or invalid.");
        }
        if (!library || typeof library.id !== 'string' || library.id.trim() === "" ||
            typeof library.name !== 'string' ) {
            throw new Error("AbstractLoaderStrategy: 'library' parameter must be an object with at least 'id' (string) and 'name' (string).");
        }
        this.app = app;
        this.library = library;
        this.showNotices = !!showNotices;
    }

    async fetchScriptContent() {
        throw new Error(`fetchScriptContent() must be implemented by concrete loader strategy: ${this.constructor.name}.`);
    }

    cleanup() {
    }
}

class HttpCapacitorLoader extends AbstractLoaderStrategy {
    async fetchScriptContent() {
        if (!this.library.url || typeof this.library.url !== 'string' || this.library.url.trim() === "") {
            throw new Error(`Library URL is missing or invalid for "${this.library.name}". Cannot fetch content.`);
        }
        try {
            new URL(this.library.url);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Invalid URL format"));
            throw new Error(`Invalid URL format for library "${this.library.name}": ${this.library.url}. Error: ${typedError.message}`);
        }

        const capacitorHttp = Utils.getProperty(window, 'Capacitor.Plugins.Http');
        if (typeof capacitorHttp?.get !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} CapacitorHttp plugin (window.Capacitor.Plugins.Http.get) is not available or not a function.`);
            throw new Error("CapacitorHttp plugin is not available. This loader is intended for mobile environments where Capacitor is present.");
        }

        if (this.showNotices) new Notice(`ScriptPilot: Fetching "${this.library.name}" via CapacitorHttp...`, 3000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Fetching "${this.library.name}" via CapacitorHttp from URL: ${this.library.url}`);

        try {
            const options = { url: this.library.url, connectTimeout: 15000, readTimeout: 15000 };
            const response = await capacitorHttp.get(options);

            if (!response || typeof response.status !== 'number') {
                throw new Error(`Invalid or incomplete response object received from CapacitorHttp for "${this.library.name}".`);
            }

            if (response.status >= 200 && response.status < 300) {
                if (typeof response.data === 'string') {
                    console.log(`${PLUGIN_CONSOLE_PREFIX} Successfully fetched "${this.library.name}" via CapacitorHttp (Status: ${response.status}).`);
                    return response.data;
                } else {
                    const dataType = response.data === null ? 'null' : typeof response.data;
                    throw new Error(`Fetch succeeded for "${this.library.name}" (status ${response.status}), but response data was not a string (type: ${dataType}). Content might be unsuitable.`);
                }
            } else {
                const dataPreview = response.data ? `Data preview: ${String(response.data).substring(0, 100)}` : "No data in response body";
                throw new Error(`Fetch failed for "${this.library.name}". Status: ${response.status} ${response.headers?.['status-text'] || ''}. ${dataPreview}.`);
            }
        } catch (error) {
            const typedError = error instanceof Error ? error : new Error(String(error || "Unknown CapacitorHttp error"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} CapacitorHttp request failed for "${this.library.name}" (URL: ${this.library.url}):`, typedError);
            throw new Error(`CapacitorHttp request failed for "${this.library.name}": ${typedError.message}.`);
        }
    }
}

class HttpIframeLoader extends AbstractLoaderStrategy {
    iframe = null;
    messageListener = null;
    iframeTimeoutId = null;

    async fetchScriptContent() {
        if (!this.library.url || typeof this.library.url !== 'string' || this.library.url.trim() === "") {
            throw new Error(`Library URL is missing or invalid for "${this.library.name}". Cannot fetch via iframe.`);
        }
        try {
            new URL(this.library.url);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Invalid URL format"));
            throw new Error(`Invalid URL format for library "${this.library.name}" (iframe loader): ${this.library.url}. Error: ${typedError.message}`);
        }

        if (this.showNotices) new Notice(`ScriptPilot: Fetching "${this.library.name}" via Iframe...`, 3000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Attempting to fetch "${this.library.name}" via Iframe from URL: ${this.library.url}`);

        this.cleanup();

        if (!document.body || !(document.body instanceof Element)) {
            const errorMsg = `document.body is not available or not a valid Element. Cannot inject iframe for "${this.library.name}".`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            throw new Error(errorMsg);
        }

        try {
            this.iframe = document.createElement('iframe');
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error creating iframe"));
            const errorMsg = `Failed to create iframe element for ${this.library.name}.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, typedError);
            this.cleanup();
            throw new Error(`${errorMsg} Reason: ${typedError.message}`);
        }

        this.iframe.style.display = 'none';
        this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

        try {
            document.body.appendChild(this.iframe);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error appending iframe"));
            const errorMsg = `Failed to append iframe to document.body for ${this.library.name}.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, typedError);
            this.cleanup();
            throw new Error(`${errorMsg} Reason: ${typedError.message}`);
        }


        const messageSuccessType = `${this.library.id}${IFRAME_MESSAGE_TYPE_SUCCESS_SUFFIX}`;
        const messageErrorType = `${this.library.id}${IFRAME_MESSAGE_TYPE_ERROR_SUFFIX}`;

        return new Promise((resolve, reject) => {
            try {
                this.iframeTimeoutId = window.setTimeout(() => {
                    if (this.iframeTimeoutId !== null) {
                        const timeoutMsg = `Timeout: Iframe did not return script for "${this.library.name}" within ${IFRAME_LOAD_TIMEOUT_MS / 1000}s. Possible reasons: network issue, CORS problem, or script error in iframe.`;
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} ${timeoutMsg} URL: ${this.library.url}`);
                        this.cleanup();
                        reject(new Error(timeoutMsg));
                    }
                }, IFRAME_LOAD_TIMEOUT_MS);

                this.messageListener = (event) => {
                    if (!this.iframe || event.source !== this.iframe.contentWindow) {
                        return;
                    }
                    if (!event.data || typeof event.data !== 'object' || event.data.libId !== this.library.id) {
                        return;
                    }

                    if (event.data.type !== messageSuccessType && event.data.type !== messageErrorType) {
                        return;
                    }

                    const wasActiveTimeout = this.iframeTimeoutId !== null;
                    this.cleanup();

                    if (!wasActiveTimeout) {
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} Message for "${this.library.name}" received after timeout had already occurred and cleaned up. Ignoring late message.`);
                        return;
                    }

                    if (event.data.type === messageSuccessType) {
                        if (typeof event.data.code === 'string') {
                            console.log(`${PLUGIN_CONSOLE_PREFIX} Successfully received script content for "${this.library.name}" via iframe.`);
                            resolve(event.data.code);
                        } else {
                            const errMsg = `Iframe for "${this.library.name}" returned success but script code was missing or not a string (type: ${typeof event.data.code}).`;
                            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errMsg} Data:`, event.data);
                            reject(new Error(errMsg));
                        }
                    } else if (event.data.type === messageErrorType) {
                        const iframeErrorMsg = event.data.message || 'Unknown error from iframe content script.';
                        const errMsg = `Iframe for "${this.library.name}" reported an error during fetch: ${iframeErrorMsg}`;
                        console.error(`${PLUGIN_CONSOLE_PREFIX} ${errMsg} Data:`, event.data);
                        reject(new Error(errMsg));
                    }
                };
                window.addEventListener('message', this.messageListener);

                const iframeContent = `
                    <!DOCTYPE html><html><head><meta charset="utf-8"><title>ScriptPilot Loader Iframe</title></head><body><script>
                    (async () => {
                        const libId = '${this.library.id}';
                        const successType = '${messageSuccessType}';
                        const errorType = '${messageErrorType}';
                        try {
                            const url = ${JSON.stringify(this.library.url)};
                            const response = await fetch(url, { mode: 'cors', cache: 'no-cache', signal: AbortSignal.timeout(${IFRAME_LOAD_TIMEOUT_MS - 5000}) });
                            if (!response.ok) {
                                throw new Error(\`HTTP error! Status: \${response.status} \${response.statusText || '(No status text)'}. URL: \${url}\`);
                            }
                            const scriptContent = await response.text();
                            window.parent.postMessage({ type: successType, code: scriptContent, libId: libId }, '*');
                        } catch (error) {
                            let errorMessage = 'Unknown iframe error';
                            if (error instanceof Error) {
                                errorMessage = error.message;
                                if (error.name === 'AbortError') {
                                    errorMessage = 'Fetch timed out in iframe.';
                                } else if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
                                    errorMessage = 'Network error or CORS issue in iframe. Check browser console for details from iframe context.';
                                }
                            } else {
                                errorMessage = String(error);
                            }
                            window.parent.postMessage({ type: errorType, message: errorMessage, libId: libId, errorDetail: error instanceof Error ? {name: error.name, message: error.message} : String(error) }, '*');
                        }
                    })();
                    <\/script></body></html>`;

                if (this.iframe && this.iframe.contentWindow) {
                    this.iframe.srcdoc = iframeContent;
                } else {
                    const errMsg = `Iframe for "${this.library.name}" was removed or became invalid before content could be loaded. This should not happen if cleanup is managed correctly.`;
                    console.error(`${PLUGIN_CONSOLE_PREFIX} ${errMsg}`);
                    this.cleanup();
                    reject(new Error(errMsg));
                }
            } catch (setupError) {
                const typedSetupError = setupError instanceof Error ? setupError : new Error(String(setupError || "Unknown iframe setup error"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error setting up iframe loader for "${this.library.name}":`, typedSetupError);
                this.cleanup();
                reject(new Error(`Setup error for iframe loader "${this.library.name}": ${typedSetupError.message}`));
            }
        });
    }

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
            const libName = this.library?.name || 'unknown library (iframe cleanup)';
            try {
                if (this.iframe.contentWindow && this.iframe.parentNode) {
                    this.iframe.src = 'about:blank';
                }
            } catch (e) {
            }
            if (this.iframe.parentNode) {
                try {
                    this.iframe.parentNode.removeChild(this.iframe);
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing iframe"));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing iframe for "${libName}" from DOM:`, typedError);
                }
            }
            this.iframe = null;
        }
    }
}

class LocalFileLoader extends AbstractLoaderStrategy {
    async fetchScriptContent() {
        if (!this.library.filePath || typeof this.library.filePath !== 'string' || this.library.filePath.trim() === "") {
            throw new Error(`Library File Path is missing or invalid for "${this.library.name}".`);
        }
        if (!this.library.filePath.toLowerCase().endsWith('.js')) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} File path "${this.library.filePath}" for library "${this.library.name}" does not end with .js. Proceeding, but ensure it is valid JavaScript.`);
        }

        if (!this.app?.vault?.getAbstractFileByPath || typeof this.app.vault.getAbstractFileByPath !== 'function' ||
            !this.app?.vault?.read || typeof this.app.vault.read !== 'function') {
            const errorMsg = `Obsidian vault API (getAbstractFileByPath or read) is not available. Cannot load local file for "${this.library.name}".`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            throw new Error(errorMsg);
        }

        let abstractFile;
        try {
            const normalizedPath = this.library.filePath.replace(/^\/+|\/+$/g, '');
            abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error accessing file path"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error accessing file path "${this.library.filePath}" for library "${this.library.name}":`, typedError);
            throw new Error(`Error accessing file path "${this.library.filePath}": ${typedError.message}`);
        }

        if (!abstractFile) {
            throw new Error(`File not found at path "${this.library.filePath}" for library "${this.library.name}". Please check the path and ensure the file exists in the vault.`);
        }
        if (!(abstractFile instanceof TFile)) {
            throw new Error(`Path "${this.library.filePath}" for library "${this.library.name}" points to a folder or an unsupported item, not a file.`);
        }

        if (this.showNotices) new Notice(`ScriptPilot: Reading "${this.library.name}" from "${this.library.filePath}"...`, 3000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Reading local file "${this.library.filePath}" for library "${this.library.name}".`);

        try {
            const content = await this.app.vault.read(abstractFile);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Successfully read file "${this.library.filePath}" for library "${this.library.name}".`);
            return content;
        } catch (error) {
            const typedError = error instanceof Error ? error : new Error(String(error || "Unknown error reading file"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to read file "${this.library.filePath}" for library "${this.library.name}":`, typedError);
            throw new Error(`Failed to read file "${this.library.filePath}": ${typedError.message}`);
        }
    }
}

class LibraryStateManager extends Events {
    libraryStates = new Map();

    _ensureState(libraryId) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.error(`${PLUGIN_CONSOLE_PREFIX} _ensureState called with invalid libraryId (empty or not a string). This indicates a programming error.`);
            const tempId = `invalid-id-${Utils.generateUniqueId()}`;
            if (!this.libraryStates.has(tempId)) {
                 this.libraryStates.set(tempId, this._createDefaultState());
                 console.warn(`${PLUGIN_CONSOLE_PREFIX} Created temporary state for anomalous ID: ${tempId} due to invalid input libraryId.`);
            }
            return this.libraryStates.get(tempId);
        }

        if (!this.libraryStates.has(libraryId)) {
            this.libraryStates.set(libraryId, this._createDefaultState());
        }
        return this.libraryStates.get(libraryId);
    }

    _createDefaultState() {
        return {
            isLoading: false,
            isLoaded: false,
            lastError: undefined,
            scriptElement: undefined,
            globalObjectPresent: undefined,
            activeLoader: undefined,
            lastLoadedAt: null
        };
    }

    updateState(libraryId, changes) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.error(`${PLUGIN_CONSOLE_PREFIX} updateState called with invalid libraryId. State not updated.`);
            return;
        }
        if (typeof changes !== 'object' || changes === null) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} updateState called with invalid changes object (not an object or null) for libraryId: ${libraryId}. State not updated.`);
            return;
        }

        const state = this._ensureState(libraryId);
        Object.assign(state, changes);

        try {
            this.trigger('state-change', libraryId, { ...state });
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error triggering state-change event"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error triggering 'state-change' event for library ${libraryId}:`, typedError);
        }
    }

    getState(libraryId) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            return undefined;
        }
        const state = this.libraryStates.get(libraryId);
        return state ? { ...state } : undefined;
    }

    getLoadedCount(librariesConfig) {
        if (!Array.isArray(librariesConfig)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} getLoadedCount called with invalid librariesConfig (not an array). Returning 0.`);
            return 0;
        }
        return librariesConfig.reduce((count, lib) => {
            if (lib && typeof lib.id === 'string' && lib.id.trim() !== "") {
                const state = this.libraryStates.get(lib.id);
                return (state && state.isLoaded === true) ? count + 1 : count;
            }
            return count;
        }, 0);
    }

    getLoadingCount() {
        let count = 0;
        this.libraryStates.forEach(state => {
            if (state && state.isLoading === true) count++;
        });
        return count;
    }

    checkGlobalObjectPresence(libraryConfig) {
        if (!libraryConfig || typeof libraryConfig.id !== 'string' || libraryConfig.id.trim() === "") {
            return false;
        }

        const state = this.libraryStates.get(libraryConfig.id);
        if (!state) {
            return false;
        }

        let changed = false;
        const globalObjectName = typeof libraryConfig.globalObjectName === 'string' ? libraryConfig.globalObjectName.trim() : "";

        if (state.isLoaded && globalObjectName !== "") {
            const newGlobalObjectPresent = typeof Utils.getProperty(window, globalObjectName) !== 'undefined';
            if (newGlobalObjectPresent !== state.globalObjectPresent) {
                state.globalObjectPresent = newGlobalObjectPresent;
                this.updateState(libraryConfig.id, { globalObjectPresent: newGlobalObjectPresent });
                changed = true;
            }
        } else if (globalObjectName === "" && typeof state.globalObjectPresent !== 'undefined') {
            state.globalObjectPresent = undefined;
            this.updateState(libraryConfig.id, { globalObjectPresent: undefined });
            changed = true;
        } else if (!state.isLoaded && state.globalObjectPresent === true) {
            state.globalObjectPresent = false;
            this.updateState(libraryConfig.id, { globalObjectPresent: false });
            changed = true;
        }
        return changed;
    }

    checkAllGlobalObjectsPresence(librariesConfig) {
        if (!Array.isArray(librariesConfig)) {
            return false;
        }
        return librariesConfig.some(lib => {
            if (lib && typeof lib.id === 'string' && lib.id.trim() !== "") {
                return this.checkGlobalObjectPresence(lib);
            }
            return false;
        });
    }

    deleteState(libraryId) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} deleteState called with invalid libraryId. No state deleted.`);
            return;
        }
        const state = this.libraryStates.get(libraryId);
        if (state) {
            try {
                if (state.activeLoader && typeof state.activeLoader.cleanup === 'function') {
                    state.activeLoader.cleanup();
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error during loader cleanup"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error during activeLoader.cleanup() for library ${libraryId} in deleteState:`, typedError);
            }
            this.libraryStates.delete(libraryId);
            try {
                this.trigger('state-delete', libraryId);
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error triggering state-delete event"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error triggering 'state-delete' event for ${libraryId}:`, typedError);
            }
        } else {
        }
    }

    cleanupAllStates(librariesConfig, scriptInjector) {
        let effectiveLibraryIds;
        if (!Array.isArray(librariesConfig)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} cleanupAllStates: librariesConfig is not an array. Will attempt to clean up based on current map keys only.`);
            effectiveLibraryIds = Array.from(this.libraryStates.keys());
        } else {
            effectiveLibraryIds = librariesConfig.map(lib => lib?.id).filter(id => typeof id === 'string' && id.trim() !== "");
            const stateKeys = Array.from(this.libraryStates.keys());
            stateKeys.forEach(key => {
                if (!effectiveLibraryIds.includes(key)) {
                    effectiveLibraryIds.push(key);
                }
            });
        }

        if (!scriptInjector || typeof scriptInjector.removeScript !== 'function' || typeof scriptInjector.removeScriptElementById !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} cleanupAllStates: scriptInjector is invalid or missing required methods. Scripts may not be removed from DOM.`);
            scriptInjector = null;
        }

        console.log(`${PLUGIN_CONSOLE_PREFIX} Cleaning up all library states for ${effectiveLibraryIds.length} unique library IDs.`);
        effectiveLibraryIds.forEach(libId => {
            const state = this.libraryStates.get(libId);
            if (state) {
                try {
                    if (state.activeLoader && typeof state.activeLoader.cleanup === 'function') {
                        state.activeLoader.cleanup();
                    }
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error during loader cleanup"));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error during activeLoader.cleanup() for library ${libId} in cleanupAllStates:`, typedError);
                }
                if (scriptInjector) {
                    if (state.scriptElement) {
                        try {
                            scriptInjector.removeScript(libId, state.scriptElement);
                        } catch (e) {
                            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing script by element"));
                            console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing script (via element) for library ${libId} in cleanupAllStates:`, typedError);
                        }
                    } else {
                        try {
                            scriptInjector.removeScriptElementById(`${SCRIPT_TAG_ID_PREFIX}${libId}`);
                        } catch (e) {
                            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing script by ID"));
                            console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing script (via ID) for library ${libId} in cleanupAllStates:`, typedError);
                        }
                    }
                }
            }
        });
        this.libraryStates.clear();
        console.log(`${PLUGIN_CONSOLE_PREFIX} All library states map cleared.`);
        try {
            this.trigger('all-states-cleared');
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error triggering all-states-cleared event"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error triggering 'all-states-cleared' event:`, typedError);
        }
    }
}

class LibraryController {
    constructor(app, settingsGetter, stateManager, scriptInjector) {
        if (!app || typeof app.vault === 'undefined') {
            throw new Error("LibraryController: 'app' parameter is missing or invalid.");
        }
        if (typeof settingsGetter !== 'function') {
            throw new Error("LibraryController: 'settingsGetter' must be a function.");
        }
        if (!stateManager || typeof stateManager.updateState !== 'function' || typeof stateManager._ensureState !== 'function') {
            throw new Error("LibraryController: 'stateManager' is invalid or missing required methods.");
        }
        if (!scriptInjector || typeof scriptInjector.injectScript !== 'function' || typeof scriptInjector.removeScript !== 'function') {
            throw new Error("LibraryController: 'scriptInjector' is invalid or missing required methods.");
        }

        this.app = app;
        this.getSettings = settingsGetter;
        this.stateManager = stateManager;
        this.scriptInjector = scriptInjector;
    }

    _getLoaderStrategy(library, showNotices) {
        if (!library || typeof library.type !== 'string' || library.type.trim() === "") {
            const libName = library?.name || library?.id || 'Unknown library';
            const errorMsg = `Unknown or invalid library type for "${libName}". Type provided: ${library?.type}`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            throw new Error(errorMsg);
        }
        switch (library.type) {
            case 'http': return new HttpCapacitorLoader(this.app, library, showNotices);
            case 'http-iframe': return new HttpIframeLoader(this.app, library, showNotices);
            case 'localFile': return new LocalFileLoader(this.app, library, showNotices);
            default:
                const errorMsg = `Unsupported library type: "${library.type}" for library "${library.name || library.id}".`;
                console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
                throw new Error(errorMsg);
        }
    }

    async loadLibrary(library, showNotices) {
        if (!library || typeof library.id !== 'string' || library.id.trim() === "" ||
            typeof library.name !== 'string'  ) {
            const errorMsg = "Cannot load library: Invalid library configuration data provided (e.g., missing ID, or ID/name not strings).";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, library);
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 7000);
            if (library?.id && typeof library.id === 'string' && library.id.trim() !== "") {
                 this.stateManager.updateState(library.id, {
                    lastError: new Error("Invalid library configuration data."),
                    isLoading: false,
                    isLoaded: false
                });
            }
            return;
        }
        if (!library.type || typeof library.type !== 'string' || library.type.trim() === "") {
            const errorMsg = `Library type is undefined or invalid for "${library.name}". Cannot load.`;
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            this.stateManager.updateState(library.id, { lastError: new Error(errorMsg), isLoading: false, isLoaded: false });
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 7000);
            return;
        }

        const state = this.stateManager._ensureState(library.id);
        if (state.isLoading) {
            const msg = `ScriptPilot: "${library.name}" is already loading. Request ignored.`;
            if (showNotices) new Notice(msg, 3000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) is already in loading process. Skipping duplicate load request.`);
            return;
        }
        if (state.isLoaded) {
            const msg = `ScriptPilot: "${library.name}" is already loaded. Skipping.`;
            if (showNotices) new Notice(msg, 3000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) is already loaded. Skipping load request.`);
            return;
        }

        this.stateManager.updateState(library.id, {
            isLoading: true,
            isLoaded: false,
            lastError: undefined,
            scriptElement: undefined,
            activeLoader: undefined,
            globalObjectPresent: undefined,
        });

        let loaderStrategy;

        try {
            loaderStrategy = this._getLoaderStrategy(library, showNotices);
            this.stateManager.updateState(library.id, { activeLoader: loaderStrategy });

            const libraryCode = await loaderStrategy.fetchScriptContent();

            const currentStateBeforeInject = this.stateManager.getState(library.id);
            if (!currentStateBeforeInject || !currentStateBeforeInject.isLoading) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Loading of "${library.name}" was cancelled or state changed before script injection. Aborting.`);
                if (loaderStrategy && typeof loaderStrategy.cleanup === 'function') {
                    try { loaderStrategy.cleanup(); } catch(e) { console.error(`${PLUGIN_CONSOLE_PREFIX} Error during cleanup for ${library.name} after cancellation:`, e); }
                }
                return;
            }

            if (showNotices) new Notice(`ScriptPilot: "${library.name}" content fetched. Injecting script...`, 2000);

            const scriptElement = this.scriptInjector.injectScript(library.id, libraryCode);
            this.stateManager.updateState(library.id, { scriptElement });

            if (library.initializationScript && typeof library.initializationScript === 'string' && library.initializationScript.trim()) {
                const initResult = await Utils.executeUserScript(
                    library.initializationScript, library.name, 'initialization', showNotices
                );
                if (!initResult.success) {
                    throw initResult.error || new Error(`Initialization script failed for "${library.name}".`);
                }
            }

            this.stateManager.updateState(library.id, {
                isLoaded: true,
                isLoading: false,
                globalObjectPresent: (library.globalObjectName && typeof library.globalObjectName === 'string' && library.globalObjectName.trim() !== "") ?
                    (typeof Utils.getProperty(window, library.globalObjectName) !== 'undefined') : undefined,
                lastError: undefined,
                lastLoadedAt: Date.now()
            });
            if (showNotices) new Notice(`ScriptPilot: "${library.name}" loaded successfully!`, 4000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) loaded successfully.`);

        } catch (error) {
            const typedError = error instanceof Error ? error : new Error(String(error || "Unknown error during library load."));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to load library "${library.name}" (ID: ${library.id}): ${typedError.message}`, typedError.stack, typedError);

            const currentState = this.stateManager.getState(library.id);
            if (currentState?.scriptElement) {
                try {
                    this.scriptInjector.removeScript(library.id, currentState.scriptElement);
                } catch (removeError) {
                    const typedRemoveError = removeError instanceof Error ? removeError : new Error(String(removeError));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error removing script element for "${library.name}" after load failure:`, typedRemoveError);
                }
            }

            this.stateManager.updateState(library.id, {
                isLoaded: false,
                isLoading: false,
                scriptElement: undefined,
                lastError: typedError,
                globalObjectPresent: false,
            });
            if (showNotices) new Notice(`ScriptPilot: Failed to load "${library.name}": ${typedError.message}. Check console for details.`, 7000);
        } finally {
            if (loaderStrategy && typeof loaderStrategy.cleanup === 'function') {
                const currentActiveLoader = this.stateManager.getState(library.id)?.activeLoader;
                if (loaderStrategy === currentActiveLoader) {
                    try {
                        loaderStrategy.cleanup();
                    } catch (cleanupError) {
                        const typedCleanupError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error during loader cleanup for "${library.name}":`, typedCleanupError);
                    }
                    const finalState = this.stateManager.getState(library.id);
                    if (finalState && !finalState.isLoading && finalState.activeLoader === loaderStrategy) {
                         this.stateManager.updateState(library.id, { activeLoader: undefined });
                    }
                } else if (currentActiveLoader) {
                }
            }
        }
    }

    async unloadLibrary(library, showNotices) {
        if (!library || typeof library.id !== 'string' || library.id.trim() === "" ||
            typeof library.name !== 'string' ) {
            const errorMsg = "Cannot unload library: Invalid library configuration data provided.";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, library);
            if (showNotices) new Notice(`ScriptPilot: ${errorMsg}`, 5000);
            return;
        }

        const state = this.stateManager.getState(library.id);
        if (!state) {
            const msg = `ScriptPilot: "${library.name}" has no state information, cannot unload. Assumed not loaded.`;
            if (showNotices) new Notice(msg, 3000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} No state found for library "${library.name}" (ID: ${library.id}). Cannot unload.`);
            return;
        }
        if (state.isLoading) {
            const msg = `ScriptPilot: "${library.name}" is currently loading. Unload request deferred. Try again shortly.`;
            if (showNotices) new Notice(msg, 4000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) is loading. Unload deferred.`);
            return;
        }
        if (!state.isLoaded && !state.scriptElement && !state.lastError) {
            const msg = `ScriptPilot: "${library.name}" is not loaded and no script element is tracked. Nothing to unload.`;
            if (showNotices) new Notice(msg, 2000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" (ID: ${library.id}) is not loaded. Skipping unload.`);
            return;
        }

        if (showNotices) new Notice(`ScriptPilot: Unloading "${library.name}"...`, 2000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Attempting to unload library "${library.name}" (ID: ${library.id}).`);

        let unloadedGracefully = true;
        const accumulatedErrors = [];

        try {
            if (state.isLoaded && library.destructionScript && typeof library.destructionScript === 'string' && library.destructionScript.trim()) {
                const destroyResult = await Utils.executeUserScript(
                    library.destructionScript, library.name, 'destruction', showNotices
                );
                if (!destroyResult.success) {
                    unloadedGracefully = false;
                    const errorDetail = destroyResult.error || new Error(`Destruction script failed for "${library.name}".`);
                    accumulatedErrors.push(errorDetail);
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Destruction script for "${library.name}" encountered an error:`, errorDetail);
                }
            }

            if (state.scriptElement) {
                this.scriptInjector.removeScript(library.id, state.scriptElement);
            } else {
                this.scriptInjector.removeScriptElementById(`${SCRIPT_TAG_ID_PREFIX}${library.id}`);
            }

            if (library.globalObjectName && typeof library.globalObjectName === 'string' && library.globalObjectName.trim()) {
                if (!Utils.deleteProperty(window, library.globalObjectName.trim())) {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Could not fully remove or set to undefined global object '${library.globalObjectName}' for library "${library.name}". It might be non-configurable or non-writable.`);
                }
            }
        } catch (e) {
            unloadedGracefully = false;
            const processError = e instanceof Error ? e : new Error(String(e || "Unknown error during unload process."));
            accumulatedErrors.push(processError);
            console.error(`${PLUGIN_CONSOLE_PREFIX} Unexpected error during unload process for "${library.name}":`, processError);
        } finally {
            if (state.activeLoader && typeof state.activeLoader.cleanup === 'function') {
                try {
                    state.activeLoader.cleanup();
                } catch (cleanupError) {
                    const typedCleanupError = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
                    accumulatedErrors.push(new Error(`Loader cleanup error during unload for "${library.name}": ${typedCleanupError.message}`));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error during activeLoader.cleanup() for "${library.name}" on unload:`, typedCleanupError);
                }
            }

            const finalErrorMsg = accumulatedErrors.length > 0
                ? accumulatedErrors.map(err => (err instanceof Error ? err.message : String(err))).join("; ")
                : undefined;

            const finalErrorObject = accumulatedErrors.length > 0
                ? (accumulatedErrors.length === 1 ? accumulatedErrors[0] : new Error(`Multiple issues during unload of "${library.name}": ${finalErrorMsg}`))
                : undefined;


            this.stateManager.updateState(library.id, {
                isLoaded: false,
                isLoading: false,
                scriptElement: undefined,
                globalObjectPresent: false,
                activeLoader: undefined,
                lastError: finalErrorObject,
            });

            if (!unloadedGracefully || accumulatedErrors.length > 0) {
                const noticeMsg = `ScriptPilot: "${library.name}" unloaded, but with issues. Check console. A restart of Obsidian might be needed for full cleanup if problems persist.`;
                if (showNotices) new Notice(noticeMsg, 8000);
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" unloaded with issues. Errors: ${finalErrorMsg || "See previous logs for details."}`);
            } else {
                if (showNotices) new Notice(`ScriptPilot: "${library.name}" unloaded successfully.`, 3000);
                console.log(`${PLUGIN_CONSOLE_PREFIX} Library "${library.name}" unloaded successfully.`);
            }
        }
    }

    cleanupAllLoadedScripts(librariesConfig) {
        if (!Array.isArray(librariesConfig)) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} cleanupAllLoadedScripts: librariesConfig is not an array. Cannot perform cleanup effectively based on config. StateManager will use its internal keys.`);
            this.stateManager.cleanupAllStates([], this.scriptInjector);
            return;
        }
        console.log(`${PLUGIN_CONSOLE_PREFIX} Initiating cleanup of all loaded scripts and their states based on provided configuration and existing states.`);
        this.stateManager.cleanupAllStates(librariesConfig, this.scriptInjector);
    }
}

class PluginSettingsManager {
    constructor(plugin) {
        if (!plugin || typeof plugin.loadData !== 'function' || typeof plugin.saveData !== 'function' || typeof plugin.manifest?.id !== 'string') {
            throw new Error("PluginSettingsManager: Invalid 'plugin' instance provided or missing essential properties/methods (loadData, saveData, manifest.id).");
        }
        this.plugin = plugin;
    }

    async load() {
        let loadedData = null;
        try {
            loadedData = await this.plugin.loadData();
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error loading data"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to load plugin data:`, typedError);
            loadedData = null;
        }

        const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

        if (typeof loadedData !== 'object' || loadedData === null) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} No valid saved settings found or settings were corrupted. Using default settings.`);
            this.plugin.settings = defaults;
        } else {
            this.plugin.settings = Object.assign({}, defaults, loadedData);
        }

        let settingsChanged = false;

        if (!Array.isArray(this.plugin.settings.libraries)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Settings: 'libraries' was not an array (found ${typeof this.plugin.settings.libraries}). Resetting to default empty array.`);
            this.plugin.settings.libraries = defaults.libraries;
            settingsChanged = true;
        }

        this.plugin.settings.libraries = this.plugin.settings.libraries.map(lib => {
            if (typeof lib !== 'object' || lib === null) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Found non-object item in libraries array, skipping. Item:`, lib);
                settingsChanged = true;
                return null;
            }

            let libChanged = false;
            if (!lib.id || typeof lib.id !== 'string' || lib.id.trim() === "") {
                lib.id = Utils.generateUniqueId();
                libChanged = true;
                console.log(`${PLUGIN_CONSOLE_PREFIX} Generated new ID for library (name: ${lib.name || 'N/A'}): ${lib.id}`);
            }

            const validTypes = ['http', 'http-iframe', 'localFile'];
            if (!lib.type || typeof lib.type !== 'string' || !validTypes.includes(lib.type)) {
                const oldType = lib.type;
                if (lib.url && typeof lib.url === 'string' && (lib.url.startsWith('http://') || lib.url.startsWith('https://'))) {
                     lib.type = 'http-iframe';
                } else if (lib.filePath && typeof lib.filePath === 'string') {
                    lib.type = 'localFile';
                } else {
                    lib.type = 'localFile';
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Library "${lib.name || lib.id}" has invalid or missing type ('${oldType}'), defaulting to '${lib.type}'. Please review configuration.`);
                }
                libChanged = true;
            }

            const defaultsForLib = {
                name: `Library ${lib.id.substring(0,8)}`,
                type: 'localFile',
                isEnabled: false,
                loadOrder: 0,
                url: '',
                filePath: '',
                initializationScript: '',
                destructionScript: '',
                globalObjectName: ''
            };

            for (const key in defaultsForLib) {
                if (typeof lib[key] === 'undefined' ||
                    (typeof defaultsForLib[key] === 'string' && typeof lib[key] !== 'string') ||
                    (typeof defaultsForLib[key] === 'number' && (typeof lib[key] !== 'number' || isNaN(lib[key]))) ||
                    (typeof defaultsForLib[key] === 'boolean' && typeof lib[key] !== 'boolean')
                ) {
                    lib[key] = defaultsForLib[key];
                    libChanged = true;
                }
            }

            if (isNaN(lib.loadOrder)) {
                lib.loadOrder = 0;
                libChanged = true;
            }
            if (typeof lib.name !== 'string') {
                lib.name = defaultsForLib.name;
                libChanged = true;
            }


            if (libChanged) settingsChanged = true;
            return lib;
        }).filter(lib => lib !== null);

        for (const key in defaults) {
            if (key === 'libraries') continue;

            if (typeof this.plugin.settings[key] !== typeof defaults[key]) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Settings: Top-level property '${key}' had incorrect type (${typeof this.plugin.settings[key]}), resetting to default (${typeof defaults[key]}).`);
                this.plugin.settings[key] = defaults[key];
                settingsChanged = true;
            }
        }

        let freq = this.plugin.settings.realtimePanelUpdateFrequency;
        if (typeof freq !== 'number' || isNaN(freq)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Settings: 'realtimePanelUpdateFrequency' was not a valid number (${freq}). Resetting to default.`);
            this.plugin.settings.realtimePanelUpdateFrequency = defaults.realtimePanelUpdateFrequency;
            settingsChanged = true;
        } else if (freq < MIN_REALTIME_UPDATE_FREQUENCY) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Settings: 'realtimePanelUpdateFrequency' (${freq}ms) was below minimum (${MIN_REALTIME_UPDATE_FREQUENCY}ms). Adjusting to minimum.`);
            this.plugin.settings.realtimePanelUpdateFrequency = MIN_REALTIME_UPDATE_FREQUENCY;
            settingsChanged = true;
        }


        if (settingsChanged) {
            console.log(`${PLUGIN_CONSOLE_PREFIX} Settings were migrated, corrected, or defaults applied due to missing/invalid values. Saving updated settings.`);
            await this.save();
        }
    }

    async save() {
        try {
            if (typeof this.plugin.settings !== 'object' || this.plugin.settings === null) {
                console.error(`${PLUGIN_CONSOLE_PREFIX} Attempted to save invalid settings object (null or not an object). Restoring defaults and attempting to save them instead.`);
                this.plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            }
            await this.plugin.saveData(this.plugin.settings);
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error saving settings"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to save plugin settings:`, typedError);
            new Notice(`${PLUGIN_CONSOLE_PREFIX} Error: Could not save settings. Changes may be lost. Check console for details.`, 7000);
        }
    }
}

class CommandOrchestrator {
    constructor(plugin) {
        if (!plugin || typeof plugin.addCommand !== 'function' ||
            !plugin.app?.commands || typeof plugin.app.commands.removeCommand !== 'function') {
            throw new Error("CommandOrchestrator: Invalid 'plugin' instance or missing essential command capabilities (addCommand, app.commands, app.commands.removeCommand).");
        }
        this.plugin = plugin;
        this.libraryCommandIds = new Map();
    }

    addPluginCommands() {
        try {
            this.plugin.addCommand({
                id: 'load-all-enabled-scripts',
                name: 'ScriptPilot: Load All Enabled Libraries',
                callback: async () => {
                    try {
                        await this.plugin.loadAllEnabledLibraries(true);
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error in Load All command"));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error in 'Load All Enabled Libraries' command callback:`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Error loading all libraries: ${typedError.message}. See console.`, 7000);
                    }
                },
            });

            this.plugin.addCommand({
                id: 'unload-all-loaded-scripts',
                name: 'ScriptPilot: Unload All Loaded Libraries',
                callback: async () => {
                    try {
                        await this.plugin.unloadAllLoadedLibraries(true);
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error in Unload All command"));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error in 'Unload All Loaded Libraries' command callback:`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Error unloading all libraries: ${typedError.message}. See console.`, 7000);
                    }
                },
            });

            this.plugin.addCommand({
                id: 'open-scriptpilot-settings',
                name: 'ScriptPilot: Open Settings',
                callback: () => {
                    try {
                        if (this.plugin.app?.setting?.open && typeof this.plugin.app.setting.open === 'function' &&
                            this.plugin.app?.setting?.openTabById && typeof this.plugin.app.setting.openTabById === 'function' &&
                            this.plugin.manifest?.id && typeof this.plugin.manifest.id === 'string') {
                            this.plugin.app.setting.open();
                            this.plugin.app.setting.openTabById(this.plugin.manifest.id);
                        } else {
                            throw new Error("Obsidian's settings API or plugin manifest ID not available or in expected format.");
                        }
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error opening settings"));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error opening settings tab via command:`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Could not open ScriptPilot settings: ${typedError.message}. See console.`, 7000);
                    }
                },
            });
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error adding global commands"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to add global plugin commands:`, typedError);
        }
    }

    addLibrarySpecificCommands(library) {
        if (!library || typeof library.id !== 'string' || !library.id.trim() ||
            typeof library.type !== 'string' || !library.type.trim() ||
            typeof library.name !== 'string') {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Cannot add commands: Invalid library configuration provided. Library:`, library);
            return;
        }

        this.removeLibrarySpecificCommands(library.id);

        const sanitizedId = library.id.replace(/[^\w\-_]/g, '');
        if (!sanitizedId) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Library ID "${library.id}" resulted in empty sanitized ID after character filtering. Cannot create commands.`);
            return;
        }
        const commandIdBase = `scriptpilot:${sanitizedId}`;
        const currentCommandIds = [];

        let typePrefix = 'Unknown Type';
        if (library.type === 'http') typePrefix = 'HTTP (Mobile)';
        else if (library.type === 'localFile') typePrefix = 'Local File';
        else if (library.type === 'http-iframe') typePrefix = 'HTTP (Iframe)';

        const libDisplayName = library.name || `Unnamed Library (ID: ${library.id.substring(0,8)})`;

        try {
            const loadCmd = this.plugin.addCommand({
                id: `${commandIdBase}:load`,
                name: `ScriptPilot: Load (${typePrefix}) - ${libDisplayName}`,
                checkCallback: (checking) => {
                    const state = this.plugin.libraryStateManager.getState(library.id);
                    const canLoad = !!library.type && (!state || (!state.isLoaded && !state.isLoading));
                    if (checking) return canLoad;
                    if (canLoad) {
                        this.plugin.libraryController.loadLibrary(library, true)
                            .catch(e => {
                                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error loading library from command"));
                                console.error(`${PLUGIN_CONSOLE_PREFIX} Error from load command for "${libDisplayName}":`, typedError);
                                new Notice(`${PLUGIN_CONSOLE_PREFIX} Error loading "${libDisplayName}": ${typedError.message}. See console.`, 7000);
                            });
                    }
                    return true;
                }
            });
            if (loadCmd?.id) currentCommandIds.push(loadCmd.id);

            const unloadCmd = this.plugin.addCommand({
                id: `${commandIdBase}:unload`,
                name: `ScriptPilot: Unload (${typePrefix}) - ${libDisplayName}`,
                checkCallback: (checking) => {
                    const state = this.plugin.libraryStateManager.getState(library.id);
                    const canUnload = !!library.type && !!state && state.isLoaded && !state.isLoading;
                    if (checking) return canUnload;
                    if (canUnload) {
                        this.plugin.libraryController.unloadLibrary(library, true)
                            .catch(e => {
                                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error unloading library from command"));
                                console.error(`${PLUGIN_CONSOLE_PREFIX} Error from unload command for "${libDisplayName}":`, typedError);
                                new Notice(`${PLUGIN_CONSOLE_PREFIX} Error unloading "${libDisplayName}": ${typedError.message}. See console.`, 7000);
                            });
                    }
                    return true;
                }
            });
            if (unloadCmd?.id) currentCommandIds.push(unloadCmd.id);

            const toggleCmd = this.plugin.addCommand({
                id: `${commandIdBase}:toggle`,
                name: `ScriptPilot: Toggle Load/Unload (${typePrefix}) - ${libDisplayName}`,
                checkCallback: (checking) => {
                    const state = this.plugin.libraryStateManager.getState(library.id);
                    const canToggle = !!library.type && (!state || !state.isLoading);
                    if (checking) return canToggle;
                    if (canToggle) {
                        const actionPromise = (state?.isLoaded) ?
                            this.plugin.libraryController.unloadLibrary(library, true) :
                            this.plugin.libraryController.loadLibrary(library, true);

                        actionPromise.catch(e => {
                            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error toggling library from command"));
                            console.error(`${PLUGIN_CONSOLE_PREFIX} Error from toggle command for "${libDisplayName}":`, typedError);
                            new Notice(`${PLUGIN_CONSOLE_PREFIX} Error toggling "${libDisplayName}": ${typedError.message}. See console.`, 7000);
                        });
                    }
                    return true;
                }
            });
            if (toggleCmd?.id) currentCommandIds.push(toggleCmd.id);

        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error adding commands for ${libDisplayName}`));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to add commands for library "${libDisplayName}":`, typedError);
        }

        if (currentCommandIds.length > 0) {
            this.libraryCommandIds.set(library.id, currentCommandIds);
        }
    }

    removeLibrarySpecificCommands(libraryId) {
        if (typeof libraryId !== 'string' || !libraryId.trim()) {
            return;
        }

        const commandIds = this.libraryCommandIds.get(libraryId);
        if (commandIds && Array.isArray(commandIds) && commandIds.length > 0) {
            commandIds.forEach(cmdId => {
                try {
                    if (this.plugin.app?.commands?.removeCommand && typeof this.plugin.app.commands.removeCommand === 'function') {
                         this.plugin.app.commands.removeCommand(cmdId);
                    } else if (this.plugin.app?.commands?.commands &&
                               typeof this.plugin.app.commands.commands === 'object' &&
                               Object.prototype.hasOwnProperty.call(this.plugin.app.commands.commands, cmdId)) {
                        delete this.plugin.app.commands.commands[cmdId];
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} Directly deleted command ID ${cmdId} from app.commands.commands. This is a fallback and might be unstable.`);
                    } else {
                        console.warn(`${PLUGIN_CONSOLE_PREFIX} Could not remove command ID ${cmdId}. Standard removal API not found or command not present in app.commands.commands. Command may persist until Obsidian restart.`);
                    }
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error removing command"));
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Error removing command ID ${cmdId} for library ${libraryId}:`, typedError.message, typedError);
                }
            });
            this.libraryCommandIds.delete(libraryId);
        }
    }

    updateAllLibraryCommands() {
        const existingLibraryIdsSnapshot = Array.from(this.libraryCommandIds.keys());

        const currentLibraryIdsFromSettings = new Set();
        const libraries = this.plugin.settings?.libraries;

        if (Array.isArray(libraries)) {
            libraries.forEach(lib => {
                if (lib && typeof lib.id === 'string' && lib.id.trim() &&
                    typeof lib.type === 'string' && lib.type.trim()) {
                    currentLibraryIdsFromSettings.add(lib.id);
                    this.addLibrarySpecificCommands(lib);
                } else {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Skipping command creation for malformed library entry in settings during updateAllLibraryCommands:`, lib);
                }
            });
        } else {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Cannot update library commands: settings.libraries is not an array or settings not loaded.`);
        }

        existingLibraryIdsSnapshot.forEach(libId => {
            if (!currentLibraryIdsFromSettings.has(libId)) {
                this.removeLibrarySpecificCommands(libId);
            }
        });
    }

    cleanupAllCommands() {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Cleaning up all registered library-specific commands.`);
        const libraryIdsSnapshot = Array.from(this.libraryCommandIds.keys());
        libraryIdsSnapshot.forEach(libId => this.removeLibrarySpecificCommands(libId));
        this.libraryCommandIds.clear();
    }
}

class ScriptPilotPlugin extends Plugin {
    settings;
    settingsManager;
    libraryStateManager;
    scriptInjector;
    libraryController;
    commandOrchestrator;
    settingTab;
    statusBarItemEl = null;
    realtimeStatusIntervalId = null;
    currentRealtimeUpdateFrequency = 0;

    boundHandleLibraryStateChange;
    boundHandleLibraryStateDelete;
    boundHandleAllLibraryStatesCleared;


    constructor(app, manifest) {
        super(app, manifest);
        try {
            this.settingsManager = new PluginSettingsManager(this);
            this.libraryStateManager = new LibraryStateManager();
            this.scriptInjector = new ScriptInjectorService();
            this.libraryController = new LibraryController(
                app,
                () => this.settings,
                this.libraryStateManager,
                this.scriptInjector
            );
            this.commandOrchestrator = new CommandOrchestrator(this);

            this.boundHandleLibraryStateChange = this._handleLibraryStateChange.bind(this);
            this.boundHandleLibraryStateDelete = this._handleLibraryStateDelete.bind(this);
            this.boundHandleAllLibraryStatesCleared = this._handleAllLibraryStatesCleared.bind(this);

        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error during plugin construction"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} CRITICAL ERROR during plugin construction:`, typedError);
            throw new Error(`ScriptPilotPlugin construction failed: ${typedError.message}. Plugin will be unstable or non-functional.`);
        }
    }

    async onload() {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Loading plugin (Version: ${this.manifest.version}).`);
        try {
            await this.settingsManager.load();

            this.libraryStateManager.on('state-change', this.boundHandleLibraryStateChange);
            this.libraryStateManager.on('state-delete', this.boundHandleLibraryStateDelete);
            this.libraryStateManager.on('all-states-cleared', this.boundHandleAllLibraryStatesCleared);

            try {
                const ribbonEl = this.addRibbonIcon('code-glyph', 'ScriptPilot: Manage Script Libraries', (evt) => {
                    try {
                        if (this.app?.setting?.open && typeof this.app.setting.open === 'function' &&
                            this.app?.setting?.openTabById && typeof this.app.setting.openTabById === 'function' &&
                            this.manifest?.id && typeof this.manifest.id === 'string') {
                            this.app.setting.open();
                            this.app.setting.openTabById(this.manifest.id);
                        } else {
                             const errorMsg = "Cannot open settings: Obsidian's settings API or plugin manifest ID not available.";
                             new Notice(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, 5000);
                             console.warn(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
                        }
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error opening settings via ribbon"));
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Error opening settings via ribbon: ${typedError.message}. See console.`, 7000);
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error opening settings via ribbon:`, typedError);
                    }
                });
                if (!ribbonEl) {
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Failed to add ribbon icon (Obsidian API returned null/undefined).`);
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error adding ribbon icon"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error trying to add ribbon icon:`, typedError);
            }


            this.commandOrchestrator.addPluginCommands();
            this.commandOrchestrator.updateAllLibraryCommands();

            if (this.settings.showStatusBar) {
                try {
                    this.statusBarItemEl = this.addStatusBarItem();
                    if (!this.statusBarItemEl) {
                         console.warn(`${PLUGIN_CONSOLE_PREFIX} Failed to add status bar item (Obsidian API returned null). Status bar will be unavailable.`);
                    } else {
                        this.updateStatusBar();
                    }
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error adding status bar item"));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to add status bar item:`, typedError);
                    this.statusBarItemEl = null;
                }
            }

            try {
                this.settingTab = new ScriptPilotSettingTab(this.app, this);
                this.addSettingTab(this.settingTab);
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error creating settings tab"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to create or add settings tab:`, typedError);
                this.settingTab = null;
            }


            if (this.settings.loadEnabledOnStartup) {
                const startupLoader = debounce(async () => {
                    try {
                        if (!this.settings.loadEnabledOnStartup) {
                            console.log(`${PLUGIN_CONSOLE_PREFIX} Startup library loading was disabled before execution could occur.`);
                            return;
                        }
                        console.log(`${PLUGIN_CONSOLE_PREFIX} Executing startup library loading as configured.`);
                        await this.loadAllEnabledLibraries(false);
                        const loadedCount = this.libraryStateManager.getLoadedCount(this.settings.libraries);
                        if (loadedCount > 0) {
                            new Notice(`ScriptPilot: ${loadedCount} libraries auto-loaded on startup.`, 4000);
                        } else {
                        }
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error during startup library loading"));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error during startup library loading:`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Error during startup load: ${typedError.message}. See console.`, 7000);
                    }
                }, 3000, true);

                if (this.app.workspace.layoutReady) {
                    console.log(`${PLUGIN_CONSOLE_PREFIX} Workspace layout already ready. Triggering startup loader if enabled.`);
                    if (this.settings.loadEnabledOnStartup) startupLoader();
                } else {
                    this.registerEvent(
                        this.app.workspace.on('layout-ready', () => {
                            console.log(`${PLUGIN_CONSOLE_PREFIX} Workspace layout ready event fired. Triggering startup loader if enabled.`);
                            if (this.settings.loadEnabledOnStartup) startupLoader();
                        })
                    );
                }
            }

            this._updateRealtimeStatusInterval();

        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown critical error during plugin onload"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} CRITICAL ERROR during plugin onload:`, typedError);
            new Notice(`${PLUGIN_CONSOLE_PREFIX} ScriptPilot failed to load properly. Some features might be unavailable. Check console for details.`, 10000);
        }
    }

    async onunload() {
        console.log(`${PLUGIN_CONSOLE_PREFIX} Unloading plugin.`);

        if (this.realtimeStatusIntervalId !== null) {
            window.clearInterval(this.realtimeStatusIntervalId);
            this.realtimeStatusIntervalId = null;
            console.log(`${PLUGIN_CONSOLE_PREFIX} Cleared real-time status update interval.`);
        }

        const librariesFromSettings = (this.settings && Array.isArray(this.settings.libraries)) ? [...this.settings.libraries] : [];

        const librariesToUnload = librariesFromSettings
            .filter(lib => {
                if (lib && typeof lib.id === 'string' && lib.id.trim() !== "") {
                    const state = this.libraryStateManager?.getState(lib.id);
                    return state?.isLoaded || state?.isLoading;
                }
                return false;
            })
            .sort((a, b) => (b.loadOrder || 0) - (a.loadOrder || 0));

        if (librariesToUnload.length > 0) {
            console.log(`${PLUGIN_CONSOLE_PREFIX} Unloading ${librariesToUnload.length} libraries.`);
            for (const lib of librariesToUnload) {
                try {
                    if (this.libraryController) {
                        await this.libraryController.unloadLibrary(lib, false);
                    }
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error unloading ${lib.name || lib.id}`));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error unloading library "${lib.name || lib.id}" during plugin unload:`, typedError.message, typedError);
                }
            }
        }

        if (this.libraryController) {
            this.libraryController.cleanupAllLoadedScripts(librariesFromSettings);
        }

        if (this.commandOrchestrator) {
            try {
                this.commandOrchestrator.cleanupAllCommands();
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error cleaning up commands"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error cleaning up commands:`, typedError);
            }
        }

        if (this.libraryStateManager) {
            try {
                this.libraryStateManager.off('state-change', this.boundHandleLibraryStateChange);
                this.libraryStateManager.off('state-delete', this.boundHandleLibraryStateDelete);
                this.libraryStateManager.off('all-states-cleared', this.boundHandleAllLibraryStatesCleared);
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error unregistering state listeners"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error unregistering state listeners:`, typedError);
            }
        }

        if (this.statusBarItemEl) {
            try {
                this.statusBarItemEl.remove();
            } catch (e) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Error removing status bar item during unload:`, e);
            }
            this.statusBarItemEl = null;
        }
        console.log(`${PLUGIN_CONSOLE_PREFIX} Plugin unloaded successfully.`);
    }

    async saveSettings() {
        if (!this.settingsManager) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} SettingsManager not available. Cannot save settings.`);
            new Notice(`${PLUGIN_CONSOLE_PREFIX} Error: Cannot save settings. Settings manager missing.`, 7000);
            return;
        }
        await this.settingsManager.save();

        this.updateStatusBarDisplay();
        this._updateRealtimeStatusInterval();

        if (this.commandOrchestrator) {
            try {
                this.commandOrchestrator.updateAllLibraryCommands();
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error updating library commands"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error updating library commands after saving settings:`, typedError);
            }
        }

        if (this.settingTab && typeof this.settingTab.debouncedDisplay === 'function') {
            try {
                if (this.settingTab.containerEl?.isShown?.() && document.body.contains(this.settingTab.containerEl)) {
                    this.settingTab.debouncedDisplay();
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error refreshing settings tab"));
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Error trying to refresh settings tab display after saving settings:`, typedError);
            }
        }
    }

    updateStatusBarDisplay() {
        if (!this.settings) {
            return;
        }

        if (this.settings.showStatusBar && !this.statusBarItemEl) {
            try {
                this.statusBarItemEl = this.addStatusBarItem();
                if (!this.statusBarItemEl) {
                     console.warn(`${PLUGIN_CONSOLE_PREFIX} Failed to add status bar item in updateStatusBarDisplay (API returned null). Status bar will be unavailable.`);
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error adding status bar item"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Failed to add status bar item in updateStatusBarDisplay:`, typedError);
                this.statusBarItemEl = null;
                return;
            }
        } else if (!this.settings.showStatusBar && this.statusBarItemEl) {
            try {
                this.statusBarItemEl.remove();
            } catch (e) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Error removing status bar item in updateStatusBarDisplay:`, e);
            }
            this.statusBarItemEl = null;
        }

        if (this.statusBarItemEl) {
            this.updateStatusBar();
        }
    }

    updateStatusBar() {
        if (!this.settings?.showStatusBar || !this.statusBarItemEl ||
            !this.libraryStateManager || !this.settings?.libraries) {
            return;
        }

        try {
            const loadedCount = this.libraryStateManager.getLoadedCount(this.settings.libraries);
            const loadingCount = this.libraryStateManager.getLoadingCount();

            this.statusBarItemEl.empty();
            let statusText = '';
            let iconKey = 'code-glyph';
            let ariaLabel = 'ScriptPilot Status';

            if (loadingCount > 0) {
                statusText = `Loading ${loadingCount}...`;
                iconKey = 'loader';
                ariaLabel = `ScriptPilot: Loading ${loadingCount} ${loadingCount === 1 ? 'library' : 'libraries'}.`;
            } else if (loadedCount > 0) {
                statusText = `${loadedCount} active`;
                iconKey = 'check-circle';
                ariaLabel = `ScriptPilot: ${loadedCount} ${loadedCount === 1 ? 'library' : 'libraries'} active.`;
            } else {
                statusText = 'None active';
                iconKey = 'info';
                ariaLabel = `ScriptPilot: No libraries active.`;
            }

            setIcon(this.statusBarItemEl, iconKey);
            this.statusBarItemEl.appendText(` ${statusText}`);
            this.statusBarItemEl.setAttribute('aria-label', ariaLabel);
            this.statusBarItemEl.title = ariaLabel;
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error updating status bar"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error updating status bar content:`, typedError);
            if (this.statusBarItemEl) {
                try {
                    this.statusBarItemEl.empty();
                    setIcon(this.statusBarItemEl, 'alert-triangle');
                    this.statusBarItemEl.appendText(' Error');
                    this.statusBarItemEl.title = "ScriptPilot: Error updating status. Check console.";
                    this.statusBarItemEl.setAttribute('aria-label', "ScriptPilot: Error updating status.");
                } catch (fallbackError) {
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Critical error: Failed to set fallback error state on status bar content:`, fallbackError);
                }
            }
        }
    }

    async loadAllEnabledLibraries(showIndividualNotices) {
        if (showIndividualNotices) new Notice('ScriptPilot: Loading all enabled libraries...', 3000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Attempting to load all enabled libraries.`);

        if (!this.settings?.libraries || !Array.isArray(this.settings.libraries)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} No libraries configured or settings not loaded. Cannot load all enabled libraries.`);
            if (showIndividualNotices) new Notice('ScriptPilot: No libraries configured to load.', 3000);
            this.updateStatusBar();
            return;
        }

        const sortedLibraries = [...this.settings.libraries]
            .filter(lib => {
                return lib && typeof lib.id === 'string' && lib.id.trim() !== "" &&
                       lib.isEnabled === true &&
                       lib.type && typeof lib.type === 'string' && lib.type.trim() !== "";
            })
            .sort((a, b) => (a.loadOrder || 0) - (b.loadOrder || 0));

        if (sortedLibraries.length === 0) {
            if (showIndividualNotices) new Notice('ScriptPilot: No enabled libraries found to load.', 3000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} No enabled libraries found to load.`);
            this.updateStatusBar();
            return;
        }

        let loadedSuccessfullyCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        for (const lib of sortedLibraries) {
            try {
                const state = this.libraryStateManager.getState(lib.id);
                if (state?.isLoaded) {
                    if (showIndividualNotices) new Notice(`ScriptPilot: "${lib.name}" is already loaded. Skipping.`, 2000);
                    loadedSuccessfullyCount++;
                    skippedCount++;
                } else if (state?.isLoading) {
                     if (showIndividualNotices) new Notice(`ScriptPilot: "${lib.name}" is already loading. Skipping.`, 2000);
                     skippedCount++;
                } else {
                    await this.libraryController.loadLibrary(lib, showIndividualNotices);
                    if (this.libraryStateManager.getState(lib.id)?.isLoaded) {
                        loadedSuccessfullyCount++;
                    } else {
                        failedCount++;
                    }
                }
            } catch (e) {
                failedCount++;
                const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error processing ${lib.name}`));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Unexpected error while iterating to load library "${lib.name}":`, typedError);
                if (showIndividualNotices) new Notice(`ScriptPilot: Error during batch load for "${lib.name}": ${typedError.message}. See console.`, 7000);
            }
        }

        if (showIndividualNotices) {
            let summaryMsg = `ScriptPilot: Load All complete. ${loadedSuccessfullyCount} of ${sortedLibraries.length} targeted libraries are now active.`;
            if (failedCount > 0) {
                summaryMsg += ` ${failedCount} failed to load.`;
            }
            if (skippedCount > 0 && skippedCount !== loadedSuccessfullyCount) {
                 summaryMsg += ` ${skippedCount} were skipped (already loaded/loading).`;
            }
            if (failedCount === 0 && loadedSuccessfullyCount === sortedLibraries.length) {
                summaryMsg = `ScriptPilot: All ${loadedSuccessfullyCount} targeted libraries are loaded or were already loaded/loading.`;
            }
            new Notice(summaryMsg, 5000);
        }
        console.log(`${PLUGIN_CONSOLE_PREFIX} Finished "Load All Enabled Libraries". Active/Already Loaded: ${loadedSuccessfullyCount}, Failed: ${failedCount}, Skipped (already loading/loaded): ${skippedCount}, Total targeted: ${sortedLibraries.length}.`);
        this.updateStatusBar();
    }

    async unloadAllLoadedLibraries(showIndividualNotices) {
        if (showIndividualNotices) new Notice('ScriptPilot: Unloading all loaded libraries...', 3000);
        console.log(`${PLUGIN_CONSOLE_PREFIX} Attempting to unload all loaded libraries.`);

        if (!this.settings?.libraries || !Array.isArray(this.settings.libraries)) {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} No libraries configured or settings not loaded. Cannot unload all loaded libraries.`);
            if (showIndividualNotices) new Notice('ScriptPilot: No libraries configured to determine which are loaded.', 3000);
            this.updateStatusBar();
            return;
        }

        const sortedLibrariesToUnload = [...this.settings.libraries]
            .filter(lib => {
                if (lib && typeof lib.id === 'string' && lib.id.trim() !== "") {
                    const state = this.libraryStateManager.getState(lib.id);
                    return state?.isLoaded === true;
                }
                return false;
            })
            .sort((a, b) => (b.loadOrder || 0) - (a.loadOrder || 0));

        if (sortedLibrariesToUnload.length === 0) {
            if (showIndividualNotices) new Notice('ScriptPilot: No libraries were found to be loaded. Nothing to unload.', 3000);
            console.log(`${PLUGIN_CONSOLE_PREFIX} No loaded libraries found to unload.`);
            this.updateStatusBar();
            return;
        }

        let unloadedSuccessfullyCount = 0;
        let failedUnloadCount = 0;
        for (const lib of sortedLibrariesToUnload) {
            try {
                await this.libraryController.unloadLibrary(lib, showIndividualNotices);
                const stateAfterUnload = this.libraryStateManager.getState(lib.id);
                if (stateAfterUnload && !stateAfterUnload.isLoaded && !stateAfterUnload.isLoading) {
                    unloadedSuccessfullyCount++;
                } else {
                    failedUnloadCount++;
                    console.warn(`${PLUGIN_CONSOLE_PREFIX} Library "${lib.name}" may not have unloaded correctly during "Unload All". State after unload attempt:`, stateAfterUnload);
                }
            } catch (e) {
                failedUnloadCount++;
                const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error processing unload for ${lib.name}`));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Unexpected error while iterating to unload library "${lib.name}":`, typedError);
                if (showIndividualNotices) new Notice(`ScriptPilot: Error during batch unload for "${lib.name}": ${typedError.message}. See console.`, 7000);
            }
        }

        if (showIndividualNotices) {
            let summaryMsg = `ScriptPilot: Unload All complete. ${unloadedSuccessfullyCount} of ${sortedLibrariesToUnload.length} targeted libraries processed for unload.`;
            if (failedUnloadCount > 0) {
                summaryMsg += ` ${failedUnloadCount} encountered issues during unload. Check console.`;
            }
            new Notice(summaryMsg, 5000);
        }
        console.log(`${PLUGIN_CONSOLE_PREFIX} Finished "Unload All Loaded Libraries". Unloaded successfully: ${unloadedSuccessfullyCount}, Issues/Failed: ${failedUnloadCount}, Total targeted: ${sortedLibrariesToUnload.length}.`);
        this.updateStatusBar();
    }

    _updateRealtimeStatusInterval() {
        if (!this.settings) {
            if (this.realtimeStatusIntervalId !== null) {
                window.clearInterval(this.realtimeStatusIntervalId);
                this.realtimeStatusIntervalId = null;
                console.log(`${PLUGIN_CONSOLE_PREFIX} Cleared real-time status interval due to missing settings.`);
            }
            return;
        }

        const shouldRunPanel = !!this.settings.showRealtimeStatusPanel;

        let newFrequency = parseInt(String(this.settings.realtimePanelUpdateFrequency), 10);
        if (isNaN(newFrequency)) {
            newFrequency = DEFAULT_SETTINGS.realtimePanelUpdateFrequency;
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Real-time panel update frequency was NaN, corrected to ${newFrequency}ms.`);
        } else if (newFrequency < MIN_REALTIME_UPDATE_FREQUENCY) {
            newFrequency = MIN_REALTIME_UPDATE_FREQUENCY;
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Real-time panel update frequency was below minimum, corrected to ${newFrequency}ms.`);
        }

        if (this.realtimeStatusIntervalId !== null) {
            if (!shouldRunPanel || this.currentRealtimeUpdateFrequency !== newFrequency) {
                window.clearInterval(this.realtimeStatusIntervalId);
                this.realtimeStatusIntervalId = null;
            }
        }

        if (shouldRunPanel && this.realtimeStatusIntervalId === null) {
            this.currentRealtimeUpdateFrequency = newFrequency;
            this.realtimeStatusIntervalId = window.setInterval(() => {
                try {
                    if (this.settingTab?.containerEl?.isShown?.() &&
                        document.body.contains(this.settingTab.containerEl) &&
                        this.settings?.libraries && Array.isArray(this.settings.libraries) &&
                        this.libraryStateManager) {

                        this.libraryStateManager.checkAllGlobalObjectsPresence(this.settings.libraries);

                        if (typeof this.settingTab.debouncedDisplay === 'function') {
                            this.settingTab.debouncedDisplay();
                        }
                    }
                } catch (e) {
                    const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error in real-time status interval"));
                    console.error(`${PLUGIN_CONSOLE_PREFIX} Error in real-time status update interval:`, typedError);
                }
            }, newFrequency);
            this.registerInterval(this.realtimeStatusIntervalId);
            console.log(`${PLUGIN_CONSOLE_PREFIX} Started real-time status interval with frequency ${newFrequency}ms.`);
        }
    }

    _handleLibraryStateChange(libraryId, _newState) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} _handleLibraryStateChange received invalid libraryId.`);
            return;
        }
        this.updateStatusBar();

        if (this.settingTab?.containerEl?.isShown?.() &&
            document.body.contains(this.settingTab.containerEl) &&
            typeof this.settingTab.debouncedDisplay === 'function') {
            this.settingTab.debouncedDisplay();
        }
    }

    _handleLibraryStateDelete(libraryId) {
        if (typeof libraryId !== 'string' || libraryId.trim() === "") {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} _handleLibraryStateDelete received invalid libraryId.`);
            return;
        }
        this.updateStatusBar();

        if (this.settingTab?.containerEl?.isShown?.() &&
            document.body.contains(this.settingTab.containerEl) &&
            typeof this.settingTab.debouncedDisplay === 'function') {
            this.settingTab.debouncedDisplay();
        }
    }

    _handleAllLibraryStatesCleared() {
        this.updateStatusBar();

        if (this.settingTab?.containerEl?.isShown?.() &&
            document.body.contains(this.settingTab.containerEl) &&
            typeof this.settingTab.debouncedDisplay === 'function') {
            this.settingTab.debouncedDisplay();
        }
    }
}

class ScriptPilotSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        if (!(plugin instanceof ScriptPilotPlugin) || !plugin.settingsManager || !plugin.libraryStateManager || !plugin.libraryController) {
            const errorMsg = "ScriptPilotSettingTab initialized with invalid or incomplete plugin instance. Essential components might be missing.";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, plugin);
            throw new TypeError(errorMsg);
        }
        this.plugin = plugin;
        this.debouncedDisplay = debounce(() => {
            try {
                if (this.containerEl?.isShown?.() && document.body.contains(this.containerEl)) {
                    this.display();
                }
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error in debouncedDisplay"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error in debouncedDisplay of settings tab:`, typedError);
            }
        }, DEBOUNCE_SETTINGS_UPDATE_MS, false);
    }

    _addActionButton(settingComponent, icon, tooltip, onClick, isWarning = false, isDisabled = false) {
        if (!settingComponent || typeof settingComponent.addButton !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} _addActionButton: settingComponent is invalid or missing addButton method.`);
            return null;
        }
        if (typeof icon !== 'string' || icon.trim() === "" ||
            typeof tooltip !== 'string' || tooltip.trim() === "" ||
            typeof onClick !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} _addActionButton: Invalid parameters (icon, tooltip, or onClick must be non-empty strings/function).`);
            return null;
        }

        try {
            let buttonComponent = null;
            settingComponent.addButton(button => {
                buttonComponent = button;
                button.setIcon(icon)
                    .setTooltip(tooltip)
                    .setDisabled(!!isDisabled);

                if (!!isWarning) button.setWarning();

                button.onClick(async () => {
                    try {
                        await onClick();
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error for action: ${tooltip}`));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error in action button (tooltip: ${tooltip}):`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Action failed: ${tooltip}. Reason: ${typedError.message}. See console.`, 7000);
                    } finally {
                    }
                });
                button.buttonEl.setAttribute('aria-label', tooltip);
            });
            return buttonComponent;
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error adding action button: ${tooltip}`));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error adding action button (tooltip: ${tooltip}):`, typedError);
            return null;
        }
    }

    _renderLibraryEntry(library, libraryState, parentContainerEl) {
        if (!library || typeof library.id !== 'string' || library.id.trim() === "") {
            console.error(`${PLUGIN_CONSOLE_PREFIX} _renderLibraryEntry: Invalid library data provided. Cannot render. Library:`, library);
            try {
                parentContainerEl.createEl('div', {
                    text: 'Error: Could not render library entry due to invalid or missing library data. Check console for details.',
                    cls: 'scriptpilot-error-message setting-item'
                });
            } catch (uiError) {  }
            return;
        }

        const safeLibraryState = libraryState || this.plugin.libraryStateManager._createDefaultState();

        if (!parentContainerEl || typeof parentContainerEl.createDiv !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} _renderLibraryEntry: parentContainerEl is invalid. Cannot render library "${library.name || library.id}".`);
            return;
        }

        try {
            const libContainer = parentContainerEl.createDiv({ cls: 'scriptpilot-entry setting-item setting-item-collapsible' });
            const libMainRow = libContainer.createDiv({ cls: 'setting-item-info' });

            let typeText = 'Unknown Type';
            if (library.type === 'http') typeText = 'HTTP (Mobile/Capacitor)';
            else if (library.type === 'localFile') typeText = 'Local Vault File';
            else if (library.type === 'http-iframe') typeText = 'HTTP (Iframe/CORS)';

            const nameEl = libMainRow.createEl('div', { cls: 'setting-item-name' });
            const statusIndicator = nameEl.createSpan({ cls: 'scriptpilot-status-indicator' });

            let statusTitle = `Status for library "${library.name || 'Unnamed Library'}" (ID: ${library.id}): `;
            let statusIcon = 'circle-dashed';
            let statusClass = 'scriptpilot-status-unloaded';

            if (safeLibraryState.isLoading) {
                statusIcon = 'loader';
                statusClass = 'scriptpilot-status-loading';
                statusTitle += "Currently loading.";
            } else if (safeLibraryState.isLoaded) {
                statusIcon = 'check-circle';
                statusClass = 'scriptpilot-status-loaded';
                statusTitle += "Loaded and active.";
            } else if (safeLibraryState.lastError) {
                statusIcon = 'x-circle';
                statusClass = 'scriptpilot-status-error';
                const errorMsg = safeLibraryState.lastError instanceof Error ? safeLibraryState.lastError.message : String(safeLibraryState.lastError);
                statusTitle += `Error occurred. Message: ${errorMsg}`;
            } else {
                statusTitle += "Configured but not currently loaded.";
            }
            setIcon(statusIndicator, statusIcon);
            statusIndicator.addClass(statusClass);
            statusIndicator.title = statusTitle;
            statusIndicator.setAttribute('aria-label', statusTitle);

            nameEl.appendText(` ${library.name || `Unnamed Library (ID: ${library.id.substring(0,8)})`} (${typeText || 'N/A'})`);
            if (!library.isEnabled) {
                nameEl.appendText(' [Disabled]');
            }

            const sourceText = (library.type === 'http' || library.type === 'http-iframe')
                ? `URL: ${library.url || "Not set"}`
                : `File: ${library.filePath || "Not set"}`;
            libMainRow.createEl('div', { text: sourceText, cls: 'setting-item-description scriptpilot-source' });

            if (!library.type || library.type.trim() === "") {
                 libMainRow.createEl('div', { text: `Configuration Error: Library type is missing or invalid. Please edit and set a valid type.`, cls: 'setting-item-description scriptpilot-error-message' });
            }
            if (safeLibraryState.lastError) {
                const errorMsg = safeLibraryState.lastError instanceof Error ? safeLibraryState.lastError.message : String(safeLibraryState.lastError);
                const shortErrorMsg = errorMsg.substring(0, 200) + (errorMsg.length > 200 ? '...' : '');
                const errorDiv = libMainRow.createEl('div', { text: `Last Error: ${shortErrorMsg}`, cls: 'setting-item-description scriptpilot-error-message' });
                errorDiv.title = `Full error: ${errorMsg}`;
            }
            if (safeLibraryState.isLoaded && library.globalObjectName && typeof library.globalObjectName === 'string' && library.globalObjectName.trim()) {
                const isPresent = safeLibraryState.globalObjectPresent;
                const globalStatusText = `Global 'window.${library.globalObjectName}' ${isPresent ? 'detected.' : (isPresent === false ? 'NOT detected.' : 'status unknown/not checked.')}`;
                libMainRow.createEl('div', {
                    text: globalStatusText,
                    cls: `setting-item-description scriptpilot-global-status-${isPresent ? 'present' : (isPresent === false ? 'absent' : 'unknown')}`
                });
            }
            if (safeLibraryState.lastLoadedAt && typeof safeLibraryState.lastLoadedAt === 'number') {
                try {
                    libMainRow.createEl('div', {
                        text: `Last loaded: ${new Date(safeLibraryState.lastLoadedAt).toLocaleString()}`,
                        cls: 'setting-item-description scriptpilot-subtle-text'
                    });
                } catch (e) { console.warn(`${PLUGIN_CONSOLE_PREFIX} Error formatting lastLoadedAt date for library ${library.id}:`, e); }
            }

            const controlsEl = libContainer.createDiv({ cls: 'setting-item-control scriptpilot-controls' });
            const settingItem = new Setting(controlsEl);

            this._addActionButton(settingItem,
                safeLibraryState.isLoaded ? 'stop-circle' : 'play',
                safeLibraryState.isLoaded ? `Unload library: "${library.name}"` : `Load library: "${library.name}"`,
                async () => {
                    if (!library.type || library.type.trim() === "" || safeLibraryState.isLoading) {
                        new Notice("Cannot perform action: Library type is invalid, or library is currently busy (loading/unloading).", 4000);
                        return;
                    }
                    if (safeLibraryState.isLoaded) {
                        await this.plugin.libraryController.unloadLibrary(library, true);
                    } else {
                        await this.plugin.libraryController.loadLibrary(library, true);
                    }
                },
                false,
                !library.type || library.type.trim() === "" || !library.id || safeLibraryState.isLoading
            );

            this._addActionButton(settingItem,
                'settings-2',
                `Edit Configuration for library: "${library.name}"`,
                () => {
                    new LibraryEditModal(this.app, this.plugin, library, async (updatedLib) => {
                        const originalIndex = this.plugin.settings.libraries.findIndex(l => l && l.id === library.id);
                        if (originalIndex !== -1) {
                            this.plugin.settings.libraries[originalIndex] = updatedLib;
                            await this.plugin.saveSettings();
                        } else {
                            console.error(`${PLUGIN_CONSOLE_PREFIX} Library ID ${library.id} not found in settings for update. This indicates a state inconsistency.`);
                            new Notice("Error: Could not find library to update. Settings might be out of sync. Please try reloading Obsidian.", 7000);
                        }
                    }).open();
                },
                false,
                safeLibraryState.isLoading
            );

            this._addActionButton(settingItem,
                'trash-2',
                `Remove Configuration for library: "${library.name}"`,
                async () => {
                    const confirmMsg = `Are you sure you want to remove the configuration for "${library.name || 'this library'}"?` +
                                       (safeLibraryState.isLoaded ? " It will be unloaded first." : "");

                    if (!window.confirm(confirmMsg)) return;

                    if (safeLibraryState.isLoaded) {
                        await this.plugin.libraryController.unloadLibrary(library, true);
                    }

                    this.plugin.commandOrchestrator.removeLibrarySpecificCommands(library.id);
                    this.plugin.settings.libraries = this.plugin.settings.libraries.filter(l => l && l.id !== library.id);
                    this.plugin.libraryStateManager.deleteState(library.id);

                    await this.plugin.saveSettings();
                },
                true,
                safeLibraryState.isLoading
            );
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error rendering entry for ${library?.name || library?.id}`));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error rendering library entry for "${library?.name || library?.id}":`, typedError);
            try {
                parentContainerEl.createEl('div', {
                    text: `Error rendering entry for library "${library?.name || library?.id}". Check console. Message: ${typedError.message}`,
                    cls: 'scriptpilot-error-message setting-item'
                });
            } catch (renderErrorE) {
                console.error(`${PLUGIN_CONSOLE_PREFIX} Further error trying to render error message for library entry:`, renderErrorE);
            }
        }
    }

    display() {
        const { containerEl } = this;
        if (!containerEl || typeof containerEl.empty !== 'function' || !document.body.contains(containerEl)) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} Settings tab containerEl is invalid or detached from DOM. Cannot display settings.`);
            return;
        }
        containerEl.empty();

        if (!this.plugin || !this.plugin.settings || !this.plugin.libraryStateManager || !this.plugin.settingsManager) {
            containerEl.createEl('h1', { text: 'ScriptPilot: Critical Error' });
            containerEl.createEl('p', { text: 'Plugin data (settings, state manager, etc.) is not available. Cannot display settings. Please check the developer console for errors and consider reloading Obsidian or reporting the issue if it persists.' });
            console.error(`${PLUGIN_CONSOLE_PREFIX} Cannot display settings: Critical plugin data or components are missing.`);
            return;
        }

        try {
            containerEl.createEl('h1', { text: 'ScriptPilot: JavaScript Library Manager' });
            containerEl.createEl('p').appendText('Load and manage custom JavaScript libraries within Obsidian. Please use this plugin with extreme caution, fully understanding all security implications before loading any script.');

            const generalSettingsSection = containerEl.createDiv({ cls: 'scriptpilot-settings-section' });
            generalSettingsSection.createEl('h2', { text: 'General Settings' });

            new Setting(generalSettingsSection)
                .setName('Load enabled libraries on Obsidian startup')
                .setDesc('If enabled, all libraries marked as "Enabled" in their configuration will attempt to load when Obsidian starts up and the workspace is ready.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.loadEnabledOnStartup)
                    .onChange(async (value) => {
                        this.plugin.settings.loadEnabledOnStartup = !!value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(generalSettingsSection)
                .setName('Show status bar item')
                .setDesc('Displays an icon and status information (e.g., number of active libraries) in the Obsidian status bar.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showStatusBar)
                    .onChange(async (value) => {
                        this.plugin.settings.showStatusBar = !!value;
                        await this.plugin.saveSettings();
                    }));

            const securitySection = containerEl.createDiv({ cls: 'scriptpilot-settings-section' });
            securitySection.createEl('h2', { text: '⚠️ Security & Stability Considerations' });
            const warningEl = securitySection.createDiv({ cls: 'callout', attr: {'data-callout': 'error', 'data-callout-fold': ''} });

            const warningHeader = warningEl.createDiv({ cls: 'callout-title' });
            const warningIconSpan = warningHeader.createSpan({ cls: 'callout-icon' });
            setIcon(warningIconSpan, 'alert-octagon');
            warningHeader.createSpan({ text: ' CRITICAL SECURITY WARNING & USAGE NOTES', cls: 'callout-title-inner' });

            const warningContent = warningEl.createDiv({ cls: 'callout-content' });
            warningContent.createEl('p', { html: '<strong>Executing external or local JavaScript code via this plugin carries significant risks:</strong>' });
            const riskList = warningContent.createEl('ul');
            riskList.createEl('li', {text: 'Malicious scripts can access your notes, files, system clipboard, make network requests, and potentially compromise your entire system.'});
            riskList.createEl('li', {text: 'Poorly written or incompatible scripts can cause Obsidian to freeze, crash, lose data, or behave unexpectedly.'});
            riskList.createEl('li', {text: 'Only load scripts from sources you absolutely trust and whose code you (or a trusted party) have reviewed and understand.'});
            riskList.createEl('li', {text: 'Be aware that "unloading" a script might not fully reverse all its effects or clean up all resources it consumed (e.g., global event listeners, modified global objects, timers). A full restart of Obsidian is the most reliable way to ensure a clean state after experimenting with problematic scripts.'});
            riskList.createEl('li', {text: 'This plugin provides mechanisms like sandboxed iframes for some loading strategies, but these are not foolproof and depend on browser security features.'});
            warningContent.createEl('p', { html: '<strong>You are solely responsible for the scripts you choose to load. Use this plugin at your own risk! Backup your vault regularly.</strong>' });

            const configuredLibrariesSection = containerEl.createDiv({ cls: 'scriptpilot-settings-section' });
            configuredLibrariesSection.createEl('h2', { text: 'Configured Libraries' });

            const libraries = this.plugin.settings.libraries;
            if (!Array.isArray(libraries) || libraries.length === 0) {
                configuredLibrariesSection.createEl('p', { text: 'No libraries configured yet. Click "Add New Library" below to get started.' });
            } else {
                [...libraries]
                    .sort((a,b) => (typeof a?.loadOrder === 'number' ? a.loadOrder : 0) - (typeof b?.loadOrder === 'number' ? b.loadOrder : 0))
                    .forEach((library) => {
                        if (library && typeof library.id === 'string' && library.id.trim() !== "") {
                            const libraryState = this.plugin.libraryStateManager.getState(library.id);
                            this._renderLibraryEntry(library, libraryState, configuredLibrariesSection);
                        } else {
                            console.warn(`${PLUGIN_CONSOLE_PREFIX} Found invalid library entry in settings during display (missing/invalid ID), skipping render:`, library);
                            configuredLibrariesSection.createEl('div', {
                                text: `Skipping an invalid library entry (missing or invalid ID). Check console for details. Entry data (partial): ${JSON.stringify(library).substring(0,100)}...`,
                                cls: 'scriptpilot-error-message setting-item'
                            });
                        }
                });
            }

            new Setting(configuredLibrariesSection)
                .addButton(button => button
                    .setButtonText('Add New Library')
                    .setCta()
                    .onClick(() => {
                        try {
                            const newLibDefaults = {
                                id: Utils.generateUniqueId(),
                                type: 'localFile',
                                name: `New Library ${this.plugin.settings.libraries?.length ? this.plugin.settings.libraries.length + 1 : 1}`,
                                isEnabled: false,
                                loadOrder: (this.plugin.settings.libraries?.length || 0) * 10,
                                url: '', filePath: '', initializationScript: '', destructionScript: '', globalObjectName: ''
                            };
                            new LibraryEditModal(this.app, this.plugin, newLibDefaults, async (createdLib) => {
                                if (!Array.isArray(this.plugin.settings.libraries)) {
                                    this.plugin.settings.libraries = [];
                                }
                                this.plugin.settings.libraries.push(createdLib);
                                this.plugin.libraryStateManager._ensureState(createdLib.id);
                                await this.plugin.saveSettings();
                            }).open();
                        } catch (e) {
                            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error opening Add New Library modal"));
                            console.error(`${PLUGIN_CONSOLE_PREFIX} Error opening Add New Library modal:`, typedError);
                            new Notice(`Error preparing to add new library: ${typedError.message}. See console.`, 7000);
                        }
                    }));

            const realtimeStatusSection = containerEl.createDiv({ cls: 'scriptpilot-settings-section' });
            realtimeStatusSection.createEl('h2', { text: 'Real-time Status Monitoring (Experimental)' });
            new Setting(realtimeStatusSection)
                .setName('Enable real-time status panel in settings tab')
                .setDesc('Shows live status of libraries directly below (refreshes this settings tab periodically). This may impact performance slightly on very complex vaults or with extremely frequent updates. Disable if you notice slowdowns.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.showRealtimeStatusPanel)
                    .onChange(async (value) => {
                        this.plugin.settings.showRealtimeStatusPanel = !!value;
                        await this.plugin.saveSettings();
                    }));

            if (this.plugin.settings.showRealtimeStatusPanel) {
                new Setting(realtimeStatusSection)
                    .setName('Status panel update frequency (milliseconds)')
                    .setDesc(`How often the status panel (and this settings tab) updates. Min: ${MIN_REALTIME_UPDATE_FREQUENCY}ms. Default: ${DEFAULT_SETTINGS.realtimePanelUpdateFrequency}ms. Lower values are more 'real-time' but use more resources.`)
                    .addText(text => {
                        text.setValue(String(this.plugin.settings.realtimePanelUpdateFrequency))
                            .setPlaceholder(String(DEFAULT_SETTINGS.realtimePanelUpdateFrequency))
                            .onChange(debounce(async (value) => {
                                let numVal = parseInt(value, 10);
                                let corrected = false;
                                if (isNaN(numVal)) {
                                    numVal = DEFAULT_SETTINGS.realtimePanelUpdateFrequency;
                                    corrected = true;
                                } else if (numVal < MIN_REALTIME_UPDATE_FREQUENCY) {
                                    numVal = MIN_REALTIME_UPDATE_FREQUENCY;
                                    corrected = true;
                                }

                                if (corrected && text.inputEl.value !== String(numVal)) {
                                    text.setValue(String(numVal));
                                }
                                this.plugin.settings.realtimePanelUpdateFrequency = numVal;
                                await this.plugin.saveSettings();
                            }, 500));
                        text.inputEl.type = 'number';
                        text.inputEl.min = String(MIN_REALTIME_UPDATE_FREQUENCY);
                    });

                const statusArea = realtimeStatusSection.createDiv('scriptpilot-realtime-status-panel');
                statusArea.createEl('h3', {text: 'Live Library Status Overview:'});
                const currentLibsForStatus = this.plugin.settings.libraries;
                if (!Array.isArray(currentLibsForStatus) || currentLibsForStatus.length === 0) {
                    statusArea.createEl('p', { text: 'No libraries configured to monitor.' });
                } else {
                    let activeLibsMonitored = 0;
                    currentLibsForStatus.forEach(lib => {
                        if (lib && typeof lib.id === 'string' && lib.id.trim() !== "") {
                            const state = this.plugin.libraryStateManager.getState(lib.id);
                            if (state) {
                                if (state.isLoading || state.isLoaded || state.lastError) {
                                    activeLibsMonitored++;
                                    const libStatusEl = statusArea.createDiv({cls: 'scriptpilot-realtime-item'});
                                    let statusText = `"${lib.name || 'Unnamed Library'}" (ID: ${lib.id.substring(0,5)}): `;
                                    if (state.isLoading) statusText += "Loading...";
                                    else if (state.isLoaded) {
                                        statusText += "Loaded.";
                                        if (lib.globalObjectName && typeof lib.globalObjectName === 'string' && lib.globalObjectName.trim()) {
                                            statusText += ` Global 'window.${lib.globalObjectName}' ${state.globalObjectPresent ? 'detected.' : (state.globalObjectPresent === false ? 'NOT detected.' : 'status unknown.')}`;
                                        }
                                    } else if (state.lastError) {
                                        const errorMsg = state.lastError instanceof Error ? state.lastError.message : String(state.lastError);
                                        statusText += `Error - ${errorMsg.substring(0, 100)}${errorMsg.length > 100 ? '...' : ''}`;
                                        libStatusEl.title = `Full error: ${errorMsg}`;
                                    }
                                    libStatusEl.setText(statusText);
                                }
                            }
                        }
                    });
                    if (activeLibsMonitored === 0 && currentLibsForStatus.length > 0) {
                        statusArea.createEl('p', { text: 'No libraries currently active, loading, or in an error state.' });
                    }
                }
            }
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown critical error displaying settings tab"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} CRITICAL error displaying settings tab:`, typedError);
            containerEl.empty();
            containerEl.createEl('h1', { text: 'ScriptPilot: Error Displaying Settings' });
            containerEl.createEl('p', { text: 'A critical error occurred while rendering the settings tab. This may indicate a problem with the plugin or Obsidian. Please check the developer console (Ctrl+Shift+I or Cmd+Opt+I) for detailed error messages and consider reporting the issue or reloading Obsidian.' });
            const technicalInfo = containerEl.createEl('pre', {cls: 'scriptpilot-error-details'});
            technicalInfo.setText(`Error: ${typedError.message}\n\nStack Trace (if available):\n${typedError.stack || 'Not available'}`);
        }
    }
}

class VaultFileSuggestModal extends SuggestModal {
    constructor(app, onChoose) {
        super(app);
        if (typeof onChoose !== 'function') {
            const errorMsg = "VaultFileSuggestModal: onChoose callback is not a function. File selection will not work.";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            this.onChoose = (path) => {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} VaultFileSuggestModal: onChoose was not properly initialized. Path chosen: ${path}`);
                new Notice("Error: File selection callback not set up correctly. Please report this issue.", 5000);
            };
        } else {
            this.onChoose = onChoose;
        }
        this.setPlaceholder("Search for JavaScript (.js) files in your vault...");

    }

    getSuggestions(query) {
        if (!this.app?.vault?.getFiles || typeof this.app.vault.getFiles !== 'function') {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Vault API (app.vault.getFiles) not available for file suggestions. Returning empty list.`);
            return [];
        }
        try {
            const jsFiles = this.app.vault.getFiles().filter(file => {
                return file && typeof file.path === 'string' &&
                       typeof file.extension === 'string' &&
                       file.extension.toLowerCase() === 'js';
            });

            const lowerCaseQuery = (typeof query === 'string' ? query : "").toLowerCase().trim();
            if (!lowerCaseQuery) {
                return jsFiles.sort((a,b) => a.path.localeCompare(b.path));
            }

            return jsFiles
                .filter(file => file.path.toLowerCase().includes(lowerCaseQuery))
                .sort((a, b) => {
                    const aNameMatch = a.name.toLowerCase().includes(lowerCaseQuery);
                    const bNameMatch = b.name.toLowerCase().includes(lowerCaseQuery);
                    if (aNameMatch && !bNameMatch) return -1;
                    if (!aNameMatch && bNameMatch) return 1;
                    const aPathIndex = a.path.toLowerCase().indexOf(lowerCaseQuery);
                    const bPathIndex = b.path.toLowerCase().indexOf(lowerCaseQuery);
                    if (aPathIndex !== bPathIndex) return aPathIndex - bPathIndex;
                    return a.path.localeCompare(b.path);
                });
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error getting suggestions"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error getting suggestions for .js files:`, typedError);
            return [];
        }
    }

    renderSuggestion(file, el) {
        if (!file || typeof file.name !== 'string' || typeof file.path !== 'string') {
            try { el.createEl("div", { text: "Invalid file data received", cls: "suggestion-item-error" }); } catch (e) {}
            return;
        }
        if (!el || typeof el.createEl !== 'function') {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Invalid element provided to renderSuggestion for file ${file.path}.`);
            return;
        }
        try {
            el.empty();
            el.createEl("div", { text: file.name, cls: "suggestion-item-name scriptpilot-suggestion-name" });
            el.createEl("small", { text: file.path, cls: "suggestion-item-path scriptpilot-suggestion-path setting-item-description" });
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error rendering suggestion"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error rendering suggestion for file ${file.path}:`, typedError);
            try { el.empty(); el.setText("Error rendering this suggestion"); } catch (clearError) {}
        }
    }

    onChooseSuggestion(file, _evt) {
        if (file && typeof file.path === 'string' && file.path.trim() !== "") {
            try {
                this.onChoose(file.path);
            } catch (e) {
                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error in onChooseSuggestion callback"));
                console.error(`${PLUGIN_CONSOLE_PREFIX} Error in onChooseSuggestion callback for path ${file.path}:`, typedError);
                new Notice(`${PLUGIN_CONSOLE_PREFIX} Error processing file selection: ${typedError.message}. See console.`, 7000);
            }
        } else {
            console.warn(`${PLUGIN_CONSOLE_PREFIX} Invalid file chosen or path missing in onChooseSuggestion. File:`, file);
            new Notice("Invalid file selection or missing path. Please try again.", 5000);
        }
    }
}

class LibraryEditModal extends Modal {
    constructor(app, plugin, libraryConfig, onSubmit) {
        super(app);
        if (!(plugin instanceof ScriptPilotPlugin) || !plugin.settings || !plugin.settingsManager) {
            const errorMsg = "LibraryEditModal: Invalid or incomplete plugin instance provided. Essential components missing.";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`, plugin);
            throw new TypeError(errorMsg);
        }
        if (typeof libraryConfig !== 'object' || libraryConfig === null ||
            (typeof libraryConfig.id !== 'string' && !libraryConfig.isNewPlaceholder) ||
            (typeof libraryConfig.id === 'string' && libraryConfig.id.trim() === "" && !libraryConfig.isNewPlaceholder) ) {
            console.error(`${PLUGIN_CONSOLE_PREFIX} LibraryEditModal: Invalid libraryConfig provided. Config:`, libraryConfig);
            this.isInvalidConfig = true;
            libraryConfig = { id: Utils.generateUniqueId(), name: "Error - Invalid Configuration Loaded", type: "localFile", isEnabled: false, loadOrder:0, url:'', filePath:'', initializationScript:'', destructionScript:'', globalObjectName:'' };
        } else {
            this.isInvalidConfig = false;
        }
        delete libraryConfig.isNewPlaceholder;

        if (typeof onSubmit !== 'function') {
            const errorMsg = "LibraryEditModal: onSubmit callback is not a function. Modal submission will not work.";
            console.error(`${PLUGIN_CONSOLE_PREFIX} ${errorMsg}`);
            this.onSubmit = async (lib) => {
                console.error(`${PLUGIN_CONSOLE_PREFIX} LibraryEditModal: onSubmit was not properly initialized. Submitted library:`, lib);
                new Notice("Error: Modal submission handler not set up correctly. Please report this issue.", 7000);
            };
        } else {
            this.onSubmit = onSubmit;
        }

        this.plugin = plugin;
        try {
            this.library = JSON.parse(JSON.stringify(libraryConfig));
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error cloning libraryConfig"));
            console.error(`${PLUGIN_CONSOLE_PREFIX} LibraryEditModal: Failed to clone libraryConfig. Using original (may lead to direct modification of settings object before save, which is risky). Error:`, typedError);
            this.library = libraryConfig;
            this.isInvalidConfig = true;
        }

        const defaultsForModal = {
            id: Utils.generateUniqueId(),
            name: `Library ${this.library.id?.substring(0,5) || 'New'}`,
            type: 'localFile',
            isEnabled: false,
            loadOrder: 0,
            url: '',
            filePath: '',
            initializationScript: '',
            destructionScript: '',
            globalObjectName: ''
        };
        for (const key in defaultsForModal) {
            if (typeof this.library[key] === 'undefined' ||
                (typeof defaultsForModal[key] === 'string' && typeof this.library[key] !== 'string') ||
                (typeof defaultsForModal[key] === 'number' && (typeof this.library[key] !== 'number' || isNaN(this.library[key]))) ||
                (typeof defaultsForModal[key] === 'boolean' && typeof this.library[key] !== 'boolean')
            ) {
                if (!this.isInvalidConfig) {
                }
                this.library[key] = defaultsForModal[key];
            }
        }
        if (isNaN(this.library.loadOrder)) this.library.loadOrder = 0;

        this.isNew = !this.plugin.settings?.libraries?.some(l => l && typeof l.id === 'string' && l.id === this.library.id);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText(this.isNew ? 'Add New Library Configuration' : `Edit Library Configuration: ${this.library.name || 'Unnamed'}`);

        if (this.isInvalidConfig) {
            contentEl.createEl('h3', {text: 'Error: Library Configuration Problem', cls: 'scriptpilot-error-message'});
            contentEl.createEl('p', {text: 'There was an issue loading or processing the library configuration for this modal. Editing may not work as expected or may lead to further errors. Please check the console for details and consider recreating this library entry if issues persist.'});
            new Setting(contentEl).addButton(btn => btn.setButtonText("Close").onClick(() => this.close()));
            return;
        }

        const securityWarning = contentEl.createDiv({ cls: 'scriptpilot-modal-security-warning callout', attr: {'data-callout': 'warning'} });
        const warningTitle = securityWarning.createDiv({cls: 'callout-title'});
        setIcon(warningTitle.createSpan({cls: 'callout-icon'}), 'alert-triangle');
        warningTitle.createSpan({cls: 'callout-title-inner', text: ' Important Security Reminder'});
        const warningContent = securityWarning.createDiv({cls: 'callout-content'});
        warningContent.createEl('p', { text: 'Remember: Loading and executing JavaScript, especially from external URLs or unfamiliar local files, carries significant security risks. Only use scripts from sources you absolutely trust and whose functionality you understand.' });


        new Setting(contentEl)
            .setName('Library Type')
            .setDesc('Choose how the library will be loaded. This affects which source (URL or File Path) is used.')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('localFile', 'Local Vault File (.js)')
                    .addOption('http-iframe', 'HTTP(S) URL (via Iframe, requires CORS from server)')
                    .addOption('http', 'HTTP(S) URL (via CapacitorHttp, primarily for Mobile, experimental)')
                    .setValue(this.library.type)
                    .onChange(value => {
                        const validTypes = ['localFile', 'http-iframe', 'http'];
                        if (validTypes.includes(value)) {
                            this.library.type = value;
                        } else {
                            this.library.type = 'localFile';
                            dropdown.setValue('localFile');
                            console.warn(`${PLUGIN_CONSOLE_PREFIX} Invalid library type selected in modal: ${value}. Defaulting to 'localFile'.`);
                            new Notice("Invalid library type selected, defaulted to Local File.", 4000);
                        }
                        this.renderTypeSpecificSettings(typeSpecificSettingsContainer);
                    });
            });

        const typeSpecificSettingsContainer = contentEl.createDiv();
        this.renderTypeSpecificSettings(typeSpecificSettingsContainer);

        new Setting(contentEl)
            .setName('Library Name')
            .setDesc('A descriptive name for this library (e.g., "My Custom Utilities", "Chart.js Library").')
            .addText(text => text
                .setValue(this.library.name)
                .setPlaceholder('e.g., My Custom Utilities')
                .onChange(value => this.library.name = (value || "").trim()));

        new Setting(contentEl)
            .setName('Initialization Script (Optional)')
            .setDesc('JavaScript code to run immediately after this library is successfully loaded. Use "this" or "window" for global scope. Async functions (await) are allowed.')
            .addTextArea(text => {
                text.setValue(this.library.initializationScript)
                    .setPlaceholder('// Example: window.myLibrary.initialize({ option: true });\n// console.log("MyLibrary initialized!");')
                    .onChange(value => this.library.initializationScript = value || '');
                text.inputEl.rows = 4;
                text.inputEl.classList.add('scriptpilot-code-input');
            });

        new Setting(contentEl)
            .setName('Destruction Script (Optional)')
            .setDesc('JavaScript code to run just before this library is unloaded (e.g., for cleanup). Use "this" or "window" for global scope. Async functions (await) are allowed.')
            .addTextArea(text => {
                text.setValue(this.library.destructionScript)
                    .setPlaceholder('// Example: window.myLibrary.destroy();\n// delete window.myLibrary;')
                    .onChange(value => this.library.destructionScript = value || '');
                text.inputEl.rows = 4;
                text.inputEl.classList.add('scriptpilot-code-input');
            });

        new Setting(contentEl)
            .setName('Global Object Name (Optional)')
            .setDesc('The name of the main object or function this library exposes on the `window` object (e.g., "jQuery", "moment", "MyLib"). Used for status checks in the settings tab.')
            .addText(text => text
                .setValue(this.library.globalObjectName)
                .setPlaceholder('e.g., MyLibObject or $')
                .onChange(value => this.library.globalObjectName = (value || "").trim()));

        new Setting(contentEl)
            .setName('Enabled')
            .setDesc('If checked, this library can be loaded (either on startup if globally enabled, or manually via commands/UI). If unchecked, it will be ignored.')
            .addToggle(toggle => toggle
                .setValue(this.library.isEnabled)
                .onChange(value => this.library.isEnabled = !!value));

        new Setting(contentEl)
            .setName('Load Order')
            .setDesc('A number that determines loading sequence. Libraries with lower numbers load first during "Load All" operations or startup. Can be negative.')
            .addText(text => {
                text.setValue(String(this.library.loadOrder))
                    .onChange(value => {
                        const num = parseInt(value, 10);
                        this.library.loadOrder = (isNaN(num) ? 0 : num);
                        if (isNaN(num) && text.inputEl.value !== "0" && text.inputEl.value.trim() !== "") text.setValue("0");
                    });
                text.inputEl.type = "number";
            });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        new Setting(buttonContainer)
            .addButton(button => button
                .setButtonText(this.isNew ? 'Add Library' : 'Save Changes')
                .setCta()
                .onClick(async () => {
                    if (!this.library.name?.trim()) {
                        new Notice("Library Name cannot be empty.", 4000);
                        return;
                    }
                    if ((this.library.type === 'http' || this.library.type === 'http-iframe') && !this.library.url?.trim()) {
                        new Notice("Library URL cannot be empty for HTTP-based library types.", 4000);
                        return;
                    }
                    if (this.library.type === 'localFile' && !this.library.filePath?.trim()) {
                        new Notice("File Path cannot be empty for Local File library type.", 4000);
                        return;
                    }
                    if ((this.library.type === 'http' || this.library.type === 'http-iframe') && this.library.url?.trim()) {
                        try {
                            new URL(this.library.url);
                        } catch (_) {
                            new Notice("Invalid URL format. Please enter a full, valid HTTP(S) URL.", 4000);
                            return;
                        }
                    }
                    if (this.library.type === 'localFile' && this.library.filePath?.trim() && !this.library.filePath.toLowerCase().endsWith('.js')) {
                         if (!window.confirm(`The file path "${this.library.filePath}" does not end with .js. Are you sure it's a JavaScript file? Proceed anyway?`)) {
                            return;
                         }
                    }


                    try {
                        button.setDisabled(true);
                        await this.onSubmit(this.library);
                        this.close();
                    } catch (e) {
                        const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error saving library configuration"));
                        console.error(`${PLUGIN_CONSOLE_PREFIX} Error during LibraryEditModal onSubmit callback:`, typedError);
                        new Notice(`${PLUGIN_CONSOLE_PREFIX} Failed to save library: ${typedError.message}. See console.`, 7000);
                        button.setDisabled(false);
                    }
                }))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }));
    }

    renderTypeSpecificSettings(containerEl) {
        if (!containerEl || typeof containerEl.empty !== 'function') {
            console.error(`${PLUGIN_CONSOLE_PREFIX} LibraryEditModal: Invalid containerEl provided for type-specific settings. Cannot render.`);
            return;
        }
        containerEl.empty();

        try {
            if (this.library.type === 'http' || this.library.type === 'http-iframe') {
                new Setting(containerEl)
                    .setName('Library URL')
                    .setDesc(`The full HTTP(S) URL of the JavaScript file. ${this.library.type === 'http-iframe' ? 'Ensure the server hosting this URL is configured to allow Cross-Origin Resource Sharing (CORS) for your Obsidian domain or for all (*).' : 'For mobile, CapacitorHttp attempts to bypass some CORS issues but server policies still apply.'}`)
                    .addText(text => {
                        text.setValue(this.library.url)
                            .setPlaceholder('https://example.com/path/to/library.js')
                            .onChange(value => this.library.url = (value || "").trim());
                        text.inputEl.type = "url";
                        text.inputEl.style.width = "100%";
                        text.inputEl.required = true;
                    });
            } else if (this.library.type === 'localFile') {
                let filePathTextComponentRef;
                new Setting(containerEl)
                    .setName('File Path in Vault')
                    .setDesc('Path to the .js file within your Obsidian vault (e.g., "scripts/myLib.js" or "assets/js/another.js"). Relative to vault root.')
                    .addText(text => {
                        filePathTextComponentRef = text;
                        text.setValue(this.library.filePath)
                            .setPlaceholder('path/to/your/script.js')
                            .onChange(value => this.library.filePath = (value || "").trim());
                        text.inputEl.style.width = "calc(100% - 125px)";
                        text.inputEl.required = true;
                    })
                    .addButton(button => button
                        .setButtonText('Browse Vault')
                        .setTooltip('Search for .js files in your vault to select path')
                        .onClick(() => {
                            try {
                                new VaultFileSuggestModal(this.app, (path) => {
                                    this.library.filePath = path;
                                    if (filePathTextComponentRef && typeof filePathTextComponentRef.setValue === 'function') {
                                        filePathTextComponentRef.setValue(path);
                                    } else {
                                        console.warn(`${PLUGIN_CONSOLE_PREFIX} filePathTextComponentRef lost in LibraryEditModal. Re-rendering type-specific settings.`);
                                        this.renderTypeSpecificSettings(containerEl);
                                    }
                                }).open();
                            } catch (e) {
                                const typedError = e instanceof Error ? e : new Error(String(e || "Unknown error opening VaultFileSuggestModal"));
                                console.error(`${PLUGIN_CONSOLE_PREFIX} Error opening VaultFileSuggestModal:`, typedError);
                                new Notice(`Could not open file browser: ${typedError.message}. See console.`, 7000);
                            }
                        }));
            } else {
                containerEl.createEl('p', {text: `Unknown or unsupported library type: "${this.library.type}". Please select a valid type from the dropdown.`, cls: 'scriptpilot-error-message'});
            }
        } catch (e) {
            const typedError = e instanceof Error ? e : new Error(String(e || `Unknown error rendering type-specific settings for ${this.library.type}`));
            console.error(`${PLUGIN_CONSOLE_PREFIX} Error rendering type-specific settings for type ${this.library.type}:`, typedError);
            containerEl.empty();
            containerEl.createEl('p', {text: `Error rendering settings for type "${this.library.type}". Check console. Message: ${typedError.message}`, cls: 'scriptpilot-error-message'});
        }
    }

    onClose() {
        if (this.contentEl && typeof this.contentEl.empty === 'function') {
            try {
                this.contentEl.empty();
            } catch (e) {
                console.warn(`${PLUGIN_CONSOLE_PREFIX} Minor error emptying contentEl on modal close:`, e);
            }
        }
    }
}

module.exports = ScriptPilotPlugin;