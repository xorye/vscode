/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	window,
	workspace,
	ConfigurationChangeEvent,
	Disposable,
	TextDocument,
	TextEditorSelectionChangeEvent,
	Position,
	TextEditor,
	Selection,
	Range,
	WorkspaceEdit
} from 'vscode';

let mirrorCursorsUtils: MirrorCursorsUtils;
let mirrorCursors: MirrorCursors | undefined;

export interface PositionInterface {
	line: number;
	character: number;
}

export function activateMirrorCursor(
	matchingTagPositionProvider: (document: TextDocument, position: Position) => Thenable<PositionInterface | null>,
	supportedLanguages: { [id: string]: boolean },
	configName: string): Disposable {
	mirrorCursorsUtils = new MirrorCursorsUtils(matchingTagPositionProvider, supportedLanguages, configName);

	if (mirrorCursorsUtils.mirrorConfigOn()) {
		mirrorCursors = new MirrorCursors();
	}

	return workspace.onDidChangeConfiguration(
		(event: ConfigurationChangeEvent) => {
			if (!event.affectsConfiguration(configName)) {
				return;
			}

			if (mirrorCursorsUtils.mirrorConfigOn()) {
				if (mirrorCursors) {
					throw new Error('Mirror cursors turned on but mirrorCursors already exist. This should never happen');
				}
				mirrorCursors = new MirrorCursors();
			} else {
				if (!mirrorCursors) {
					throw new Error('Mirror cursors turned off but mirrorCursors were already undefined. This should never happen');
				}
				mirrorCursors.cleanup();
				mirrorCursors = undefined;
			}
		}
	);
}

/**
 * Class containing useful mirror cursor functions
 */
class MirrorCursorsUtils {

	private matchingTagPositionProvider: (document: TextDocument, position: Position) => Thenable<PositionInterface | null>;
	private supportedLanguages: { [id: string]: boolean };
	private configName: string;

	constructor(matchingTagPositionProvider: (
		document: TextDocument, position: Position) => Thenable<PositionInterface | null>,
		supportedLanguages: { [id: string]: boolean },
		configName: string) {

		this.matchingTagPositionProvider = matchingTagPositionProvider;
		this.supportedLanguages = supportedLanguages;
		this.configName = configName;
	}

	/**
	 * Returns a promise resolving with the matching tag's `Position` for the
	 * tag located at `position`.
	 *
	 * Resolves with `null` if matching tag does not exists.
	 */
	public getMatchingTagPosition(document: TextDocument, position: Position): Thenable<Position | null> {
		/**
		 * Instantiate `Position` object from `PositionInterface` object
		 */
		return this.matchingTagPositionProvider(document, position).then((res: PositionInterface | null) => {
			if (!res) { return null; }
			return new Position(res.line, res.character);
		});
	}

	public isEditorSupportedLanguage(editor: TextEditor | undefined): boolean {
		if (!editor) { return false; }
		return this.supportedLanguages[editor.document.languageId];
	}

	public mirrorConfigOn(): boolean {
		return workspace.getConfiguration().get<boolean>(this.configName, true);
	}
}

/**
 * This class handles the instantiation and disposal of `CursorUpdater`
 *
 * Instantiates `CursorUpdater` if a the currently active file is a supported file.
 *
 * `MirrorCursors` should only be instantiated if the `html.mirrorCursorOnMatchingTag`
 * config is `true`. Otherwise, should be disposed.
 *
 * Instance of `MirrorCursors` exists <==> html.mirrorCursorOnMatchingTag is true
 */
class MirrorCursors {
	private currentFileIsSupported: boolean;
	private cursorUpdater: CursorUpdater | undefined;

	private disposables: Disposable[];

	constructor() {
		this.currentFileIsSupported = mirrorCursorsUtils.isEditorSupportedLanguage(
			window.activeTextEditor
		);
		this.disposables = [];
		this.setupSupportedFileListener();

		if (this.currentFileIsSupported) {
			this.cursorUpdater = new CursorUpdater();
		}
		window.showInformationMessage('Mirror cursor instantiated!');
	}

	/**
	 * Listener that listens to active text editor changes, so that
	 * we know if the user has currently opened a supported file.
	 */
	private setupSupportedFileListener(): void {
		this.disposables.push(window.onDidChangeActiveTextEditor(
			(editor: TextEditor | undefined) => {
				this.currentFileIsSupported = mirrorCursorsUtils.isEditorSupportedLanguage(editor);
				if (this.unsupportedFileToSupported()) {
					this.cursorUpdater = new CursorUpdater();
				} else if (this.supportedFileToUnsupported()) {
					this.cursorUpdater!.cleanup();
					this.cursorUpdater = undefined;
				} else if (this.supportedFileToSupported()) {
					this.cursorUpdater!.cleanup();
					this.cursorUpdater = new CursorUpdater();
				}
			}
		));
	}

	private supportedFileToUnsupported(): boolean {
		return !this.currentFileIsSupported && !!this.cursorUpdater;
	}

	private unsupportedFileToSupported(): boolean {
		return this.currentFileIsSupported && !this.cursorUpdater;
	}

	private supportedFileToSupported(): boolean {
		return this.currentFileIsSupported && !!this.cursorUpdater;
	}

	public cleanup(): void {
		if (this.cursorUpdater) { this.cursorUpdater.cleanup(true); }
		this.dispose();
		window.showInformationMessage('Mirror cursor destroyed!');
	}

	private dispose(): void {
		this.disposables.forEach((d: Disposable) => d.dispose());
	}
}

/**
 * This class handles updating the cursor(s) when inside a
 * supported file.
 *
 * Should only be instantiated if the user's active editor
 * is a supported file.
 *
 * The instance should only persist if the user's active editor is a
 * supported file.
 *
 * Instance of `CursorUpdater` exists <==> window.activeEditor has a supported file open
 */
class CursorUpdater {

	/**
	 * Cache previous cursors to prevent sending LSP requests
	 * every time. See `CursorUpdater.updateCursorsWhenTwoExist()`
	 */
	private prevCursors: Selection[];

	private currCursors: Selection[];
	private disposables: Disposable[];

	/**
	 * This is to distinguish the difference between being
	 * in mirror mode and having multiple cursors.
	 * Being in mirror mode means that there are multiple cursors.
	 * However, having multiple cursors does not necessarily mean that you
	 * are in mirror mode
	 */
	private isMirrorCursorsOn: boolean;

	constructor() {
		if (!window.activeTextEditor) {
			throw new Error('Please do not instantiate this class if there is no active editor');
		}

		this.prevCursors = [];
		this.currCursors = [];
		this.disposables = [];
		this.isMirrorCursorsOn = false;

		this.disposables.push(
			window.onDidChangeTextEditorSelection(this.updateCursors.bind(this))
		);
		window.showInformationMessage('Cursor updater instantiated!');
		this.updateCursors();
	}

	/**
	 * Updates cursors in current document
	 */
	private async updateCursors(event?: TextEditorSelectionChangeEvent): Promise<void> {
		const editor: TextEditor = window.activeTextEditor!;
		const textEditor: TextEditor = event ? event.textEditor : editor;

		if (!mirrorCursorsUtils.isEditorSupportedLanguage(textEditor)) {

			/**
			 * This should never happen. This instance of CursorUpdater should only exist when
			 * the active editor is a supported file
			 *
			 * `MirrorCursors` should make sure this never happens.
			 */
			return;
		}

		const selections: Selection[] = event
			? Object.assign([], event.selections)
			: editor.selections;

		this.prevCursors = this.currCursors;

		if (this.existsRangedSelection(selections)) {
			this.updateCursorsWhenRangedExists(textEditor.document, selections);
		} else if (selections.length === 1 && selections[0].isEmpty) {
			await this.trySetMirrorCursor(textEditor.document, selections);
		} else if (selections.length === 2 && selections[0].isEmpty && selections[1].isEmpty) {
			await this.updateCursorsWhenTwoExist(textEditor.document, selections);
		} else {
			this.currCursors = selections;
		}
	}

	private updateCursorsWhenRangedExists(document: TextDocument, selections: Selection[]): void {
		if (selections.length === 2 && !selections[0].isEmpty && !selections[1].isEmpty) {
			const charBeforeAndAfterAnchorPositionsRoughlyEqual = this.isCharBeforeAndAfterPositionsRoughlyEqual(
				document,
				selections[0].anchor,
				selections[1].anchor
			);

			const charBeforeAndAfterActivePositionsRoughlyEqual = this.isCharBeforeAndAfterPositionsRoughlyEqual(
				document,
				selections[0].active,
				selections[1].active
			);

			if (!charBeforeAndAfterAnchorPositionsRoughlyEqual || !charBeforeAndAfterActivePositionsRoughlyEqual) {
				this.isMirrorCursorsOn = false;
				this.setCurrCursors([selections[0]]);
			}
		} else {
			this.isMirrorCursorsOn = false;
			this.currCursors = selections;
		}
	}

	/**
	 * Updates cursors when there are two cursors
	 */
	private async updateCursorsWhenTwoExist(document: TextDocument, selections: Selection[]): Promise<void> {

		if (this.isMirrorCursorsOn) {
			if (!this.areMirrorCursorsWithinTagName(document, selections[0].anchor, selections[1].anchor)) {
				this.setCurrCursors([selections[0]]);
				this.isMirrorCursorsOn = false;
				return;
			}

			if (this.prevCursors.length === 2 &&
				this.onDifferentLines(selections[0], this.prevCursors[0]) &&
				this.onDifferentLines(selections[1], this.prevCursors[0])
			) {
				await this.trySetMirrorCursor(document, selections);
				return;
			}

			if (
				this.shouldDoCleanupForHtmlAttributeInput(
					document,
					selections[0].anchor,
					selections[1].anchor
				)
			) {
				workspace.applyEdit(this.createCleanupForXmlAttributeInput(document, selections[1].anchor));
				this.setCurrCursors([selections[0]]);
				this.isMirrorCursorsOn = false;
				return;
			}
		} else {
			/**
			 * Two cursors exist, but `this.isMirrorCursorsOn == false`.
			 * Check if the two cursors are mirror cursors and adjust
			 * `this.isMirrorCursorsOn` accordingly
			 */
			const matchingTagPosition: Position | null = await mirrorCursorsUtils.getMatchingTagPosition(document, selections[0].active);
			if (matchingTagPosition && selections[1].active.isEqual(matchingTagPosition)) {
				this.isMirrorCursorsOn = true;
				this.currCursors = selections;
				return;
			}
		}
		this.currCursors = selections;
	}

	private existsRangedSelection(selections: Selection[]): boolean {
		return selections.some((s: Selection) => !s.isEmpty);
	}

	private onDifferentLines(first: Selection, second: Selection): boolean {
		return first.anchor.line !== second.anchor.line;
	}

	/**
	 * Tries to set a mirror cursor if matching tag is available
	 */
	private async trySetMirrorCursor(document: TextDocument, selections: Selection[]): Promise<void> {
		const matchingTagPosition: Position | null = await mirrorCursorsUtils.getMatchingTagPosition(document, selections[0].active);
		if (!matchingTagPosition) {
			this.isMirrorCursorsOn = false;
		} else if (this.areMirrorCursorsWithinTagName(document, selections[0].anchor, matchingTagPosition)) {
			this.isMirrorCursorsOn = true;
			const newCursor = new Selection(matchingTagPosition, matchingTagPosition);
			this.setCurrCursors([selections[0], newCursor]);
		}
	}

	/**
	 * Returns true if `startCursor` and `endCursor` are mirror tags that are
	 * within tag names.
	 */
	private areMirrorCursorsWithinTagName(document: TextDocument, startCursor: Position, endCursor: Position): boolean {
		return !this.isPositionsOutsideTags(document, startCursor, endCursor) &&
			this.isCharBeforeAndAfterPositionsRoughlyEqual(document, startCursor, endCursor);
	}

	private setCurrCursors(cursors: Selection[]): void {
		window.activeTextEditor!.selections = cursors;
		this.currCursors = cursors;
	}

	private isPositionsOutsideTags(document: TextDocument, firstPos: Position, secondPos: Position): boolean {
		const charBeforeFirstPos: string = this.getCharBefore(document, firstPos);
		const charAfterFirstPos: string = this.getCharAfter(document, firstPos);
		const charBeforeSecondPos: string = this.getCharBefore(document, secondPos);
		const charAfterSecondPos: string = this.getCharAfter(document, secondPos);

		/**
		* Special case for exiting
		* |<div>
		* |</div>
		*/
		if (
			charBeforeFirstPos === ' ' &&
			charBeforeSecondPos === ' ' &&
			charAfterFirstPos === '<' &&
			charAfterSecondPos === '<'
		) {
			return true;
		}
		/**
		 * Special case for exiting
		 * |  <div>
		 * |  </div>
		 */
		if (charBeforeFirstPos === '\n' && charBeforeSecondPos === '\n') {
			return true;
		}
		/**
		 * Special case for exiting
		 * <div>|
		 * </div>|
		 */
		if (charAfterFirstPos === '\n' && charAfterSecondPos === '\n') {
			return true;
		}

		return false;

	}

	// Check if chars before and after the two positions are equal
	// For the chars before, `<` and `/` are considered equal to handle the case of `<|></|>`
	private isCharBeforeAndAfterPositionsRoughlyEqual(document: TextDocument, firstPos: Position, secondPos: Position): boolean {
		const charBeforeFirstPos: string = this.getCharBefore(document, firstPos);
		const charAfterFirstPos: string = this.getCharAfter(document, firstPos);
		const charBeforeSecondPos: string = this.getCharBefore(document, secondPos);
		const charAfterSecondPos: string = this.getCharAfter(document, secondPos);

		// Exit mirror mode when cursor position no longer mirror
		// Unless it's in the case of `<|></|>`
		const charBeforeBothPositionRoughlyEqual: boolean =
			charBeforeFirstPos === charBeforeSecondPos ||
			(charBeforeFirstPos === '/' && charBeforeSecondPos === '<') ||
			(charBeforeSecondPos === '/' && charBeforeFirstPos === '<');
		const charAfterBothPositionRoughlyEqual: boolean =
			charAfterFirstPos === charAfterSecondPos ||
			(charAfterFirstPos === ' ' && charAfterSecondPos === '>') ||
			(charAfterSecondPos === ' ' && charAfterFirstPos === '>');

		return charBeforeBothPositionRoughlyEqual && charAfterBothPositionRoughlyEqual;
	}

	private shouldDoCleanupForHtmlAttributeInput(document: TextDocument, firstPos: Position, secondPos: Position): boolean {
		// Need to cleanup in the case of <div |></div |>
		const charBeforeFirstPos: string = this.getCharBefore(document, firstPos);
		const charAfterFirstPos: string = this.getCharAfter(document, firstPos);
		const charBeforeSecondPos: string = this.getCharBefore(document, secondPos);
		const charAfterSecondPos: string = this.getCharAfter(document, secondPos);
		const firstBeforeSecond: boolean = document.offsetAt(firstPos) < document.offsetAt(secondPos);

		/**
		 * Check two cases
		 * <div |></div >
		 * <div | id="a"></div >
		 * Before 1st cursor: ` `
		 * After  1st cursor: `>` or ` `
		 * Before 2nd cursor: ` `
		 * After  2nd cursor: `>`
		 */
		return (
			firstBeforeSecond &&
			charBeforeFirstPos === ' ' &&
			(charAfterFirstPos === '>' || charAfterFirstPos === ' ') &&
			charBeforeSecondPos === ' ' &&
			charAfterSecondPos === '>'
		);
	}

	private createCleanupForXmlAttributeInput(document: TextDocument, endTagCursorPos: Position): WorkspaceEdit {
		const cleanupEdit: WorkspaceEdit = new WorkspaceEdit();
		const cleanupRange: Range = new Range(endTagCursorPos.translate(0, -1), endTagCursorPos);
		cleanupEdit.replace(document.uri, cleanupRange, '');
		return cleanupEdit;
	}

	private getCharBefore(document: TextDocument, position: Position): string {
		const offset: number = document.offsetAt(position);
		if (offset === 0) {
			return '';
		}

		return document.getText(new Range(document.positionAt(offset - 1), position));
	}

	private getCharAfter(document: TextDocument, position: Position): string {
		const offset: number = document.offsetAt(position);
		if (offset === document.getText().length) {
			return '';
		}

		return document.getText(new Range(position, document.positionAt(offset + 1)));
	}

	public cleanup(forceOneCursor = false): void {
		if (forceOneCursor && window.activeTextEditor && window.activeTextEditor.selections.length > 0) {
			window.activeTextEditor.selections = [window.activeTextEditor.selections[0]];
		}
		this.dispose();
		window.showInformationMessage('Cursor updater destroyed!');
	}

	private dispose(): void {
		this.disposables.forEach((d: Disposable) => d.dispose());
	}
}
