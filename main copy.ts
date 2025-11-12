import { App, MarkdownView, Plugin, PluginSettingTab, Setting, TFile, MarkdownPostProcessorContext } from 'obsidian';

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
			const sourcePath = (ctx as MarkdownPostProcessorContext).sourcePath as string | undefined;
			if (!sourcePath) return;
			const file = this.app.vault.getAbstractFileByPath(sourcePath) as TFile | null;
			if (!file) return;

			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.frontmatter) return;
			if (!this.settings.displayProperties) return;

			// Try to find the preview section nearest to the processed element first. In some
			// export renderers the element's ownerDocument is an isolated about:blank document
			// and querying the global document won't find the expected container. Using
			// el.closest lets us operate directly on the rendered section when available.
			const docRoot = (el.ownerDocument as Document);
			let topSection = (el as HTMLElement).closest('.markdown-preview-section') as HTMLElement | null;
			if (!topSection) {
				topSection = docRoot.querySelector('.markdown-preview-section') as HTMLElement | null;
			}

			// Debugging info: log document context so we can see if export uses a different document/container.
			// Accessing some properties (location, querySelector) may throw in certain renderer
			// contexts; guard with try/catch to avoid uncaught "illegal access" exceptions.
			let docLocation = 'no-location';
			let existingBlock = false;
			try {
				if (docRoot && docRoot.location && typeof (docRoot.location as Location).href === 'string') {
					docLocation = (docRoot.location as Location).href;
				}
				try {
					existingBlock = !!docRoot.querySelector('.export-properties-block');
				} catch (e) {
					// ignore
				}
			} catch (e) {
				// access to docRoot.location may throw in some environments (cross-origin)
				docLocation = 'unavailable';
			}
			console.log('Properties-on-export: post-processor called', {
				sourcePath,
				docLocation,
				topSectionFound: !!topSection,
				existingBlock,
			});
			if (!topSection) return;

			// Avoid duplicate insertion in this document (guarded)
			try {
				if (docRoot && docRoot.querySelector('.export-properties-block')) return;
			} catch (e) {
				// ignore; if we can't query the doc safely, fall through to attempt a safe insert later
			}

			// Prepare HTML block
			const props: Record<string, unknown> = Object.assign({}, cache.frontmatter);
			delete props.position;

			const html = this.getPropertiesHtml(props);
			console.log('Properties-on-export: prepared properties html', { keys: Object.keys(props), htmlLength: html ? html.length : 0 });
			if (!html) return;

			// Always insert into the topmost preview section for the rendered document.
			if (topSection) {
				if (this.settings.insertAfterHeading) {
					const firstHeading = topSection.querySelector('h1');
					if (firstHeading) {
						firstHeading.insertAdjacentHTML('afterend', html);
					} else {
						topSection.insertAdjacentHTML('afterbegin', html);
					}
				} else {
					topSection.insertAdjacentHTML('afterbegin', html);
				}
			} else {
				// Fallback: inject into the document body (useful when the render uses an
				// about:blank document without .markdown-preview-section)
				const body = (docRoot && (docRoot as Document).body) as HTMLElement | null;
				console.log('Properties-on-export: topSection not found — attempting body fallback', {
					elementTag: (el as HTMLElement).tagName,
					elementClasses: (el as HTMLElement).className,
					bodyExists: !!body,
				});
				if (body) {
					try {
						if (body.querySelector('.export-properties-block')) {
							console.log('Properties-on-export: fallback inject skipped — block exists in body');
							return;
						}
						if (this.settings.insertAfterHeading) {
							const firstHeading = body.querySelector('h1');
							if (firstHeading) {
								firstHeading.insertAdjacentHTML('afterend', html);
							} else {
								body.insertAdjacentHTML('afterbegin', html);
							}
						} else {
							body.insertAdjacentHTML('afterbegin', html);
						}
						console.log('Properties-on-export: injected into document body fallback');
					} catch (e) {
						console.warn('Properties-on-export: could not insert into document body due to cross-origin or inaccessible document', e);
					}
				}
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
	const file = this.currentFile;
	if (!file) return;

	const cache = this.app.metadataCache.getFileCache(file);
	if (!cache?.frontmatter) return;
	if (!this.settings.displayProperties) return;

	const props: Record<string, unknown> = Object.assign({}, cache.frontmatter);
	delete props.position;
		const html = this.getPropertiesHtml(props);
		if (!html) return;

		// Debugging info so we can see when injection runs (print/export flow)
		console.log('Properties-on-export: injectRenderedProperties called', {
			file: file.path,
			keys: Object.keys(props),
			htmlLength: html.length,
		});

	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return;

	// Try to find the topmost preview section inside the view first; if that fails (export
	// renders into a different document or container), fall back to the current document's
	// first preview section so injection still happens during export rendering.
	let topSection = view.contentEl.querySelector('.markdown-preview-section') as HTMLElement | null;
	if (!topSection) {
		// Fallback to the global document — this is useful during export where the renderer
		// may be in a different container that still has a .markdown-preview-section.
		const docRoot = (document as Document);
		topSection = docRoot.querySelector('.markdown-preview-section') as HTMLElement | null;
	}
	if (!topSection) {
		// Couldn't find a DOM insertion point in the renderer. We'll fall back to
		// patching the file content temporarily so the exported document contains
		// the properties. This is a more intrusive but reliable fallback.
		console.log('Properties-on-export: no topSection found in view — will attempt file patch fallback');
		try {
			await this.patchFileForExport(file, props);
		} catch (e) {
			console.error('Properties-on-export: failed to patch file for export', e);
		}
		return;
	}

	// Avoid injecting multiple times in this document/container. Guard queries with try/catch.
	const docRoot = (topSection.ownerDocument as Document) || (document as Document);
	try {
		if (docRoot.querySelector('.export-properties-block')) {
			console.log('Properties-on-export: injectSkipped — block already exists in document');
			return;
		}
	} catch (e) {
		// Could be cross-origin/inaccessible; continue and attempt safe insertion
		console.warn('Properties-on-export: could not query document for existing block; proceeding with cautious insert', e);
	}

	if (this.settings.insertAfterHeading) {
		const firstHeading = topSection.querySelector('h1');
		if (firstHeading) {
			firstHeading.insertAdjacentHTML('afterend', html);
		} else {
			topSection.insertAdjacentHTML('afterbegin', html);
		}
	} else {
		topSection.insertAdjacentHTML('afterbegin', html);
	}

		console.log('Properties-on-export: injection complete');
}


	/**
	 * Build a small Markdown snippet representing the frontmatter properties.
	 * This will be inserted into the file temporarily before export.
	 */
	private getPropertiesMarkdown(props: Record<string, unknown>): string | null {
		const omittedProps = this.settings.omittedProperties
			.split(',')
			.map(p => p.trim())
			.filter(p => p.length > 0);
		for (const prop of omittedProps) {
			delete props[prop];
		}
		if (Object.keys(props).length === 0) return null;
		let md = `<!-- export-properties-start -->\n`;
		md += `**Properties**\n\n`;
		for (const key of Object.keys(props)) {
			const value = props[key];
			const valueText = Array.isArray(value) ? value.join(', ') : String(value);
			md += `- **${this.escapeHtml(key)}**: ${this.escapeHtml(valueText)}\n`;
		}
		md += `\n<!-- export-properties-end -->\n`;
		return md;
	}

	/**
	 * Temporarily patch the file by inserting a small Markdown properties block.
	 * The original content is saved and restored in `removeInjectedProperties`.
	 */
	private async patchFileForExport(file: TFile, props: Record<string, unknown>): Promise<void> {
		const md = this.getPropertiesMarkdown(Object.assign({}, props));
		if (!md) return;
		try {
			const original = await this.app.vault.read(file);
			this.fileBackups[file.path] = original;
			let newContent: string;
			if (this.settings.insertAfterHeading) {
				// Find the first top-level heading and insert after it
				const idx = original.search(/^#\s/m);
				if (idx !== -1) {
					// Find end of the heading line
					const endOfLine = original.indexOf('\n', idx);
					if (endOfLine === -1) {
						newContent = original + '\n' + md;
					} else {
						newContent = original.slice(0, endOfLine + 1) + md + original.slice(endOfLine + 1);
					}
				} else {
					newContent = md + original;
				}
			} else {
				newContent = md + original;
			}
			await this.app.vault.modify(file, newContent);
			console.log('Properties-on-export: file patched for export (temporary)');
		} catch (e) {
			console.error('Properties-on-export: error patching file for export', e);
			// Clean up backup on failure
			delete this.fileBackups[file.path];
			throw e;
		}
	}


	async removeInjectedProperties(): Promise<void> {
		console.log("Removing injected properties");
		console.log('Properties-on-export: removeInjectedProperties called');
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		// Try to remove from the active view first, otherwise remove from the document
		const block = view.contentEl.querySelector('.export-properties-block');
		if (block) {
			block.remove();
			console.log('Properties-on-export: removed block from active view');
			return;
		}
		// Fallback: remove from document (useful for export renderer containers)
		try {
			const docBlock = document.querySelector('.export-properties-block');
			if (docBlock) {
				docBlock.remove();
				console.log('Properties-on-export: removed block from document');
			}
		} catch (e) {
			// ignore cross-origin or inaccessible document
		}

		// If we patched the file for export, restore original content now
		try {
			const active = this.app.workspace.getActiveFile();
			if (active && this.fileBackups[active.path]) {
				const original = this.fileBackups[active.path];
				await this.app.vault.modify(active, original);
				delete this.fileBackups[active.path];
				console.log('Properties-on-export: restored original file content after export');
			}
		} catch (e) {
			console.error('Properties-on-export: failed to restore original file after export', e);
		}
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
