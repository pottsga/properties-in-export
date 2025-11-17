import { App, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { DateTime } from 'luxon';

interface PluginSettings {
	displayProperties: boolean;
	dateFormat: string;
	excludedProperties: string;
	addPropertiesBlockAfterHeading: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	displayProperties: true,
	dateFormat: 'yyyy-MM-dd',
	excludedProperties: '',
	addPropertiesBlockAfterHeading: false,
}

export default class MyPlugin extends Plugin {
	settings: PluginSettings;
	// Track currently opened file so we can read its frontmatter when printing
	currentFile: TFile | null = null;
	// Keep a reference to the original print command callback so we can restore it
	private originalPrintCallback: ((...args: unknown[]) => unknown) | null = null;
	private isPrintPatched = false;

	// Backup of file contents when we perform temporary file edits for export
	private fileBackups: Record<string, string> = {};

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		// Track the active file when files are opened
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			this.currentFile = file;
		}));

		// Inject properties block at the top of the document during export (PDF)
		this.registerMarkdownPostProcessor((element, context) => {
			// Only render if element is <div class="markdown-preview-view markdown-rendered show-properties">
			if (!(
				element.classList.contains('markdown-preview-view') &&
				element.classList.contains('show-properties')
			)) {
				return;
			}
			if (!this.settings.displayProperties) return;

			const file = this.currentFile ?? this.app.workspace.getActiveFile();
			if (!file) return;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache || !cache.frontmatter) return;
			const excluded = this.settings.excludedProperties.split(',').map(s => s.trim()).filter(Boolean);
			const rows = Object.entries(cache.frontmatter)
				.filter(([key]) => key !== 'tags' && !excluded.includes(key))
				.map(([key, value]) => {
					const displayValue = (value === null || value === undefined) ? '' : value;
					return `<tr><td style="border:1px solid #000;padding:4px 8px;"><strong>${this.escapeHtml(key)}</strong></td><td style="border:1px solid #000;padding:4px 8px;">${this.valueToHtml(displayValue)}</td></tr>`;
				})
				.join('');
			if (!rows) return;
			const table = `<table style="border-collapse:collapse;margin-bottom:1em;"><tbody>${rows}</tbody></table>`;
			const block = document.createElement('div');
			block.className = 'export-properties-block';
			block.innerHTML = table;
			const contentContainer = element.querySelector('.cm-contentContainer');
			
			if (this.settings.addPropertiesBlockAfterHeading) {
				// Find the first heading (h1..h6) within the rendered element (prefer inside contentContainer)
				const searchRoot = contentContainer ?? element;
				const firstHeading = searchRoot.querySelector('h1,h2,h3,h4,h5,h6');
				if (firstHeading && firstHeading.parentNode) {
					// Insert the block immediately after the heading
					firstHeading.parentNode.insertBefore(block, firstHeading.nextSibling);
					return;
				}
			}
			// Fallback: insert at top (before content container if present, otherwise as first child)
			if (contentContainer) {
				element.insertBefore(block, contentContainer);
			} else {
				element.insertBefore(block, element.firstChild);
			}
		});

		// Also set current file immediately if one is active on load
		this.currentFile = this.app.workspace.getActiveFile();

	}

	onunload() {
		// Restore original print command callback if we patched it
		try {
			const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands?.commands as Record<string, unknown> | undefined;
			const printCommand = cmds ? (cmds['editor:print'] as unknown as { callback?: (...args: unknown[]) => unknown }) : undefined;
			if (printCommand && this.isPrintPatched) {
				if (this.originalPrintCallback) {
					printCommand.callback = this.originalPrintCallback as (...a: unknown[]) => unknown;
				}
			}
		} catch (e) {
			console.error('Failed to restore print command on unload', e);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Helper to escape HTML
	escapeHtml(str: string): string {
		return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\'': '&#39;', '"': '&quot;' }[tag] || tag));
	}

	// Helper to format property values
	valueToHtml(val: unknown): string {
		// Format arrays
		if (Array.isArray(val)) return val.map(v => this.valueToHtml(v)).join(', ');
		// Format date values using Luxon if possible
		if (this.isDateValue(val)) {
			try {
				const dt = DateTime.fromISO(String(val));
				if (dt.isValid) {
					return this.escapeHtml(dt.toFormat(this.settings.dateFormat));
				}
			} catch (e) {
				console.error('Failed to parse date value:', e);
			}
		}
		// Format objects
		if (typeof val === 'object' && val !== null) return this.escapeHtml(JSON.stringify(val));
		// Format string with wikilinks
		let str = String(val);
		str = str.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (match, link, pipe, display) => {
			const text = display ? display : link;
			return `<a href="#${this.escapeHtml(link)}" class="internal-link">${this.escapeHtml(text)}</a>`;
		});
		return str.split(/(<a [^>]+>[^<]*<\/a>)/g)
			.map(part => part.startsWith('<a ') ? part : this.escapeHtml(part))
			.join('');
	}
	isDateValue(val: unknown): boolean {
		if (typeof val !== 'string') return false;
		// Match ISO date (yyyy-mm-dd) and ISO datetime (yyyy-mm-ddThh:mm, yyyy-mm-ddThh:mm:ss, etc)
		return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|([+-]\d{2}:\d{2}))?)?$/.test(val);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Display properties in exported documents?')
			.setDesc('Whether to include YAML frontmatter properties in the exported documents')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.displayProperties)
				.onChange(async (value) => {
					this.plugin.settings.displayProperties = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Date format for properties')
			.setDesc('Format for date properties (Luxon tokens, e.g. yyyy-MM-dd)')
			.addText(text => text
				.setPlaceholder('yyyy-MM-dd')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Properties to exclude')
			.setDesc('Comma-separated list of property names to exclude from export (case sensitive)')
			.addText(text => text
				.setPlaceholder('title,date,tags')
				.setValue(this.plugin.settings.excludedProperties)
				.onChange(async (value) => {
					this.plugin.settings.excludedProperties = value;
					await this.plugin.saveSettings();
				}));
		
		// Flag to add properties block after the first heading (if it exists). Otherwise, at the top of the document.
		new Setting(containerEl)
			.setName('Add properties block after first heading?')
			.setDesc('Whether to insert the properties block after the first heading in the exported document')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.addPropertiesBlockAfterHeading)
				.onChange(async (value) => {
					this.plugin.settings.addPropertiesBlockAfterHeading = value;
					await this.plugin.saveSettings();
				}));

	}
}


