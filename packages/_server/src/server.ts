// cSpell:ignore pycache

import {
    createConnection,
    TextDocuments, TextDocument, Disposable,
    InitializeResult,
    InitializeParams,
    ServerCapabilities,
    CodeActionKind,
} from 'vscode-languageserver';
import * as vscode from 'vscode-languageserver';
import { TextDocumentUri, TextDocumentUriLangId } from './vscode.workspaceFolders';
import { CancellationToken } from 'vscode-jsonrpc';
import * as Validator from './validator';
import { ReplaySubject, Subscription, timer } from 'rxjs';
import { filter, tap, debounce, debounceTime, flatMap, take } from 'rxjs/operators';
import { onCodeActionHandler } from './codeActions';
import { Text } from 'cspell-lib';

import * as CSpell from 'cspell-lib';
import { CSpellUserSettings } from './cspellConfig';
import { getDefaultSettings } from 'cspell-lib';
import * as Api from './api';
import { DocumentSettings, SettingsCspell, isUriAllowed, isUriBlackListed } from './documentSettings';
import {
    log,
    logError,
    logger,
    logInfo,
    LogLevel,
    setWorkspaceBase,
    setWorkspaceFolders,
} from './util';

log('Starting Spell Checker Server');

type RequestResult<T> = T | Promise<T>;

type RequestMethodApi = {
    [key in keyof Api.ServerMethodRequestResult]: (param: Api.ServerRequestMethodRequests[key]) => RequestResult<Api.ServerRequestMethodResults[key]>;
};

const notifyMethodNames: Api.NotifyServerMethodConstants = {
    onConfigChange: 'onConfigChange',
    registerConfigurationFile: 'registerConfigurationFile',
};

const tds = CSpell;

const defaultCheckLimit = Validator.defaultCheckLimit;

// Turn off the spell checker by default. The setting files should have it set.
// This prevents the spell checker from running too soon.
const defaultSettings: CSpellUserSettings = {
    ...CSpell.mergeSettings(getDefaultSettings(), CSpell.getGlobalSettings()),
    checkLimit: defaultCheckLimit,
    enabled: false,
};
const defaultDebounce = 50;

function run() {
    // debounce buffer
    const validationRequestStream = new ReplaySubject<TextDocument>(1);
    const triggerUpdateConfig = new ReplaySubject<void>(1);
    const triggerValidateAll = new ReplaySubject<void>(1);
    const validationByDoc = new Map<string, Subscription>();
    const blockValidation = new Map<string, number>();
    let isValidationBusy = false;
    const disposables: Disposable[] = [];

    const requestMethodApi: RequestMethodApi = {
        isSpellCheckEnabled: handleIsSpellCheckEnabled,
        getConfigurationForDocument: handleGetConfigurationForDocument,
        splitTextIntoWords: handleSplitTextIntoWords,
        spellingSuggestions: handleSpellingSuggestions,
    };

    // Create a connection for the server. The connection uses Node's IPC as a transport
    log('Create Connection');
    const connection = createConnection(vscode.ProposedFeatures.all);

    const documentSettings = new DocumentSettings(connection, defaultSettings);

    // Create a simple text document manager. The text document manager
    // supports full document sync only
    const documents: TextDocuments = new TextDocuments();

    connection.onInitialize((params: InitializeParams, token: CancellationToken): InitializeResult => {
        // Hook up the logger to the connection.
        log('onInitialize');
        setWorkspaceBase(params.rootUri ? params.rootUri : '');
        const capabilities: ServerCapabilities = {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync:  {
                openClose: true,
                change: documents.syncKind,
                willSave: true,
                save: { includeText: true },
            },
            codeActionProvider: {
                codeActionKinds: [
                    CodeActionKind.QuickFix
                ],
            },
        };
        return { capabilities };
    });

    // The settings have changed. Is sent on server activation as well.
    connection.onDidChangeConfiguration(onConfigChange);

    interface OnChangeParam { settings: SettingsCspell; }
    function onConfigChange(change: OnChangeParam) {
        logInfo('Configuration Change');
        triggerUpdateConfig.next(undefined);
        updateLogLevel();
    }

    function updateActiveSettings() {
        log('updateActiveSettings');
        documentSettings.resetSettings();
        triggerValidateAll.next(undefined);
    }

    function getActiveSettings(doc: TextDocumentUri) {
        return getActiveUriSettings(doc.uri);
    }

    function getActiveUriSettings(uri?: string) {
        return documentSettings.getUriSettings(uri);
    }

    function registerConfigurationFile(path: string) {
        documentSettings.registerConfigurationFile(path);
        logInfo('Register Configuration File', path);
        triggerUpdateConfig.next(undefined);
    }

    interface TextDocumentInfo {
        uri?: string;
        languageId?: string;
        text?: string;
    }

    // Listen for event messages from the client.
    connection.onNotification(notifyMethodNames.onConfigChange, onConfigChange);
    connection.onNotification(notifyMethodNames.registerConfigurationFile, registerConfigurationFile);

    async function handleIsSpellCheckEnabled(params: TextDocumentInfo): Promise<Api.IsSpellCheckEnabledResult> {
        const { uri, languageId } = params;
        const fileEnabled = uri ? !await isUriExcluded(uri) : undefined;
        const settings = await getActiveUriSettings(uri);
        return {
            languageEnabled: languageId && uri ? await isLanguageEnabled({ uri, languageId }, settings) : undefined,
            fileEnabled,
        };
    }

    async function handleGetConfigurationForDocument(params: TextDocumentInfo): Promise<Api.GetConfigurationForDocumentResult> {
        const { uri, languageId } = params;
        const doc = uri && documents.get(uri);
        const docSettings = doc && await getSettingsToUseForDocument(doc) || undefined;
        const settings = await getActiveUriSettings(uri);
        return {
            languageEnabled: languageId && doc ? await isLanguageEnabled(doc, settings) : undefined,
            fileEnabled: uri ? !await isUriExcluded(uri) : undefined,
            settings,
            docSettings,
        };
    }


    function textToWords(text: string): string[] {
        const setOfWords = new Set(
            Text.extractWordsFromCode(text)
                .map(t => t.text)
                .map(t => t.toLowerCase())
            );
        return [...setOfWords];
    }

    function handleSplitTextIntoWords(text: string): Api.SplitTextIntoWordsResult {
        return {
            words: textToWords(text),
        };
    }

    async function handleSpellingSuggestions(params: TextDocumentInfo): Promise<Api.SpellingSuggestionsResult> {
        return {};
    }

    // Register API Handlers
    Object.entries(requestMethodApi).forEach(([name, fn]) => {
        connection.onRequest(name, fn);
    });

    interface DocSettingPair {
        doc: TextDocument;
        settings: CSpellUserSettings;
    }

    // validate documents
    const disposableValidate = validationRequestStream
        .pipe(filter(doc => !validationByDoc.has(doc.uri)))
        .subscribe(doc => {
            if (!validationByDoc.has(doc.uri)) {
                const uri = doc.uri;
                if (isUriBlackListed(uri)) {
                    validationByDoc.set(doc.uri, validationRequestStream.pipe(
                        filter(doc => uri === doc.uri),
                        take(1),
                        tap(doc => log('Ignoring:', doc.uri)),
                        ).subscribe()
                    );
                } else {
                    validationByDoc.set(doc.uri, validationRequestStream.pipe(
                        filter(doc => uri === doc.uri),
                        tap(doc => log(`Request Validate: v${doc.version}`, doc.uri)),
                        flatMap(async doc => ({ doc, settings: await getActiveSettings(doc) }) as DocSettingPair),
                        debounce(dsp => timer(dsp.settings.spellCheckDelayMs || defaultDebounce)
                            .pipe(filter(() => !isValidationBusy))
                        ),
                        tap(dsp => log(`blocked? ${blockValidation.has(dsp.doc.uri)}`, dsp.doc.uri)),
                        filter(dsp => !blockValidation.has(dsp.doc.uri)),
                        flatMap(validateTextDocument),
                        ).subscribe(diag => connection.sendDiagnostics(diag))
                    );
                }
            }
        });

    const disposableTriggerUpdateConfigStream = triggerUpdateConfig.pipe(
        tap(() => log('Trigger Update Config')),
        debounceTime(100),
        ).subscribe(() => {
            updateActiveSettings();
        });

    const disposableTriggerValidateAll = triggerValidateAll
        .pipe(debounceTime(250))
        .subscribe(() => {
            log('Validate all documents');
            documents.all().forEach(doc => validationRequestStream.next(doc));
        });

    async function shouldValidateDocument(textDocument: TextDocument, settings: CSpellUserSettings): Promise<boolean> {
        const { uri } = textDocument;
        return !!settings.enabled && isLanguageEnabled(textDocument, settings)
            && !await isUriExcluded(uri);
    }

    function isLanguageEnabled(textDocument: TextDocumentUriLangId, settings: CSpellUserSettings) {
        const { enabledLanguageIds = []} = settings;
        return enabledLanguageIds.indexOf(textDocument.languageId) >= 0;
    }

    async function isUriExcluded(uri: string) {
        return documentSettings.isExcluded(uri);
    }

    async function getBaseSettings(doc: TextDocument) {
        const settings = await getActiveSettings(doc);
        return {...CSpell.mergeSettings(defaultSettings, settings), enabledLanguageIds: settings.enabledLanguageIds};
    }

    async function getSettingsToUseForDocument(doc: TextDocument) {
        return tds.constructSettingsForText(await getBaseSettings(doc), doc.getText(), doc.languageId);
    }

    interface ValidationResult extends vscode.PublishDiagnosticsParams {}

    async function validateTextDocument(dsp: DocSettingPair): Promise<ValidationResult> {
        async function validate() {
            const { doc, settings } = dsp;
            const uri = doc.uri;
            try {
                if (!isUriAllowed(uri, settings.allowedSchemas)) {
                    const schema = uri.split(':')[0];
                    log(`Schema not allowed (${schema}), skipping:`, uri);
                    return { uri, diagnostics: [] };
                }
                const shouldCheck = await shouldValidateDocument(doc, settings);
                if (!shouldCheck) {
                    log('validateTextDocument skip:', uri);
                    return { uri, diagnostics: [] };
                }
                const settingsToUse = await getSettingsToUseForDocument(doc);
                if (settingsToUse.enabled) {
                    logInfo('Validate File', uri);
                    log(`validateTextDocument start: v${doc.version}`, uri);
                    const diagnostics = await Validator.validateTextDocument(doc, settingsToUse);
                    log(`validateTextDocument done: v${doc.version}`, uri);
                    return { uri, diagnostics };
                }
            } catch (e) {
                logError(`validateTextDocument: ${JSON.stringify(e)}`);
            }
            return { uri, diagnostics: [] };
        }

        isValidationBusy = true;
        const r = await validate();
        isValidationBusy = false;
        return r;
    }

    // Make the text document manager listen on the connection
    // for open, change and close text document events
    documents.listen(connection);

    disposables.push(
        // The content of a text document has changed. This event is emitted
        // when the text document first opened or when its content has changed.
        documents.onDidChangeContent(event => {
            validationRequestStream.next(event.document);
        }),

        // We want to block validation during saving.
        documents.onWillSave(event => {
            const { uri, version } = event.document;
            log(`onWillSave: v${version}`, uri);
            blockValidation.set(uri, version);
        }),

        // Enable validation once it is saved.
        documents.onDidSave(event => {
            const { uri, version } = event.document;
            log(`onDidSave: v${version}`, uri);
            blockValidation.delete(uri);
            validationRequestStream.next(event.document);
        }),

        // Remove subscriptions when a document closes.
        documents.onDidClose(event => {
            const uri = event.document.uri;
            const sub = validationByDoc.get(uri);
            if (sub) {
                validationByDoc.delete(uri);
                sub.unsubscribe();
            }
            // A text document was closed we clear the diagnostics
            connection.sendDiagnostics({ uri, diagnostics: [] });
        }),
    );

    connection.onCodeAction(
        onCodeActionHandler(documents, getBaseSettings, () => documentSettings.version, documentSettings)
    );

    // Listen on the connection
    connection.listen();

    // Free up the validation streams on shutdown.
    connection.onShutdown(() => {
        disposables.forEach(d => d.dispose());
        disposables.length = 0;
        disposableValidate.unsubscribe();
        disposableTriggerUpdateConfigStream.unsubscribe();
        disposableTriggerValidateAll.unsubscribe();
        const toDispose = [...validationByDoc.values()];
        validationByDoc.clear();
        toDispose.forEach(sub => sub.unsubscribe());
    });

    function updateLogLevel() {
        connection.workspace.getConfiguration({ section: 'cSpell.logLevel' }).then(
            (result: string) => {
                fetchFolders();
                logger.level = result;
                logger.setConnection(connection);
            },
            (reject) => {
                fetchFolders();
                logger.level = LogLevel.DEBUG;
                logger.error(`Failed to get config: ${JSON.stringify(reject)}`);
                logger.setConnection(connection);
            }
        );
    }

    async function fetchFolders() {
        const folders = await connection.workspace.getWorkspaceFolders();
        if (folders) {
            setWorkspaceFolders(folders.map(f => f.uri));
        } else {
            setWorkspaceFolders([]);
        }
    }
}

run();
