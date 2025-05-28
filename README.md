# ScriptPilot for Obsidian

**Navigate and Execute Your JavaScript Universe in Obsidian**

ScriptPilot is an Obsidian plugin designed to empower users by enabling the loading and management of custom JavaScript libraries and scripts directly within Obsidian. Whether you want to integrate a third-party utility, run your own custom code, or experiment with web technologies inside your vault, ScriptPilot provides the tools to do so.

**Current Status:** This plugin is provided as-is. It is fully open-source, and community contributions or audits are welcome. However, please note that future updates or active maintenance by the original author are not guaranteed.

---

## 🚨 CRITICAL SECURITY WARNING: PLEASE READ BEFORE USE 🚨

**Executing arbitrary JavaScript code, which is the core functionality of this plugin, carries significant risks.**

*   **High Risk of Harm:** Malicious scripts loaded through this plugin can:
    *   Access, modify, or delete your vault data.
    *   Compromise your notes and personal information.
    *   Potentially access information on your computer (depending on script capabilities and the underlying Electron/browser environment).
    *   Cause Obsidian to become unstable or unusable.
*   **Trust Is Paramount:**
    *   **ONLY load scripts from sources you absolutely trust.**
    *   **If you are unsure about a script's origin or its contents, DO NOT LOAD IT.**
    *   Carefully verify all URLs and file paths before adding them.
*   **No Additional Sandbox:** Scripts loaded by ScriptPilot execute with the same permissions as Obsidian itself and other plugins. They are NOT sandboxed beyond the standard security measures of the web environment (browser/Electron).
*   **Initialization & Destruction Scripts:** These user-provided scripts also run with full permissions and must be treated with the same level of caution as the main library code.
*   **Full Cleanup May Require Restart:** For complex libraries that deeply modify Obsidian's state, the DOM, or global JavaScript objects (`window`), simply "unloading" them via ScriptPilot might not revert all changes. **Restarting Obsidian is the most reliable method for a complete reset** after experimenting with such libraries.

**By using this plugin, you acknowledge and accept these risks.** The developers of ScriptPilot are not responsible for any data loss, security breaches, or other issues that may arise from its use.

---

## Features

ScriptPilot offers a range of features to manage your JavaScript libraries:

*   **Multiple Loading Sources:**
    *   **Local Vault Files:** Load `.js` files directly from your Obsidian vault.
    *   **HTTP(S) URLs (via Iframe):** Load scripts from remote URLs. This method works on both Desktop and Mobile but is subject to Cross-Origin Resource Sharing (CORS) policies set by the script's server.
    *   **HTTP(S) URLs (via Capacitor - Mobile Focused):** Load scripts from remote URLs using native HTTP requests on Obsidian Mobile (if CapacitorHttp is available). This method can often bypass CORS issues encountered by the Iframe method on mobile.
*   **Lifecycle Scripts:**
    *   **Initialization Script:** Define custom JavaScript to run immediately after a library is successfully loaded and injected. Perfect for setup, configuration, or calling a library's entry point.
    *   **Destruction Script:** Define custom JavaScript to run when a library is unloaded. Essential for cleaning up resources, removing event listeners, or resetting state.
*   **Load Order Management:** Control the sequence in which libraries are loaded, crucial for managing dependencies (e.g., load a utility library before a script that depends on it).
*   **Enable/Disable Libraries:** Easily toggle whether a configured library should be loaded (e.g., during startup or "Load All" actions) without deleting its configuration.
*   **Global Object Name Tracking:** Specify the global object name a library is expected to expose (e.g., `jQuery`, `moment`). ScriptPilot uses this for:
    *   Status checking in the settings tab (detecting if the object is present on `window`).
    *   Attempting to `delete window.YourObjectName` during unload (best-effort cleanup).
*   **User-Friendly Interface:**
    *   **Settings Tab:** A dedicated settings panel to add, edit, remove, and manage all your script libraries.
    *   **Status Bar Item:** An optional icon in the Obsidian status bar providing a quick overview of how many libraries are active or currently loading.
    *   **Ribbon Icon:** Quick access to ScriptPilot settings.
*   **Obsidian Commands:**
    *   Load all enabled libraries.
    *   Unload all currently loaded libraries.
    *   Open ScriptPilot settings.
    *   Load, unload, or toggle individual libraries.
*   **Real-time Status Panel (Advanced):** An optional section in the settings tab that, when open, periodically checks and displays the live status of loaded libraries (e.g., global object presence). Useful for diagnostics.

---

## Installation

### Manual Installation (Recommended for now)

Since ScriptPilot is not yet in the official Obsidian community plugins list, you'll need to install it manually:

1.  Go to the [Releases page](https://github.com/Yuichi-Aragi/ScriptPilot/releases) of this repository.
2.  Download `main.js` and `manifest.json` from the latest release.
3.  In your Obsidian vault, navigate to the `.obsidian/plugins/` directory. If it doesn't exist, create it.
4.  Create a new folder named `scriptpilot` inside `.obsidian/plugins/`.
5.  Place the downloaded `main.js` and `manifest.json` files into the `scriptpilot` folder.
6.  Restart Obsidian or reload plugins by going to `Settings` > `Community Plugins` and toggling "Restricted Mode" off and on (if it was on), or simply by closing and reopening the settings window.
7.  Go to `Settings` > `Community Plugins`, find "ScriptPilot" in the list, and enable it.

### Via Community Plugins (Future)

If ScriptPilot is accepted into the official Obsidian community plugins list, you will be able to install it directly from Obsidian:

1.  Go to `Settings` > `Community Plugins`.
2.  Ensure "Restricted Mode" is **OFF**.
3.  Click `Browse` and search for "ScriptPilot".
4.  Click `Install` and then `Enable`.

---

## How to Use ScriptPilot

### Accessing ScriptPilot Settings

You can open the ScriptPilot settings panel in a few ways:

*   Click the **ScriptPilot ribbon icon** in the left sidebar. This icon typically resembles a code symbol.
*   Use the Obsidian Command Palette (Ctrl/Cmd + P) and search for `ScriptPilot: Open Settings`.

The settings tab is your central hub for managing libraries.

### General Settings

At the top of the ScriptPilot settings tab, you'll find general plugin settings:

*   **Load enabled libraries on Obsidian startup:** If checked, any library marked as "Enabled" in its configuration will automatically load when Obsidian starts.
*   **Show status bar item:** Toggles the display of the ScriptPilot icon in the Obsidian status bar. This icon shows the number of active/loading libraries.

### Managing Libraries

This is where you configure individual JavaScript libraries.

#### Adding a New Library

1.  Click the `Add New Library` button. This will open the "Add New Script Library" modal.
2.  Fill in the library details:

    *   **Library Type:** Choose how the library will be loaded.
        *   `Local Vault File (.js)`: For scripts stored within your Obsidian vault.
            *   **Library File Path:** Enter the path relative to your vault root (e.g., `scripts/my-lib.js`). Must end with `.js`. Use the `Browse...` button to search for `.js` files in your vault.
        *   `HTTP(S) URL (via Iframe - Desktop/Mobile, CORS dependent)`: For scripts hosted online.
            *   **Library URL:** Enter the full URL (e.g., `https://cdn.jsdelivr.net/npm/example-lib/dist/example-lib.min.js`). This method is subject to CORS policies. If it fails, check the developer console (Ctrl+Shift+I or Cmd+Opt+I) for errors.
        *   `HTTP(S) URL (via Capacitor - Mobile Only, Native HTTP)`: Also for scripts hosted online, but primarily for Obsidian Mobile.
            *   **Library URL:** Same as above. This method uses native HTTP requests and can bypass some CORS issues on mobile, but relies on Obsidian's mobile infrastructure (CapacitorHttp).
    *   **Library Name:** A descriptive name for this library (e.g., "My Charting Tool", "Eruda Debug Console").
    *   **Initialization Script (Optional):** JavaScript code to run *after* the main library script is loaded. Useful for:
        *   Calling an initialization function within the loaded library.
        *   Configuring the library.
        *   Logging success messages.
        *   Example: `if (window.myLib) { window.myLib.init({ option: true }); }`
    *   **Destruction Script (Optional):** JavaScript code to run *before* the library is unloaded. Crucial for:
        *   Cleaning up resources (e.g., removing DOM elements, event listeners).
        *   Calling a library's destroy function.
        *   Example: `if (window.myLib && window.myLib.destroy) { window.myLib.destroy(); } delete window.myLib;`
    *   **Global Object Name (Optional):** If the library exposes a main object on the `window` (e.g., `jQuery`, `moment`, `MyNamespace.MyUtil`), enter its name here.
        *   ScriptPilot uses this to check if the library loaded successfully (by seeing if `window.YourObjectName` exists).
        *   It will also attempt to `delete window.YourObjectName` during unload if the property is configurable. A good destruction script is more reliable for cleanup.
    *   **Enabled for Loading:** Check this if you want this library to be loaded automatically on startup (if general startup loading is enabled) or when using the "Load All Enabled Libraries" command.
    *   **Load Order:** A number (e.g., 10, 20, 100). Libraries with lower numbers load first. Use this to manage dependencies (e.g., a utility library might be `10`, and another library using it could be `20`).

3.  Click `Add Library` to save the configuration.

#### Editing an Existing Library

*   In the "Configured Libraries" list, find the library you want to modify.
*   Click the **Edit icon** (often represented by a gear symbol) next to the library.
*   The "Edit Script Library" modal will appear, pre-filled with the current settings. Make your changes and click `Save Changes`.

#### Loading/Unloading a Library

For each configured library in the list, you'll see control buttons:

*   **Load/Unload Button:**
    *   If the library is unloaded, it shows a **Play icon** (typically a triangle pointing right). Click to load the library.
    *   If the library is loaded, it shows a **Stop icon** (often a square or circle with a square inside). Click to unload the library.
    *   This button is disabled if the library is currently in the process of loading or if its type is not configured.
*   **Status Indicator:** To the left of the library name, an icon indicates its current state:
    *   **Loading:** The library is currently being fetched and injected. This is often represented by a spinning loader icon.
    *   **Loaded:** The library is active. This is typically shown with a checkmark in a circle.
    *   **Error:** An error occurred during the last load/unload attempt. This is usually indicated by an 'X' in a circle. Hover over the icon for details or edit the library to see the full error.
    *   **Unloaded/Inactive:** The library is configured but not currently loaded. This might be represented by a dashed circle or similar inactive state icon.

You can also use Obsidian commands to load/unload libraries (see "Commands" section below).

#### Removing a Library Configuration

*   Click the **Remove icon** (typically a trash can symbol) next to the library you want to remove.
*   You'll be asked for confirmation.
*   If the library is currently loaded, ScriptPilot will attempt to unload it first before removing its configuration.
*   This action deletes the library's entry from ScriptPilot's settings and cannot be undone.

### Real-time Library Status Monitoring (Advanced)

This section in the settings tab is for diagnostic purposes.

*   **Enable Real-time Status Panel:** When this setting is enabled AND the ScriptPilot settings tab is open, the plugin will periodically check the status of loaded libraries. This primarily involves checking if the "Global Object Name" (if specified) is present on `window`.
*   **Status Update Frequency:** Controls how often these checks occur (minimum 500ms). Lower values mean more frequent updates but slightly more CPU usage while the tab is open.

The panel will list active libraries and their status, particularly useful for debugging why a "Global Object Name" might not be detected.

### Status Bar Item

If enabled in General Settings, ScriptPilot adds an item to the Obsidian status bar:

*   **ScriptPilot: Loading X...**: Indicates X libraries are currently loading. This state is often shown with a spinning loader icon.
*   **ScriptPilot: X active**: Indicates X libraries are successfully loaded. This state is typically shown with a checkmark icon.
*   **ScriptPilot: None active**: No libraries are currently loaded. This might be represented by a generic code symbol icon.

### Commands

ScriptPilot registers several commands accessible via the Command Palette (Ctrl/Cmd + P):

*   **Global Commands:**
    *   `ScriptPilot: Load All Enabled Libraries`: Loads all libraries that are marked "Enabled" and have a valid type, respecting their `loadOrder`.
    *   `ScriptPilot: Unload All Loaded Libraries`: Unloads all currently active libraries, in reverse `loadOrder`.
    *   `ScriptPilot: Open Settings`: Opens the ScriptPilot settings tab.
*   **Library-Specific Commands:** For each valid configured library, ScriptPilot adds:
    *   `ScriptPilot: Load (Type) - Library Name`: Loads this specific library.
    *   `ScriptPilot: Unload (Type) - Library Name`: Unloads this specific library.
    *   `ScriptPilot: Toggle Load/Unload (Type) - Library Name`: Toggles the loaded state of this library.
    These commands will only be active (visible/executable) if the action is appropriate (e.g., "Unload" only appears if the library is loaded).

---

## Example: Adding Eruda (Mobile Debugging Console)

Eruda is a console for mobile browsers, extremely useful for debugging on Obsidian Mobile. Here's how to add it using ScriptPilot:

1.  **Open ScriptPilot Settings:** Click the ribbon icon or use the command.
2.  **Add New Library:** Click the `Add New Library` button.
3.  **Configure Eruda:**

    *   **Library Name:** `Eruda Console`
    *   **Library Type:** `HTTP(S) URL (via Iframe)`
        *   *Note: This type is generally good for CDN scripts and works on desktop for testing. If you encounter CORS issues on mobile, you can try `HTTP(S) URL (via Capacitor)` as an alternative for mobile-only use.*
    *   **Library URL:** `https://cdn.jsdelivr.net/npm/eruda/eruda.min.js`
        *   *Always try to use a direct `.js` file URL from a CDN.*
    *   **Initialization Script:**
        ```javascript
        // eruda.min.js often auto-initializes. This script ensures it does.
        if (typeof eruda !== 'undefined' && typeof eruda.init === 'function') {
            eruda.init();
            console.log('ScriptPilot: Eruda initialized.');
        } else {
            console.error('ScriptPilot: Eruda object not found after loading. Cannot initialize.');
        }
        ```
    *   **Destruction Script:**
        ```javascript
        if (typeof eruda !== 'undefined' && typeof eruda.destroy === 'function') {
            eruda.destroy();
            console.log('ScriptPilot: Eruda destroyed.');
        }
        // Attempt to remove the global eruda object
        if (window.hasOwnProperty('eruda')) {
            try {
                delete window.eruda;
            } catch (e) {
                console.warn('ScriptPilot: Could not delete window.eruda, it might be non-configurable.');
            }
        }
        ```
    *   **Global Object Name:** `eruda`
    *   **Enabled for Loading:** Check this box.
    *   **Load Order:** `100` (or any number, as Eruda is usually standalone).

4.  **Save:** Click `Add Library`.
5.  **Load Eruda:**
    *   Find "Eruda Console" in your list of configured libraries.
    *   Click the **Play icon** (the button to load it).
    *   Alternatively, use the command `ScriptPilot: Load (HTTP (Iframe)) - Eruda Console`.

    You should see a floating gear icon appear (usually in the bottom right corner) – this is Eruda! Click it to open the console.

---

## Troubleshooting

*   **Library Fails to Load:**
    *   **Check Developer Console:** On Desktop, press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Opt+I` (macOS) to open the developer console. Look for errors related to network requests (e.g., 404 Not Found), CORS issues (often for `HTTP (Iframe)` type), or JavaScript errors from the script itself.
    *   **Verify Source:** Double-check the URL or File Path in ScriptPilot settings.
    *   **ScriptPilot Error Message:** In the ScriptPilot settings tab, hover over the error icon (an 'X' in a circle) next to the library or edit the library to see the "Last Error" message.
    *   **CORS Issues (for HTTP Iframe):** If you see CORS errors, the server hosting the script does not permit it to be loaded from Obsidian's origin. You might need to find an alternative source or use the `HTTP (Capacitor)` type if on mobile (though this is not a universal CORS bypass).
    *   **CapacitorHttp Not Available (for HTTP Capacitor):** This type relies on Obsidian Mobile's infrastructure. If it fails, ensure you are on a mobile device and that this mechanism is functional in your Obsidian version.
*   **Global Object Not Detected:**
    *   **Spelling:** Ensure the "Global Object Name" in settings exactly matches how the library exposes itself on `window`.
    *   **Async Loading:** The library might load or initialize its global object asynchronously. The check is performed shortly after the script tag is injected and the init script runs.
    *   **Initialization Script:** Your initialization script might be necessary to properly set up or expose the global object.
*   **Plugin Not Working / Commands Missing:**
    *   Ensure ScriptPilot is enabled in `Settings` > `Community Plugins`.
    *   Check the Obsidian developer console (`Ctrl+Shift+I` or `Cmd+Opt+I`) for any errors logged by `[ScriptPilot]`.
*   **Unload Doesn't Fully Clean Up / Obsidian Behaves Strangely:**
    *   **Destruction Script:** The most common reason is an inadequate or missing "Destruction Script". Libraries can add global event listeners, modify the DOM extensively, or alter global state. A good destruction script is vital to reverse these changes.
    *   **Restart Obsidian:** As stated in the security warning, for complex libraries, restarting Obsidian is the most reliable way to ensure a complete cleanup.

---

## For Developers / Contributing

ScriptPilot is an open-source project. Contributions, bug reports, and feature suggestions are welcome!

*   **Issues:** Please report bugs or suggest features via the GitHub Issues tab.
*   **Pull Requests:** If you'd like to contribute code, please feel free to open a Pull Request.

While contributions are encouraged, please understand that active maintenance or prompt responses from the original author may be limited.

---

## Disclaimer & Future of the Plugin

This plugin is provided "as-is", without any warranty, express or implied. The authors and contributors are not liable for any claim, damages, or other liability arising from the use of this software.

**Use ScriptPilot at your own risk.** Be especially cautious when loading and executing external JavaScript code.

The future development and maintenance of this plugin by the original author are not guaranteed. It is released to the Obsidian community in the hope that it may be useful to others or serve as a foundation for further development.

---

## License

This plugin is licensed under the [MIT License](LICENSE.md).
