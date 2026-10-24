import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { helloSettingItems } from './hello/settings';
import { PRO_UI, isPro } from './pro';
import type TextbundleFilesPlugin from './main';

export interface TextbundleFilesSettings {
	/** Import a .textpack file that is added to the vault (for example by a drag into the file explorer). */
	autoImport: boolean;
	/** Pro: keep info.json in a property on import and write it back on export. */
	keepInfo: boolean;
	/** Paths of .textpack files that the plugin wrote. Auto import skips them, also on a device that syncs the settings. */
	written: string[];
}

export const DEFAULT_SETTINGS: TextbundleFilesSettings = {
	autoImport: false,
	keepInfo: true,
	written: [],
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<TextbundleFilesSettings> | null | undefined): TextbundleFilesSettings {
	const s = saved ?? {};
	return {
		autoImport: typeof s.autoImport === 'boolean' ? s.autoImport : DEFAULT_SETTINGS.autoImport,
		keepInfo: typeof s.keepInfo === 'boolean' ? s.keepInfo : DEFAULT_SETTINGS.keepInfo,
		written: Array.isArray(s.written) ? s.written.filter((p): p is string => typeof p === 'string').slice(-500) : [],
	};
}

/** The round trip option in effect. Without Pro it is off. */
export function keepInfoActive(settings: TextbundleFilesSettings, pro: boolean): boolean {
	return pro && settings.keepInfo;
}

export class TextbundleFilesSettingTab extends PluginSettingTab {
	plugin: TextbundleFilesPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: TextbundleFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Import packs added to the vault',
				desc: 'When a .textpack file comes into the vault, for example when you drag it into the file explorer, import it as a note next to it. The pack stays. Turn this off when a sync service adds the same packs on more than one device.',
				control: { type: 'toggle', key: 'autoImport', defaultValue: DEFAULT_SETTINGS.autoImport },
			},
			{
				name: 'Keep info.json in a property',
				desc: 'Pro. On import, put info.json in the textbundle property. On export, write it back, so the data of other apps stays.',
				control: { type: 'toggle', key: 'keepInfo', defaultValue: DEFAULT_SETTINGS.keepInfo, disabled: () => !isPro() },
			},
			{
				name: 'Pro features',
				desc: isPro()
					? 'Pro is on: folder import with a report, folder export, and the info.json property work.'
					: 'Free version: import one or more packs or bundles, and export the current note as a TextPack. Pro adds folder import with a report, folder export, and the info.json property for a round trip.',
			},
			// The Pro group comes after the settings of the plugin.
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
	}
}
