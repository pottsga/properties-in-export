import { App, MarkdownView, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	displayProperties: boolean;
	omittedProperties: string;
	insertAfterHeading: boolean;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	displayProperties: true,
	omittedProperties: '',
	insertAfterHeading: false
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	// Track currently opened file so we can read its frontmatter when printing
	currentFile: TFile | null = null;
	// Keep a reference to the original print command callback so we can restore it
	private originalPrintCallback: ((...args: unknown[]) => unknown) | null = null;
	private isPrintPatched = false;

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

		// Register a markdown post-processor so the properties block is injected whenever a preview
		// section is rendered. This is the most reliable hook for Export → PDF because the export
		// process renders the preview and the post-processor runs inside that render pass.
		// (value formatting moved to class methods) — use this.valueToHtml / this.escapeHtml

		// Also set current file immediately if one is active on load
		this.currentFile = this.app.workspace.getActiveFile();

		// Monkey-patch the editor print command to inject frontmatter properties into the preview
		// Enumerate commands to help debug which command is used for Print/Export-to-PDF
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands?.commands as Record<string, unknown> | undefined;
		if (cmds) {
			const keys = Object.keys(cmds);
			const interesting = keys.filter(k => /print|pdf/i.test(k));
			console.log('Properties-on-export: found command ids matching /print|pdf/:', interesting);
		}
		const printCommand = cmds ? (cmds['editor:print'] as unknown as { callback?: (...args: unknown[]) => unknown } ) : undefined;
		// Also try known/export candidates
		const exportPdfCommand = cmds ? (cmds['export-pdf'] as unknown as { callback?: (...args: unknown[]) => unknown } ) : undefined;
		const appExportPdf = cmds ? (cmds['app:export-pdf'] as unknown as { callback?: (...args: unknown[]) => unknown } ) : undefined;
		if (printCommand && !this.isPrintPatched) {
			this.originalPrintCallback = printCommand.callback ?? null;
			// Use arrow so we keep plugin `this` lexically
			printCommand.callback = async (...args: unknown[]) => {
				try {
					await this.injectRenderedProperties();
				} catch (e) {
					console.error('Error injecting properties before print', e);
				}
				// call original callback if present. Use printCommand as context to be safe.
				let originalResult: unknown;
				try {
					if (this.originalPrintCallback) {
						originalResult = await (this.originalPrintCallback as (...a: unknown[]) => unknown).apply(printCommand, args);
					}
					return originalResult;
				} finally {
					try {
						await this.removeInjectedProperties();
					} catch (e) {
						console.error('Error removing injected properties after print', e);
					}
				}
			};
			this.isPrintPatched = true;
		}

		// If there's an explicit export-pdf command, patch it too as a fallback
		if (exportPdfCommand) {
			console.log('Properties-on-export: patching export-pdf command');
			exportPdfCommand.callback = async (...args: unknown[]) => {
				try { await this.injectRenderedProperties(); } catch (e) { console.error('inject before export-pdf', e); }
				try {
					if (this.originalPrintCallback) {
						await (this.originalPrintCallback as (...a: unknown[]) => unknown).apply(exportPdfCommand, args);
					}
				} finally {
					try { await this.removeInjectedProperties(); } catch (e) { console.error('remove after export-pdf', e); }
				}
			};
		}
		if (appExportPdf) {
			console.log('Properties-on-export: patching app:export-pdf command');
			appExportPdf.callback = async (...args: unknown[]) => {
				try { await this.injectRenderedProperties(); } catch (e) { console.error('inject before app:export-pdf', e); }
				try {
					if (this.originalPrintCallback) {
						await (this.originalPrintCallback as (...a: unknown[]) => unknown).apply(appExportPdf, args);
					}
				} finally {
					try { await this.removeInjectedProperties(); } catch (e) { console.error('remove after app:export-pdf', e); }
				}
			};
		}

		// Also listen for the browser print lifecycle events. Many "Export to PDF" implementations
		// use the print flow (window.print), which fires beforeprint/afterprint events in the webview.
		// Register via Obsidian so these listeners are removed when the plugin unloads.
		this.registerDomEvent(window, 'beforeprint', async () => {
			try {
				await this.injectRenderedProperties();
			} catch (e) {
				console.error('Error injecting properties during beforeprint', e);
			}
		});
		this.registerDomEvent(window, 'afterprint', async () => {
			try {
				await this.removeInjectedProperties();
			} catch (e) {
				console.error('Error removing properties during afterprint', e);
			}
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			try {
				console.log('Properties-on-export: markdown post-processor called');
				const sourcePath = (ctx as unknown as { sourcePath?: string }).sourcePath as string | undefined;
				if (!sourcePath) return;
				const file = this.app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
				if (!file) return;
				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache?.frontmatter) return;
				if (!this.settings.displayProperties) return;
				const props: Record<string, unknown> = Object.assign({}, cache.frontmatter);
				delete props.position;
				if (el.closest('.dataview')) return;
				let previewSection = el.closest('.markdown-preview-section');
				if (!previewSection) previewSection = el;
				if (previewSection.querySelector('.export-properties-block')) return;
				const html = this.getPropertiesHtml(props);
				if (!html) return;
				if (this.settings.insertAfterHeading) {
					const firstHeading = previewSection.querySelector('h1');
					if (firstHeading) {
						firstHeading.insertAdjacentHTML('afterend', html);
					} else {
						previewSection.insertAdjacentHTML('afterbegin', html);
					}
				} else {
					previewSection.insertAdjacentHTML('afterbegin', html);
				}
			} catch (e) {
				console.error('Properties-on-export: post-processor failed', e);
			}
		});
	}

	// Inject a simple HTML block at the top of the rendered preview with frontmatter properties
	private getPropertiesHtml(props: Record<string, unknown>): string | null {
		// Filter out omitted properties
		const omittedProps = this.settings.omittedProperties
			.split(',')
			.map(p => p.trim())
			.filter(p => p.length > 0);
		for (const prop of omittedProps) {
			delete props[prop];
		}
		if (Object.keys(props).length === 0) return null;
		let html = `<div class="export-properties-block" style="margin-bottom:1em;background:#f9f9f9;page-break-inside:avoid;">`;
		html += `<table style="width:100%;">`;
		for (const key of Object.keys(props)) {
			const value = props[key];
			const valueHtml = this.valueToHtml(value);
			html += `<tr><td style="font-weight:bold;padding:2px 6px;width:25%;">${this.escapeHtml(key)}</td><td style="padding:2px 6px;">${valueHtml}</td></tr>`;
		}
		html += `</table></div>`;
		return html;
	}

	async injectRenderedProperties(): Promise<void> {
		console.log("Injecting properties for file", this.currentFile?.path);
		console.log('Properties-on-export: injectRenderedProperties called');
		const file = this.currentFile;
		if (!file) return;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return;
		if (!this.settings.displayProperties) return;
		const rawProps = cache.frontmatter as Record<string, unknown>;
		const props: Record<string, unknown> = Object.assign({}, rawProps);
		delete props.position;
		const html = this.getPropertiesHtml(props);
		if (!html) {
			console.log('Properties-on-export: No properties to display after filtering');
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const container = view.contentEl.querySelector('.markdown-preview-section');
		if (container && !container.querySelector('.export-properties-block')) {
			container.insertAdjacentHTML('afterbegin', html);
		}
	}

	async removeInjectedProperties(): Promise<void> {
		console.log("Removing injected properties");
		console.log('Properties-on-export: removeInjectedProperties called');
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const block = view.contentEl.querySelector('.export-properties-block');
		if (block) block.remove();
	}

	// HTML escape helper used by multiple methods
	private escapeHtml(s: string): string {
		return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as Record<string,string>)[c]);
	}

	// Convert frontmatter value into HTML: handle dates and wiki-style links
	private valueToHtml(v: unknown): string {
		if (v === null || v === undefined) return '';
		if (Array.isArray(v)) return v.map(x => this.valueToHtml(x)).join(', ');
		let s = String(v);
		const dateMatch = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (dateMatch) {
			const [, datePart, hhStr, mmStr] = dateMatch;
			let hh = parseInt(hhStr, 10);
			const mm = mmStr;
			const ampm = hh >= 12 ? 'PM' : 'AM';
			hh = hh % 12;
			if (hh === 0) hh = 12;
			const hhPad = String(hh).padStart(2, '0');
			return `${this.escapeHtml(datePart)} ${this.escapeHtml(hhPad + mm + ampm)}`;
		}
		// Replace wikilinks
		s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, path) => {
			// Just display the raw path, not with dots
			const text = this.escapeHtml(path);
			return `<a class="internal-link" href="#" style="color:var(--text-accent, #388bfd);text-decoration:underline;">${text}</a>`;
		});
		return s;
	}

	onunload() {
		// Restore original print command callback if we patched it
		try {
			const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands?.commands as Record<string, unknown> | undefined;
			const printCommand = cmds ? (cmds['editor:print'] as unknown as { callback?: (...args: unknown[]) => unknown } ) : undefined;
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
}

class SettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

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
			.setName('Properties to omit')
			.setDesc('Comma-separated list of property names to exclude from export (case sensitive)')
			.addText(text => text
				.setPlaceholder('title,date,tags')
				.setValue(this.plugin.settings.omittedProperties)
				.onChange(async (value) => {
					this.plugin.settings.omittedProperties = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Insert properties after first heading?')
			.setDesc('If enabled, the properties block will be inserted after the first top-level heading (#) instead of at the very top. This works well with vaults using Chris Basham\'s "Alias from heading" plugin.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.insertAfterHeading)
				.onChange(async (value) => {
					this.plugin.settings.insertAfterHeading = value;
					await this.plugin.saveSettings();
				}));
	}
}
