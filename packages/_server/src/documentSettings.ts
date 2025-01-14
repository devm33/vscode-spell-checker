// cSpell:ignore pycache
import { Connection, TextDocumentUri } from './vscode.workspaceFolders';
import * as vscode from './vscode.workspaceFolders';
import {
    ExcludeFilesGlobMap,
    Glob
} from 'cspell-lib';
import * as path from 'path';
import * as fs from 'fs-extra';

import * as CSpell from 'cspell-lib';
import { CSpellUserSettings } from './cspellConfig';
import { URI as Uri } from 'vscode-uri';
import { log } from './util';
import { createAutoLoadCache, AutoLoadCache, LazyValue, createLazyValue } from './autoLoad';
import { GlobMatcher } from 'cspell-glob';

const cSpellSection: keyof SettingsCspell = 'cSpell';

// The settings interface describe the server relevant settings part
export interface SettingsCspell {
    cSpell?: CSpellUserSettings;
}

export interface SettingsVSCode {
    search?: {
        exclude?: ExcludeFilesGlobMap;
    };
}

interface VsCodeSettings {
    [key: string]: any;
}

interface ExtSettings {
    uri: string;
    vscodeSettings: SettingsCspell;
    settings: CSpellUserSettings;
    globMatcher: GlobMatcher;
}

const defaultExclude: Glob[] = [
    '**/*.rendered',
    '**/*.*.rendered',
    '__pycache__/**',   // ignore cache files.
];

const defaultAllowedSchemes = ['file', 'untitled'];
const schemeBlackList = ['git', 'output', 'debug', 'vscode'];

const defaultRootUri = Uri.file('').toString();

interface Clearable {
    clear: () => any;
}
export class DocumentSettings {
    // Cache per folder settings
    private cachedValues: Clearable[] = [];
    readonly getUriSettings = this.createCache((key: string = '') => this._getUriSettings(key));
    private readonly fetchSettingsForUri = this.createCache((key: string) => this._fetchSettingsForFolderUri(key));
    private readonly _cspellFileSettingsByFolderCache = this.createCache(readSettingsForFolderUri);
    private readonly fetchVSCodeConfiguration = this.createCache((key: string) => this._fetchVSCodeConfiguration(key));
    private readonly _folders = this.createLazy(() => this.fetchFolders());
    readonly configsToImport = new Set<string>();
    private readonly importedSettings = this.createLazy(() => this._importSettings());
    private _version = 0;

    constructor(readonly connection: Connection, readonly defaultSettings: CSpellUserSettings) {}

    async getSettings(document: TextDocumentUri): Promise<CSpellUserSettings> {
        return this.getUriSettings(document.uri);
    }

    async _getUriSettings(uri: string): Promise<CSpellUserSettings> {
        log('getUriSettings:', uri);
        const r = uri
            ? await this.fetchUriSettings(uri!)
            : CSpell.mergeSettings(this.defaultSettings, this.importedSettings());
        return r;
    }

    async isExcluded(uri: string): Promise<boolean> {
        const settingsByWorkspaceFolder = await this.findMatchingFolderSettings(uri);
        const fnExclTests = settingsByWorkspaceFolder.map(s => ((filename: string) => s.globMatcher.match(filename)));
        for (const fn of fnExclTests) {
            if (fn(Uri.parse(uri).path)) {
                return true;
            }
        }
        return false;
    }

    resetSettings() {
        log(`resetSettings`);
        CSpell.clearCachedSettings();
        this.cachedValues.forEach(cache => cache.clear());
        this._version += 1;
    }

    get folders(): Promise<vscode.WorkspaceFolder[]> {
        return this._folders();
    }

    private _importSettings() {
        log(`importSettings`);
        const importPaths = [...this.configsToImport.keys()].sort();
        return CSpell.readSettingsFiles(importPaths);
    }

    get version() {
        return this._version;
    }

    registerConfigurationFile(path: string) {
        log('registerConfigurationFile:', path);
        this.configsToImport.add(path);
        this.importedSettings.clear();
        this.resetSettings();
    }

    private async fetchUriSettings(uri: string): Promise<CSpellUserSettings> {
        log('Start fetchUriSettings:', uri);
        const folder = await this.findMatchingFolder(uri);
        const folderSettings = await this.fetchSettingsForUri(folder.uri);
        const spellSettings = CSpell.mergeSettings(this.defaultSettings, this.importedSettings(), folderSettings.settings);
        const fileUri = Uri.parse(uri);
        const fileSettings = CSpell.calcOverrideSettings(spellSettings, fileUri.fsPath);
        log('Finish fetchUriSettings:', uri);
        return fileSettings;
    }

    private async findMatchingFolder(docUri: string): Promise<vscode.WorkspaceFolder> {
        const root = Uri.parse(docUri || defaultRootUri).with({ path: ''});
        return (await this.matchingFoldersForUri(docUri))[0] || { uri: root.toString(), name: 'root' };
    }

    private async fetchFolders() {
        return (await vscode.getWorkspaceFolders(this.connection)) || [];
    }

    private async findMatchingFolderSettings(docUri: string): Promise<ExtSettings[]> {
        const matches = (await this.matchingFoldersForUri(docUri))
            .map(folder => folder.uri)
            .map(uri => this.fetchSettingsForUri(uri));
        if (matches.length) {
            return Promise.all(matches);
        }
        const { uri } = (await this.folders)[0] || { uri: docUri };
        return [await this.fetchSettingsForUri(uri)];
    }

    private async _fetchVSCodeConfiguration(uri: string) {
        return (await vscode.getConfiguration(this.connection, [
            { scopeUri: uri || undefined, section: cSpellSection },
            { section: 'search' }
        ])).map(v => v || {}) as [CSpellUserSettings, VsCodeSettings];
    }

    private async fetchSettingsFromVSCode(uri?: string): Promise<CSpellUserSettings> {
        const configs = await this.fetchVSCodeConfiguration(uri || '');
        const [ cSpell, search ] = configs;
        const { exclude = {} } = search;
        const { ignorePaths = [] } = cSpell;
        const cSpellConfigSettings: CSpellUserSettings = {
            ...cSpell,
            id: 'VSCode-Config',
            ignorePaths: ignorePaths.concat(CSpell.ExclusionHelper.extractGlobsFromExcludeFilesGlobMap(exclude)),
        };
        return cSpellConfigSettings;
    }

    private async _fetchSettingsForFolderUri(uri: string): Promise<ExtSettings> {
        log(`fetchFolderSettings: URI ${uri}`);
        const cSpellConfigSettings = await this.fetchSettingsFromVSCode(uri);
        const settings = this._cspellFileSettingsByFolderCache.get(uri);
        // cspell.json file settings take precedence over the vscode settings.
        const mergedSettings = CSpell.mergeSettings(cSpellConfigSettings, settings);
        const { ignorePaths = []} = mergedSettings;
        const globs = defaultExclude.concat(ignorePaths);
        const root = Uri.parse(uri).path;
        const globMatcher = new GlobMatcher(globs, root);

        const ext: ExtSettings = {
            uri,
            vscodeSettings: { cSpell: cSpellConfigSettings },
            settings: mergedSettings,
            globMatcher,
        };
        return ext;
    }

    private async matchingFoldersForUri(docUri: string): Promise<vscode.WorkspaceFolder[]> {
        const folders = await this.folders;
        return folders
            .filter(({uri}) => uri === docUri.slice(0, uri.length))
            .sort((a, b) => a.uri.length - b.uri.length)
            .reverse();
    }

    private createCache<K, T>(loader: (key: K) => T): AutoLoadCache<K, T> {
        const cache = createAutoLoadCache(loader);
        this.cachedValues.push(cache);
        return cache;
    }

    private createLazy<T>(loader: () => T): LazyValue<T> {
        const lazy = createLazyValue(loader);
        this.cachedValues.push(lazy);
        return lazy;
    }

}

function configPathsForRoot(workspaceRootUri?: string) {
    const workspaceRoot = workspaceRootUri ? Uri.parse(workspaceRootUri).fsPath : '';
    const paths = workspaceRoot ? [
        path.join(workspaceRoot, '.vscode', CSpell.defaultSettingsFilename.toLowerCase()),
        path.join(workspaceRoot, '.vscode', CSpell.defaultSettingsFilename),
        path.join(workspaceRoot, CSpell.defaultSettingsFilename.toLowerCase()),
        path.join(workspaceRoot, CSpell.defaultSettingsFilename),
    ] : [];
    return paths;
}

function readSettingsForFolderUri(uri: string): CSpellUserSettings {
    return uri ? readSettingsFiles(configPathsForRoot(uri)) : {};
}

function readSettingsFiles(paths: string[]) {
    log(`readSettingsFiles:`, paths);
    const existingPaths = paths.filter(filename => fs.existsSync(filename));
    return CSpell.readSettingsFiles(existingPaths);
}

export function isUriAllowed(uri: string, schemes?: string[]) {
    schemes = schemes || defaultAllowedSchemes;
    return doesUriMatchAnyScheme(uri, schemes);
}

export function isUriBlackListed(uri: string, schemes: string[] = schemeBlackList) {
    return doesUriMatchAnyScheme(uri, schemes);
}

export function doesUriMatchAnyScheme(uri: string, schemes: string[]): boolean {
    const schema = Uri.parse(uri).scheme;
    return schemes.findIndex(v => v === schema) >= 0;
}
