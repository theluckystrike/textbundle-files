import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { lastNotice, pluginId, reloadPlugin } from './load';

describe(`${pluginId} smoke test`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const state = await reloadPlugin(pluginId);
		expect(state).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('runs the core command', async function () {
		await obsidianPage.write('Smoke.md', 'one two three four five');
		await obsidianPage.openFile('Smoke.md');
		await browser.executeObsidianCommand(`${pluginId}:export-note`);
		await browser.waitUntil(async () => (await lastNotice()).startsWith('Exported Smoke.textpack with 0 attachments.'), { timeout: 5000 });
	});
});
