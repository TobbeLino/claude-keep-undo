import * as vscode from "vscode";
import {
  ApplyResult,
  ChangeStore,
  ReviewStore,
  TrackedFile,
  UndoBatchResult,
  UndoSnapshot,
  Unreviewable,
} from "./changeStore";
import { LineChange } from "./diff";
import {
  hooksState,
  maybePromptInstall,
  repairHooksIfStale,
  warnIfBashDetectionUnavailable,
} from "./detection/hookInstaller";
import { HookState } from "./detection/hookSettings";
import { KeepUndoWatcher } from "./detection/keepUndoWatcher";
import { TranscriptWatcher } from "./detection/transcriptWatcher";
import { IgnoreConfig } from "./ignoreConfig";
import * as settings from "./settings";
import { ClaudeSourceControl, DoubledGutterNotice } from "./ui/quickDiff";
import {
  ensureDir,
  folderStateDir,
  legacyWorkspaceFallbackStateDir,
  moveDir,
  normalizePath,
  owningRoot,
  stateDirHasContent,
} from "./util";

/**
 * One workspace folder's review machinery: its own store, ignore rules, hooks,
 * transcript watcher and Source Control entry.
 */
export class FolderSession implements vscode.Disposable {
  readonly ignore: IgnoreConfig;
  readonly store: ChangeStore;
  readonly stateDir: string;
  private hookWatcher: KeepUndoWatcher | undefined;
  private transcript: TranscriptWatcher | undefined;
  private readonly scm: ClaudeSourceControl;
  private readonly gutterNotice: DoubledGutterNotice;
  private readonly hookWatch: vscode.Disposable;
  private readonly ignoreWatch: vscode.Disposable;
  private readonly storeForwarders: vscode.Disposable[] = [];
  private readonly _onDidDropIgnored = new vscode.EventEmitter<string[]>();
  readonly onDidDropIgnored = this._onDidDropIgnored.event;
  private readonly _onDidHookSettings = new vscode.EventEmitter<void>();
  readonly onDidHookSettings = this._onDidHookSettings.event;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
    private readonly reviewStore: ReviewStore,
    confirmedIgnore: () => boolean
  ) {
    this.stateDir = resolveFolderStateDir(context, folder, log);
    ensureDir(this.stateDir);
    this.log(`Active on ${this.root} (state: ${this.stateDir})`);
    this.ignore = new IgnoreConfig(this.root, this.stateDir, log);
    this.store = new ChangeStore(this.stateDir, this.root, log, this.ignore);
    this.scm = new ClaudeSourceControl(folder, this.store);
    this.gutterNotice = new DoubledGutterNotice(
      this.root,
      this.store,
      context.workspaceState
    );
    this.hookWatch = watchHookSettings(folder, () =>
      this._onDidHookSettings.fire()
    );
    this.ignoreWatch = this.ignore.onDidChange(() => {
      const left = this.store.reconcileIgnored();
      if (left.length > 0 && !confirmedIgnore()) {
        this._onDidDropIgnored.fire(left);
      }
    });
  }

  /** Forward this folder's store events through the hub. */
  attachToHub(hub: ReviewHub): vscode.Disposable {
    const listeners = [
      this.store.onDidChange((uri) => hub.forwardChange(uri)),
      this.store.onDidDetect((uri) => hub.forwardDetect(uri)),
      this.onDidDropIgnored((left) => hub.forwardDroppedIgnored(left)),
      this.onDidHookSettings(() => hub.forwardSessionsChange()),
    ];
    this.storeForwarders.push(...listeners);
    return {
      dispose: () => {
        for (const l of listeners) {
          l.dispose();
        }
      },
    };
  }

  get root(): string {
    return this.folder.uri.fsPath;
  }

  get name(): string {
    return this.folder.name;
  }

  hookState(): HookState {
    try {
      return hooksState(
        this.root,
        this.context.extensionPath,
        this.stateDir,
        settings.bashChanges()
      );
    } catch (err) {
      this.log(`could not read the hook registration: ${String(err)}`);
      return "missing";
    }
  }

  syncDetectors(): void {
    if (settings.useHooks() && this.hookWatcher) {
      try {
        repairHooksIfStale(
          this.root,
          this.context.extensionPath,
          this.stateDir,
          settings.bashChanges(),
          this.log,
          this.context.workspaceState
        );
      } catch (err) {
        this.log(`could not inspect the hook registration: ${String(err)}`);
      }
    }
    if (settings.useHooks() && !this.hookWatcher) {
      this.hookWatcher = new KeepUndoWatcher(this.stateDir, this.store);
      let state: HookState = "missing";
      try {
        state = repairHooksIfStale(
          this.root,
          this.context.extensionPath,
          this.stateDir,
          settings.bashChanges(),
          this.log,
          this.context.workspaceState
        );
      } catch (err) {
        this.log(`could not inspect the hook registration: ${String(err)}`);
      }
      this.log(
        state === "ok"
          ? `Hooks detected in ${this.name}: real-time detection active.`
          : `Hooks not active in ${this.name} (${state}).`
      );
      if (state === "ok") {
        void warnIfBashDetectionUnavailable(
          this.root,
          settings.bashChanges(),
          this.log,
          this.context.workspaceState
        );
      }
    } else if (!settings.useHooks() && this.hookWatcher) {
      this.hookWatcher.dispose();
      this.hookWatcher = undefined;
      this.log(`Hook watcher stopped for ${this.name}.`);
    }

    if (settings.useTranscript() && !this.transcript) {
      // The hub, not this folder's store: a session in this repo can edit a
      // file that belongs to another folder in the same window.
      this.transcript = new TranscriptWatcher(
        this.root,
        this.reviewStore,
        this.log
      );
      this.transcript.start();
      this.log(`Transcript watcher started for ${this.name}.`);
    } else if (!settings.useTranscript() && this.transcript) {
      this.transcript.dispose();
      this.transcript = undefined;
      this.store.clearUnreviewable();
      this.log(`Transcript watcher stopped for ${this.name}.`);
    }
  }

  dispose(): void {
    for (const listener of this.storeForwarders) {
      listener.dispose();
    }
    this.storeForwarders.length = 0;
    this.hookWatcher?.dispose();
    this.transcript?.dispose();
    this.hookWatch.dispose();
    this.ignoreWatch.dispose();
    this.gutterNotice.dispose();
    this.scm.dispose();
    this.ignore.dispose();
    this.store.dispose();
    this._onDidDropIgnored.dispose();
    this._onDidHookSettings.dispose();
  }
}

/**
 * Every workspace folder's review state, presented as one {@link ReviewStore}
 * so the rest of the extension does not have to know how many roots there are.
 *
 * Each folder keeps its own on-disk queue, keyed by that folder's path — not
 * by the VS Code workspace — so opening the same repo in another window, or
 * on its own, finds the same pending reviews.
 */
export class ReviewHub implements vscode.Disposable, ReviewStore {
  private readonly sessions = new Map<string, FolderSession>();
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | undefined
  >();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidDetect = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidDetect = this._onDidDetect.event;
  private readonly _onDidSessionsChange = new vscode.EventEmitter<void>();
  readonly onDidSessionsChange = this._onDidSessionsChange.event;
  private readonly _onDidDropIgnored = new vscode.EventEmitter<string[]>();
  readonly onDidDropIgnored = this._onDidDropIgnored.event;
  private readonly folderListener: vscode.Disposable;
  private confirmedIgnoreChange = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void
  ) {
    this.folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() =>
      this.syncFolders()
    );
    this.syncFolders();
  }

  /** Mark the next ignore-rule reconcile as user-confirmed (no toast). */
  beginConfirmedIgnore(): void {
    this.confirmedIgnoreChange = true;
  }

  endConfirmedIgnore(): void {
    this.confirmedIgnoreChange = false;
  }

  getFolders(): FolderSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  get multiRoot(): boolean {
    return this.sessions.size > 1;
  }

  get primary(): FolderSession | undefined {
    const first = vscode.workspace.workspaceFolders?.[0];
    if (first) {
      const session = this.sessions.get(folderKey(first.uri));
      if (session) {
        return session;
      }
    }
    return this.getFolders()[0];
  }

  get stateDir(): string {
    return this.primary?.stateDir ?? this.fallbackStateDir();
  }

  sessionForPath(absPath: string): FolderSession | undefined {
    const owner = owningRoot(
      this.getFolders().map((s) => s.root),
      absPath
    );
    if (!owner) {
      return undefined;
    }
    return this.getFolders().find((s) => pathsEqual(s.root, owner));
  }

  sessionForRoot(root: string): FolderSession | undefined {
    for (const session of this.sessions.values()) {
      if (pathsEqual(session.root, root)) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * The session a command argument refers to: a folder tree node, an SCM
   * provider (which carries `rootUri`), or a file path.
   */
  sessionFromArg(arg: unknown): FolderSession | undefined {
    if (!arg || typeof arg !== "object") {
      return undefined;
    }
    const rec = arg as Record<string, unknown>;
    if (rec.type === "folder" && typeof rec.root === "string") {
      return this.sessionForRoot(rec.root);
    }
    const rootUri = rec.rootUri;
    if (rootUri instanceof vscode.Uri) {
      return this.sessionForRoot(rootUri.fsPath);
    }
    return undefined;
  }

  ignoreFor(absPath: string): IgnoreConfig | undefined {
    return this.sessionForPath(absPath)?.ignore ?? this.primary?.ignore;
  }

  patternCount(): number {
    return this.getFolders().reduce((n, s) => n + s.ignore.patternCount(), 0);
  }

  aggregatedHookState(): HookState {
    const states = this.getFolders().map((s) => s.hookState());
    if (states.length === 0) {
      return "missing";
    }
    if (states.includes("foreign")) {
      return "foreign";
    }
    if (states.includes("stale")) {
      return "stale";
    }
    if (states.includes("missing")) {
      return "missing";
    }
    return "ok";
  }

  hooksInstalledEverywhere(): boolean {
    const folders = this.getFolders();
    return folders.length > 0 && folders.every((s) => s.hookState() === "ok");
  }

  syncDetectors(): void {
    for (const session of this.getFolders()) {
      session.syncDetectors();
    }
  }

  async promptInstallHooks(): Promise<void> {
    const targets = this.getFolders().map((s) => ({
      workspaceRoot: s.root,
      stateDir: s.stateDir,
    }));
    await maybePromptInstall(this.context, targets);
  }

  refreshFromDisk(): void {
    for (const session of this.getFolders()) {
      session.store.refreshFromDisk();
    }
    this._onDidChange.fire(undefined);
  }

  forwardChange(uri: vscode.Uri | undefined): void {
    this._onDidChange.fire(uri);
  }

  forwardDetect(uri: vscode.Uri): void {
    this._onDidDetect.fire(uri);
  }

  forwardDroppedIgnored(left: string[]): void {
    this._onDidDropIgnored.fire(left);
  }

  forwardSessionsChange(): void {
    this._onDidSessionsChange.fire();
  }

  // --- ReviewStore ---------------------------------------------------------

  getTracked(): TrackedFile[] {
    return this.getFolders()
      .flatMap((s) => s.store.getTracked())
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  isTracked(absPath: string): boolean {
    return this.storeFor(absPath)?.isTracked(absPath) === true;
  }

  hasBaseline(absPath: string): boolean {
    return this.storeFor(absPath)?.hasBaseline(absPath) === true;
  }

  get(absPath: string): TrackedFile | undefined {
    return this.storeFor(absPath)?.get(absPath);
  }

  count(): number {
    return this.getFolders().reduce((n, s) => n + s.store.count(), 0);
  }

  isApplyingEdit(): boolean {
    return this.getFolders().some((s) => s.store.isApplyingEdit());
  }

  isUserTouched(absPath: string): boolean {
    return this.storeFor(absPath)?.isUserTouched(absPath) === true;
  }

  isCreated(absPath: string): boolean {
    return this.storeFor(absPath)?.isCreated(absPath) === true;
  }

  isInScope(absPath: string): boolean {
    const owner = this.sessionForPath(absPath);
    if (owner) {
      return owner.store.isInScope(absPath);
    }
    return this.getFolders().some((s) => s.store.isInScope(absPath));
  }

  isIgnored(absPath: string): boolean {
    return this.storeFor(absPath)?.isIgnored(absPath) === true;
  }

  getUnreviewable(): Unreviewable[] {
    return this.getFolders()
      .flatMap((s) => s.store.getUnreviewable())
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  noteUnreviewable(absPath: string, reason: string): void {
    this.storeFor(absPath)?.noteUnreviewable(absPath, reason);
  }

  clearUnreviewable(absPath?: string): void {
    if (absPath !== undefined) {
      this.storeFor(absPath)?.clearUnreviewable(absPath);
      return;
    }
    for (const session of this.getFolders()) {
      session.store.clearUnreviewable();
    }
  }

  noteUserEdit(absPath: string): void {
    this.storeFor(absPath)?.noteUserEdit(absPath);
  }

  getBaseline(absPath: string): string {
    return this.storeFor(absPath)?.getBaseline(absPath) ?? "";
  }

  hunkIndexAtLine(absPath: string, line: number): number | undefined {
    return this.storeFor(absPath)?.hunkIndexAtLine(absPath, line);
  }

  registerBaseline(
    absPath: string,
    baseline: string,
    options: { created?: boolean } = {}
  ): void {
    this.storeFor(absPath)?.registerBaseline(absPath, baseline, options);
  }

  reloadBaseline(absPath: string): void {
    this.storeFor(absPath)?.reloadBaseline(absPath);
  }

  recompute(absPath: string, silent = false, noResolve = false): void {
    this.storeFor(absPath)?.recompute(absPath, silent, noResolve);
  }

  keepHunk(absPath: string, index: number, fingerprint?: string): ApplyResult {
    return (
      this.storeFor(absPath)?.keepHunk(absPath, index, fingerprint) ??
      "unavailable"
    );
  }

  async undoHunk(
    absPath: string,
    index: number,
    fingerprint?: string
  ): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoHunk(absPath, index, fingerprint) : "unavailable";
  }

  keepLineChange(absPath: string, change: LineChange): ApplyResult {
    return (
      this.storeFor(absPath)?.keepLineChange(absPath, change) ?? "unavailable"
    );
  }

  async undoLineChange(
    absPath: string,
    change: LineChange
  ): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoLineChange(absPath, change) : "unavailable";
  }

  keepFile(absPath: string): void {
    this.storeFor(absPath)?.keepFile(absPath);
  }

  async undoFile(absPath: string): Promise<ApplyResult> {
    const store = this.storeFor(absPath);
    return store ? store.undoFile(absPath) : "unavailable";
  }

  keepAll(): void {
    for (const session of this.getFolders()) {
      session.store.keepAll();
    }
    this._onDidChange.fire(undefined);
  }

  keepAllIn(session: FolderSession): void {
    session.store.keepAll();
  }

  async undoAll(): Promise<UndoBatchResult> {
    return this.undoPaths(this.getTracked().map((f) => f.path));
  }

  async undoPaths(paths: string[]): Promise<UndoBatchResult> {
    const byStore = new Map<ChangeStore, string[]>();
    const skipped: string[] = [];
    for (const absPath of paths) {
      const store = this.storeFor(absPath);
      if (!store) {
        skipped.push(absPath);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push(absPath);
      byStore.set(store, list);
    }
    const merged: UndoBatchResult = {
      applied: 0,
      reformatted: [],
      failed: [],
      deleted: [],
      skipped,
    };
    for (const [store, group] of byStore) {
      const part = await store.undoPaths(group);
      merged.applied += part.applied;
      merged.reformatted.push(...part.reformatted);
      merged.failed.push(...part.failed);
      merged.deleted.push(...part.deleted);
      merged.skipped.push(...part.skipped);
    }
    this._onDidChange.fire(undefined);
    return merged;
  }

  captureUndoSnapshot(absPath: string): UndoSnapshot | undefined {
    return this.storeFor(absPath)?.captureUndoSnapshot(absPath);
  }

  stampPostUndo(snapshots: UndoSnapshot[]): UndoSnapshot[] {
    return snapshots.flatMap((snap) => {
      const store = this.storeFor(snap.path);
      return store ? store.stampPostUndo([snap]) : [snap];
    });
  }

  async restoreUndoSnapshots(
    snapshots: UndoSnapshot[]
  ): Promise<{ failed: string[]; stale: string[] }> {
    const failed: string[] = [];
    const stale: string[] = [];
    const byStore = new Map<ChangeStore, UndoSnapshot[]>();
    for (const snap of snapshots) {
      const store = this.storeFor(snap.path);
      if (!store) {
        failed.push(snap.path);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push(snap);
      byStore.set(store, list);
    }
    for (const [store, group] of byStore) {
      const part = await store.restoreUndoSnapshots(group);
      failed.push(...part.failed);
      stale.push(...part.stale);
    }
    return { failed, stale };
  }

  snapshotsLocation(): string {
    return this.primary?.store.snapshotsLocation() ?? this.fallbackStateDir();
  }

  snapshotLocations(): { name: string; dir: string }[] {
    return this.getFolders().map((s) => ({
      name: s.name,
      dir: s.store.snapshotsLocation(),
    }));
  }

  wouldDelete(absPath: string): boolean {
    return this.storeFor(absPath)?.wouldDelete(absPath) === true;
  }

  reconcileIgnored(): string[] {
    return this.getFolders().flatMap((s) => s.store.reconcileIgnored());
  }

  dispose(): void {
    this.disposed = true;
    this.folderListener.dispose();
    this.disposeSessions();
    this._onDidChange.dispose();
    this._onDidDetect.dispose();
    this._onDidSessionsChange.dispose();
    this._onDidDropIgnored.dispose();
  }

  // --- internals -----------------------------------------------------------

  private storeFor(absPath: string): ChangeStore | undefined {
    const owner = this.sessionForPath(absPath);
    if (owner) {
      return owner.store;
    }
    // Outside every folder: the first store that would accept it (trackOutside).
    return this.getFolders().find((s) => s.store.isInScope(absPath))?.store;
  }

  private fallbackStateDir(): string {
    return folderStateDir(this.context.globalStorageUri.fsPath, "_none");
  }

  private syncFolders(): void {
    if (this.disposed) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    let changed = false;
    for (const folder of folders) {
      const key = folderKey(folder.uri);
      seen.add(key);
      if (this.sessions.has(key)) {
        continue;
      }
      const session = new FolderSession(
        folder,
        this.context,
        this.log,
        this,
        () => this.confirmedIgnoreChange
      );
      this.sessions.set(key, session);
      session.attachToHub(this);
      changed = true;
    }
    for (const [key, session] of [...this.sessions]) {
      if (!seen.has(key)) {
        session.dispose();
        this.sessions.delete(key);
        changed = true;
      }
    }
    const roots = this.getFolders().map((s) => s.root);
    for (const session of this.getFolders()) {
      session.store.setPeerRoots(roots);
    }
    if (changed) {
      for (const session of this.getFolders()) {
        session.store.refreshFromDisk();
        session.syncDetectors();
      }
      this._onDidChange.fire(undefined);
      this._onDidSessionsChange.fire();
    }
  }

  private disposeSessions(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}

/**
 * Where this folder's review state lives: always under globalStorage, keyed by
 * the folder path, so the queue follows the repo rather than the window.
 *
 * Older builds used the per-workspace `storageUri` (unique to the `.code-workspace`
 * or the single-folder window) and a `workspaces/<key>` fallback. Those are
 * lifted once if the new location is empty.
 */
export function resolveFolderStateDir(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  log: (msg: string) => void
): string {
  const dest = folderStateDir(
    context.globalStorageUri.fsPath,
    folder.uri.fsPath
  );
  if (stateDirHasContent(dest)) {
    return dest;
  }
  const sources: string[] = [];
  const workspaceStorage = context.storageUri?.fsPath;
  if (workspaceStorage && shouldInheritWorkspaceStorage(folder)) {
    sources.push(workspaceStorage);
  }
  sources.push(
    legacyWorkspaceFallbackStateDir(
      context.globalStorageUri.fsPath,
      folder.uri.fsPath
    )
  );
  for (const src of sources) {
    if (src === dest || !stateDirHasContent(src)) {
      continue;
    }
    if (moveDir(src, dest)) {
      log(`moved review state: ${src} -> ${dest}`);
      return dest;
    }
    log(`could not move ${src} into ${dest}`);
  }
  return dest;
}

/**
 * Pre-1.3.0 only tracked `workspaceFolders[0]`, and wrote that queue into the
 * *window's* storage. That data belongs to the first folder of a multi-root
 * workspace, or to the only folder of a single-root one.
 */
function shouldInheritWorkspaceStorage(
  folder: vscode.WorkspaceFolder
): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return true;
  }
  return folders[0]?.uri.toString() === folder.uri.toString();
}

function watchHookSettings(
  folder: vscode.WorkspaceFolder,
  onChange: () => void
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, ".claude/settings*.json")
  );
  const listeners = [
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
  ];
  return {
    dispose() {
      for (const l of listeners) {
        l.dispose();
      }
      watcher.dispose();
    },
  };
}

function folderKey(uri: vscode.Uri): string {
  return uri.toString();
}

function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
