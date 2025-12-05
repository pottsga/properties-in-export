# Properties in Export

**Properties in Export** is an Obsidian plugin that enhances document exports by displaying YAML frontmatter properties in a clean, formatted table. You can control which properties to display, how dates are formatted, and where the properties block appears in exported documents.

## Features

- Display YAML frontmatter properties in exported Markdown or PDF files.
- Format date properties using Luxon tokens (e.g., `yyyy-MM-dd`).
- Exclude specific properties from export.
- Optionally insert the properties block immediately after the first heading.
- Automatically tracks the currently active file.
- Preserves original print/export functionality.

## Settings

- **Display properties in exported documents?** Toggle to include or hide frontmatter properties.  
- **Date format for properties** Set the format for date values using Luxon tokens.  
- **Properties to exclude** Comma-separated list of property names to omit from export.  
- **Add properties block after first heading?** Toggle to insert the block after the first heading instead of the top of the document.

## Installation

1. Copy the plugin code into a new folder in your Obsidian vault under `.obsidian/plugins/properties-in-export/`.
2. Reload Obsidian or enable the plugin from the Community Plugins section.
3. Open the plugin settings to configure your preferences.

## Usage

- When exporting a Markdown file, the plugin automatically inserts a properties table based on the YAML frontmatter.
- Links in property values formatted as `[[Note]]` or `[[Note|Display Text]]` are converted into clickable internal links.
- Arrays and objects are formatted for readability, and date values are displayed according to the configured format.

## License

This plugin is provided as-is under the MIT license.
