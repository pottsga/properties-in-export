# Properties in Suggestion
Enhances Obsidian suggestion containers by showing selected frontmatter properties, formatting dates, and styling links.

## Features

- Display selected frontmatter properties in suggestion containers.
- Format ISO date properties using Luxon date tokens.
- Style [[wikilinks]] with var(--link-color) and underline.
- Avoid duplication of properties when suggestions are updated.
- Skip files in specific folders (ignoreFolders setting).

## Installation

1. Copy the plugin folder into your Obsidian `plugins` directory.
2. Enable the plugin in **Settings → Community Plugins**.
3. Configure the plugin options in **Settings → Properties in Suggestion**.

## Settings

- **Properties**  
  CSV list of frontmatter properties to display in suggestions.  
  Example: `Categories, Date`

- **Date format for properties**  
  Luxon date format string for any ISO date properties.  
  Example: `yyyy-MM-dd hhmmA`

- **Folders to ignore**  
  CSV list of folder paths to skip when fetching properties.  
  Example: `Templates, Archive`

## Usage

1. Ensure your notes have YAML frontmatter with the properties you want to display:

Categories: Work, Projects
Date: 2025-12-05

2. In your suggestion containers, the specified properties will now be rendered:
   - [[wikilinks]] will be colored and underlined.
   - ISO date properties will be formatted using your chosen date format.
   - Other text is displayed as plain text.

3. Files inside folders listed in **Folders to ignore** will be skipped automatically.

## Example

Frontmatter:
```
---
Categories: [[Work]], [[Projects]]
Date: 2025-12-05
---
```

Rendered in suggestion:

- **Categories:** `Work` (styled link), `Projects` (styled link)  
- **Date:** `2025-12-05` (formatted according to your dateFormat)

## Development

- Uses Obsidian API: `App`, `TFile`, `parseYaml`.  
- Observes DOM for new suggestion content and updates dynamically.  
- Uses Luxon for date formatting.

## License
MIT
