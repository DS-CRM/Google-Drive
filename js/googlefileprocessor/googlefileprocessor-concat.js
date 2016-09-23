// Copyright 2014 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


var googlefileprocessor = {};
googlefileprocessor.config = {};
googlefileprocessor.state = {};

googlefileprocessor.config.DRIVE_API_CONFIG_DATA = {
    'clientId': '824047626839-r7rhfck96ghg4nmiet4i9p8l8igumvrc.apps.googleusercontent.com',
    'appId': '824047626839',
    'scopes': ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.install'],
    'apiKey': 'AIzaSyCCp0hspUWoMSemCsaRNtGYb_dn-yPL5uI'
};


/**
 * Google Drive App.
 * Creates the presenter.
 * Exposes primary entry points from browser page/script load callbacks.
 * Requires:
 *   driveapi.AppConfig
 *   googlefileprocessor.presenter
 */

googlefileprocessor.App = function () {
    var appConfig = new driveapi.AppConfig(googlefileprocessor.config.DRIVE_API_CONFIG_DATA);

    this.presenter_ = new googlefileprocessor.Presenter(appConfig);
    this.presenter_.init();
};


/**
 * Handles when body onload() event is fired in the main HTML page.
 */
googlefileprocessor.App.prototype.onHtmlBodyLoaded = function () {
    this.presenter_.onHtmlBodyLoaded();
};


/**
 * Handles when the Google JS API has loaded.
 */
googlefileprocessor.App.prototype.onGapiClientLoaded = function () {
    this.presenter_.onGapiClientLoaded();
};


/**
 * Model for Google Drive.
 * 
 * Depends on:
 *   googlefileprocessor.util
 *   zip
 */


googlefileprocessor.Model = function () {
    this.filename_ = null;
    this.entryTree_ = null;
};

googlefileprocessor.Model.prototype.getFilename = function () {
    return this.filename_;
};


googlefileprocessor.Model.prototype.setFilename = function (filename) {
    if (this.filename_) {
        throw ('Existing model must be cleared before existing filename can be updated.');
    }
    this.filename_ = filename;
};


googlefileprocessor.Model.prototype.getEntryTree = function () {
    return this.entryTree_;
};


googlefileprocessor.Model.prototype.clear = function () {
    if (!(this.entryTree_ || this.filename_)) {
        throw ('No exisitng model to clear.');
    }

    this.filename_ = null;
    delete this.entryTree_;
};


/**
 * Asynchronously builds the entry tree (model), calls the specified callback when complete.
 */
googlefileprocessor.Model.prototype.build = function (entries, callback) {
    googlefileprocessor.util.execLater(
        googlefileprocessor.util.bindFn(this.buildInternal_, this, entries),
        callback);
};


/**
 * Synchronously builds the entry tree (model).
 */
googlefileprocessor.Model.prototype.buildInternal_ = function (entries) {
    if (this.entryTree_) {
        throw ('Existing model must be cleared before being built.');
    }

    var folderName = this.getFolderName_(this.filename_);

    this.entryTree_ = {
        'directory': true,
        'root': true,
        'name': folderName,
        'path': folderName,
        'children': {},
        'state': googlefileprocessor.state.SessionState.DEFAULT
    };

    for (var i = 0; i < entries.length; i++) {
        this.insertEntry_(this.entryTree_, entries[i]);
    }
};


googlefileprocessor.Model.prototype.insertEntry_ = function (rootEntry, entry) {
    // 'path' looks like dir1/dir2/file   {'directory'=false}
    // or                dir1/dir2/dir3/  {'directory'=true}

    var path = entry.filename;
    if (googlefileprocessor.util.endsWith(path, '/')) {
        path = path.substring(0, path.length - 1);
    }

    var pathItems = path.split('/');
    var currentEntry = rootEntry;
    var currentPath = null;

    for (var i = 0; i < pathItems.length; i++) {
        var currentPathItem = pathItems[i];
        if (currentPath === null) {
            currentPath = currentPathItem;
        } else {
            currentPath = currentPath + '/' + currentPathItem;
        }

        var nextEntry = currentEntry.children[currentPathItem];

        if (!nextEntry) {
            // If it's not a final item, or;
            // it is a final item AND a directory, then:
            // Add it as a directory and continue.
            if ((i < pathItems.length - 1) || entry.directory) {
                nextEntry = {};
                nextEntry.directory = true;
                nextEntry.children = {};
            } else {
                // It's a leaf node file. Add it as a file. Use the actual entry.
                nextEntry = entry;
            }

            nextEntry.state = googlefileprocessor.state.EntryState.DEFAULT;
            nextEntry.path = currentPath;
            nextEntry.name = currentPathItem;
            nextEntry.parentEntry = currentEntry;
            currentEntry.children[currentPathItem] = nextEntry;
        } else {
            // Entry already exists, continue another level deeper.
        }

        currentEntry = nextEntry;
    }
};

googlefileprocessor.Model.prototype.getFolderName_ = function (filename) {
    return googlefileprocessor.util.trimFileExtension(filename);
};



/**
 * Google Drive Presenter. Controls flow of the app, updates the view.
 * 
 * Depends on: 
 *   googlefileprocessor.state.SessionState
 *   googlefileprocessor.util
 *   googlefileprocessor.Model
 *   googlefileprocessor.View
 *   driveapi.AuthManager
 *   driveapi.UrilStateParser
 *   driveApi.FileManager
 */

googlefileprocessor.Presenter = function (appConfig) {
    this.appConfig_ = appConfig;

    this.model_ = new googlefileprocessor.Model();
    this.urlStateParser_ = new driveapi.UrlStateParser();
    this.authManager_ = new driveapi.AuthManager(appConfig);
    this.fileManager_ = new driveapi.FileManager(this.authManager_);

    var uploadManager = new googlefileprocessor.util.UploadManager(appConfig, this.authManager_);
    var pickerManager = new googlefileprocessor.util.PickerManager(appConfig, this.authManager_);
    this.view_ = new googlefileprocessor.View(this, pickerManager, uploadManager);

    this.state_ = googlefileprocessor.state.SessionState.DEFAULT;

    this.htmlBodyLoaded_ = false;
    this.apiLoaded_ = false;
    this.sharingLoaded_ = false;
    this.currentSession_ = null;

    this.hasDownloadBeenAutoRetried_ = false;
    this.lastDownloadId_ = null;
};


/**
 * Flag indicating whether the app is in DEBUG mode. If set, authorization will be skipped,
 * and the app will have limited local functionality for ZIP processing, download, etc. 
 */
googlefileprocessor.Presenter.IS_DEBUG_ = false;


/**
 * Handles when body onload() event is fired in the main HTML page.
 */
googlefileprocessor.Presenter.prototype.onHtmlBodyLoaded = function () {
    this.htmlBodyLoaded_ = true;
    this.view_.init();

    if (!this.checkBrowser_()) {
        this.setState_(googlefileprocessor.state.SessionState.UNSUPPORTED_BROWSER);
        return;
    }

    this.parseUrlState_();

    if (this.apiLoaded_) {
        this.authorize_(true /* isInvokedByApp */);
    }

    if (googlefileprocessor.Presenter.IS_DEBUG_) {
        this.processRequestFromState_();
    }
};


/**
 * Handles when the Google JS API has loaded.
 */
googlefileprocessor.Presenter.prototype.onGapiClientLoaded = function () {
    if (!this.checkBrowser_()) {
        this.setState_(googlefileprocessor.state.SessionState.UNSUPPORTED_BROWSER);
        return;
    }

    this.apiLoaded_ = true;
    this.setState_(googlefileprocessor.state.SessionState.API_LOADED);

    this.parseUrlState_();

    if (this.htmlBodyLoaded_) {
        this.authorize_(true /* isInvokedByApp */);
    }

    // Load sharing widget.
    gapi.load('drive-share', googlefileprocessor.util.bindFn(this.sharingLoadComplete_, this));
};


googlefileprocessor.Presenter.prototype.parseUrlState_ = function () {
    if (!this.urlStateParser_.isParsed()) {
        this.setState_(googlefileprocessor.state.SessionState.READ_URL_STATE);
        this.urlStateParser_.parseState();
    }
};


googlefileprocessor.Presenter.prototype.sharingLoadComplete_ = function () {
    this.sharingLoaded_ = true;
};


// TODO: Should this be in the view?
googlefileprocessor.Presenter.prototype.showSharingDialog_ = function (id) {
    var sharingDialog = new gapi.drive.share.ShareClient(this.appConfig_.getAppId());
    sharingDialog.setItemIds([id]);
    sharingDialog.showSettingsDialog();
};

googlefileprocessor.Presenter.prototype.checkBrowser_ = function () {
    var isIE = googlefileprocessor.util.isIE();
    return !isIE || (isIE && !(isIE <= 9));
};


googlefileprocessor.Presenter.prototype.init = function () {
    // First initialization of the view.
    // TODO: This may be redundant with construction.
    this.setState_(googlefileprocessor.state.SessionState.INIT);
};


googlefileprocessor.Presenter.prototype.updateEntryState = function (entry, newState) {
    var oldState = entry.state;
    entry.state = newState;
    this.view_.updateEntryState(entry, newState, oldState);
};


googlefileprocessor.Presenter.prototype.setState_ = function (newState, opt_data) {
    var oldState = this.state_;
    this.state_ = newState;
    this.view_.updateState(newState, oldState, opt_data);
};


googlefileprocessor.Presenter.prototype.authorize_ = function (isInvokedByApp) {
    if (googlefileprocessor.Presenter.IS_DEBUG_) {
        return;
    }

    var state = isInvokedByApp ?
        googlefileprocessor.state.SessionState.AUTH_PENDING_AUTO :
        googlefileprocessor.state.SessionState.AUTH_PENDING_USER;
    this.setState_(state);

    this.authManager_.authorize(
        isInvokedByApp,
        googlefileprocessor.util.bindFn(this.handleAuthResult_, this),
        this.urlStateParser_.getUserId());
};


googlefileprocessor.Presenter.prototype.handleAuthResult_ = function (authResult) {
    if (authResult) {
        if (authResult.error) {
            this.setState_(googlefileprocessor.state.SessionState.AUTH_ERROR, authResult.error);
        } else {
            this.setState_(googlefileprocessor.state.SessionState.AUTH_SUCCESS);
            this.processRequestFromState_();
        }
    } else {
        this.setState_(googlefileprocessor.state.SessionState.AUTH_REQUIRED);
    }
};


googlefileprocessor.Presenter.prototype.processRequestFromState_ = function () {
    this.setState_(googlefileprocessor.state.SessionState.READ_URL_STATE);
    this.urlStateParser_.parseState();

    if (this.urlStateParser_.isForOpen()) {
        // Download the file, read the ZIP, update UI.
        this.downloadFileById_(this.urlStateParser_.getFileId());
    } else {
        // Create New scenario, launched in zero state; setup new session UI.
        this.startNewSession_();
    }
};


googlefileprocessor.Presenter.prototype.startNewSession_ = function () {
    this.view_.updatePageTitle();
    this.setState_(googlefileprocessor.state.SessionState.NEW_SESSION);
};


googlefileprocessor.Presenter.prototype.downloadFileById_ = function (id) {
    // Store the most recent download ID to support retry.
    this.lastDownloadId_ = id;

    this.setState_(googlefileprocessor.state.SessionState.DOWNLOADING_METADATA);
    var callbacks = this.fileManager_.generateCallbacks(
        googlefileprocessor.util.bindFn(this.downloadFile_, this),
        googlefileprocessor.util.bindFn(this.onDownloadError_, this),
        undefined /* progressCallback */,
        googlefileprocessor.util.bindFn(this.onDownloadAborted_, this));

    this.fileManager_.get(id, callbacks);
};


googlefileprocessor.Presenter.prototype.downloadFile_ = function (file) {
    this.setState_(googlefileprocessor.state.SessionState.DOWNLOADING, file);
    var callbacks = this.fileManager_.generateCallbacks(
        googlefileprocessor.util.bindFn(this.onDownloadSuccess_, this),
        googlefileprocessor.util.bindFn(this.onDownloadError_, this),
        googlefileprocessor.util.bindFn(this.onDownloadProgress_, this),
        googlefileprocessor.util.bindFn(this.onDownloadAborted_, this));

    this.fileManager_.downloadFile(file, callbacks);
};


googlefileprocessor.Presenter.prototype.onDownloadSuccess_ = function (file, blob) {
    this.setState_(googlefileprocessor.state.SessionState.DOWNLOADED);
    this.createSession_(file);
    this.initModel_(file, blob);
};


googlefileprocessor.Presenter.prototype.onDownloadError_ = function (error, message) {
    // Auto-retry download once, including for both auth and transient errors.
    if (!this.hasDownloadBeenAutoRetried_) {
        this.hasDownloadBeenAutoRetried_ = true;

        // Check for auth error. Attempt re-auth in the background, then retry download.
        if (error == driveapi.FileManager.ErrorType.AUTH_ERROR) {
            this.setState_(googlefileprocessor.state.SessionState.AUTH_PENDING_AUTO);
            this.authManager_.authorize(
                true /* isInvokedByApp */,
                googlefileprocessor.util.bindFn(this.downloadFileById_, this, this.lastDownloadId_));
        } else {
            this.downloadFileById_(this.lastDownloadId_);
        }
    } else {
        this.setState_(googlefileprocessor.state.SessionState.DOWNLOAD_ERROR, message);
    }
};


googlefileprocessor.Presenter.prototype.onDownloadProgress_ = function (current, total) {
    // Don't show latent progress events that come in after download has been cancelled.
    if (this.state_ == googlefileprocessor.state.SessionState.DOWNLOAD_CANCELED) {
        return;
    }

    this.view_.handleDownloadProgress(current, total);

    if (current === total) {
        this.setState_(googlefileprocessor.state.SessionState.DOWNLOAD_ALL_BYTES_TRANSFERRED);
    }
};


googlefileprocessor.Presenter.prototype.onDownloadAborted_ = function () {
    this.handleDownloadCanceled_();
};


googlefileprocessor.Presenter.prototype.handleDownloadCanceled_ = function () {
    this.setState_(googlefileprocessor.state.SessionState.DOWNLOAD_CANCELED);
};


googlefileprocessor.Presenter.prototype.initModel_ = function (filename, blob) {
    this.view_.updatePageTitle(filename.title);
    this.setState_(googlefileprocessor.state.SessionState.DOWNLOADED);
    this.model_.setFilename(filename.title);

    this.openDownload_(filename.webContentLink);
};

googlefileprocessor.Presenter.prototype.openDownload_ = function (filelink) {
    this.view_.openDownloadButton.setAttribute("href", filelink);
    this.view_.openDownloadButton.click();
    //window.open(filelink, '_blank', 'height=10px,left=0px,location=0,menubar=0,resizable=0,scrollbars=0,status=0,titlebar=0,toolbar=0,top=0px,width=10px', true);
};

googlefileprocessor.Presenter.prototype.createSession_ = function (opt_file) {
    this.currentSession_ = new googlefileprocessor.Session(
        this.urlStateParser_.getFolderId(), /* parentId */
        this,
        this.model_,
        this.view_,
        this.fileManager_);

    if (opt_file) {
        this.currentSession_.updateParentIdByFile(opt_file);
    }
};

googlefileprocessor.Presenter.prototype.reset_ = function () {
    if (this.currentSession_) {
        this.currentSession_.close();
        this.currentSession_ = null;
        this.model_.clear();
    }
    this.lastDownloadId_ = null;
    this.hasDownloadBeenAutoRetried_ = false;
};


googlefileprocessor.Presenter.prototype.VIEW__authRequested = function () {
    this.authorize_(false /* isInvokedByApp */);
};


googlefileprocessor.Presenter.prototype.VIEW__driveFileChosen = function (partialFile) {
    // File as returned from Picker is not a complete Drive File resource.
    // Must get full metadata to retrieve download URL.
    this.downloadFileById_(partialFile.id);
};


googlefileprocessor.Presenter.prototype.VIEW__driveFolderChosen = function (folder) {
    this.currentSession_.setParentId(folder.id);
    this.view_.updateDestinationFolderUi(folder);
};


googlefileprocessor.Presenter.prototype.VIEW__localBlobChosen = function (filename, blob) {
    this.createSession_(undefined /* opt_file */);
    this.initModel_(filename, blob);
};


googlefileprocessor.Presenter.prototype.VIEW__cancelSession = function () {
    this.setState_(googlefileprocessor.state.SessionState.SESSION_CANCELED);
    this.reset_();
    this.startNewSession_();
};


googlefileprocessor.Presenter.prototype.VIEW__reset = function () {
    this.reset_();
    this.startNewSession_();
};



googlefileprocessor.Presenter.prototype.VIEW__retryDownload = function () {
    this.hasDownloadBeenAutoRetried_ = false;
    this.downloadFileById_(this.lastDownloadId_);
};


googlefileprocessor.Presenter.prototype.VIEW__downloadBrowser = function (browser) {
    var browserUrl = null;
    switch (browser) {
        case 'chrome':
            browserUrl = 'http://www.google.com/chrome';
            break;

        case 'firefox':
            browserUrl = 'http://www.mozilla.org/en-US/firefox/new/';
            break;

        case 'ie':
            browserUrl = 'http://windows.microsoft.com/en-us/internet-explorer/download-ie';
            break;
    }

    if (browserUrl) {
        var browserDownloadWindow = window.open(browserUrl, '_blank');
        browserDownloadWindow.focus();
    }
};


googlefileprocessor.Presenter.prototype.VIEW__cancelDownload = function () {
    this.setState_(googlefileprocessor.state.SessionState.CANCEL_DOWNLOAD_REQUESTED);
    this.fileManager_.abortDownload();
};


googlefileprocessor.Presenter.prototype.getNewParentId_ = function () {
    // Get the 'folder' attribute on the root node of the entry tree.
    var entryTree = this.model_.getEntryTree();
    if (entryTree && entryTree.folder) {
        return entryTree.folder.id;
    } else if (this.currentSession_ && this.currentSession_.getParentId()) {
        return this.currentSession_.getParentId();
    } else {
        return null;
    }
};


/**
 * Session for Google Drive. Extension of the presenter.
 * Executes the model when requested.
 * 
 * Depends on:
 *   zip
 *   googlefileprocessor.Model
 *   googlefileprocessor.Presenter
 *   googlefileprocessor.View
 *   driveapi.FileManager
 */

googlefileprocessor.Session = function (parentId, presenter, model, view, fileManager) {
    this.parentId_ = parentId;
    this.presenter_ = presenter;
    this.model_ = model;
    this.view_ = view;
    this.workQueue_ = new googlefileprocessor.util.AsyncWorkQueue(googlefileprocessor.Session.MAX_WORKQUEUE_WORKERS_);
    this.fileManager_ = fileManager;

    this.entryStateMap_ = {};
    this.entriesInProcessMap_ = {};

    this.totalSessionSize_ = 0;
    this.currentSessionProgress_ = 0;

    this.isClosed_ = false;
    this.isAborted_ = false;
    this.hasBeenRetried_ = false;
};

// TODO: Consider compatibility mode.
googlefileprocessor.Session.MAX_WORKQUEUE_WORKERS_ = 2;

googlefileprocessor.Session.TRANSFER_DECOMPRESS_MULTIPLIER_ = 3;
googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_ = 20000;


/**
 * Sets the current session parent ID to the ID of the first parent
 * on the specified file.
 */
googlefileprocessor.Session.prototype.updateParentIdByFile = function (file) {
    var parents = file.parents;
    if (parents && parents.length > 0) {
        var parent = parents[0];
        if (parent && parent.id) {
            this.parentId_ = parent.id;
        }
    }
};


googlefileprocessor.Session.prototype.getParentId = function () {
    return this.parentId_;
};


googlefileprocessor.Session.prototype.setParentId = function (parentId) {
    this.parentId_ = parentId;
};


googlefileprocessor.Session.prototype.abort = function () {
    this.isAborted_ = true;
    this.workQueue_.stop();
    this.fileManager_.abortAllRequests();
    this.cancelAllUnstartedEntries_();
};


googlefileprocessor.Session.prototype.close = function () {
    if (this.isClosed_) {
        throw ('Error: Cannot close an already closed session.');
    }

    this.model_ = null;
    this.parentId_ = null;
    delete this.workQueue_;
    this.entryStateMap_ = {};
    this.entriesInProcessMap_ = {};
    this.fileManager_ = null;
    this.totalSessionSize_ = 0;
    this.currentSessionProgress_ = 0;

    this.isClosed_ = true;
};


googlefileprocessor.Session.prototype.hasBeenRetried = function () {
    return this.hasBeenRetried_;
};


googlefileprocessor.Session.prototype.hasErrors = function () {
    var rootEntry = this.model_.getEntryTree();
    if (this.isErrorState_(rootEntry.state)) {
        return true;
    } else {
        return this.childEntriesHaveErrors_(rootEntry);
    }
};


googlefileprocessor.Session.prototype.childEntriesHaveErrors_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];
        if (this.isErrorState_(childEntry.state)) {
            return true;
        } else if (childEntry.directory && this.childEntriesHaveErrors_(childEntry)) {
            return true;
        }
    }
    return false;
};


googlefileprocessor.Session.prototype.hasAuthErrors = function () {
    var rootEntry = this.model_.getEntryTree();
    if (this.entryHasAuthError_(rootEntry)) {
        return true;
    } else {
        return this.childEntriesHaveAuthErrors_(rootEntry);
    }
};


googlefileprocessor.Session.prototype.childEntriesHaveAuthErrors_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];
        if (this.entryHasAuthError_(childEntry)) {
            return true;
        } else if (childEntry.directory && this.childEntriesHaveAuthErrors_(childEntry)) {
            return true;
        }
    }
    return false;
};


googlefileprocessor.Session.prototype.entryHasAuthError_ = function (entry) {
    return (entry.uploadError == driveapi.FileManager.ErrorType.AUTH_ERROR) &&
        (entry.state == googlefileprocessor.state.EntryState.UPLOAD_ERROR);
};


googlefileprocessor.Session.prototype.execute = function (isForRetry) {
    if (this.isClosed_) {
        throw ('Error: Cannot execute a closed session.');
    }

    if (isForRetry) {
        this.hasBeenRetried_ = true;
    }

    var rootEntry = this.model_.getEntryTree();

    // QUEUE or SKIP entries as determined by check state.
    this.queueEntry_(rootEntry);
    this.queueEntryChildren_(rootEntry);

    this.currentSessionProgress_ = 0;
    this.totalSessionSize_ = this.computeSessionSize_(rootEntry);

    if (this.isUploadableState_(rootEntry.state)) {
        // First create the new parent into which the ZIP file contents will be extracted.
        this.workQueue_.enqueue(this.generateWorkItem_(rootEntry, this.parentId_));
        this.updateEntryState_(rootEntry, googlefileprocessor.state.EntryState.PENDING);

        // Run this first parent folder creation immediately. Callbacks will upload children.
        // No children can be uploaded until the root folder is first created.
        this.runWorkQueue_();
    } else {
        // Root folder skipped; process children.
        this.processEntryTreeChildren_(rootEntry, this.parentId_, isForRetry);
    }
};


googlefileprocessor.Session.prototype.processEntryTreeChildren_ = function (entryTree, parentId, isForRetry) {
    // Queue work items (uploads) depth-first in the entry tree.
    for (var entryKey in entryTree.children) {
        var entry = entryTree.children[entryKey];

        if (this.isAborted_) {
            this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
        } else {
            if (this.isUploadableState_(entry.state)) {
                this.workQueue_.enqueue(this.generateWorkItem_(entry, parentId));
                this.updateEntryState_(entry, googlefileprocessor.state.EntryState.PENDING);
            } else if (!!isForRetry && entry.directory && entry.state == googlefileprocessor.state.EntryState.UPLOAD_COMPLETE) {
                // If an item is a directory, and it's already been uploaded, but this is for retry,
                // failed child items may exist. Process recursively without uploading the current entry.
                // The parent ID for children is this entry's associated drive ID.
                this.processEntryTreeChildren_(entry, entry.folder.id, isForRetry);
            }
        }
    }

    if (!this.isAborted_) {
        this.runWorkQueue_();
    }
};


googlefileprocessor.Session.prototype.computeSessionSize_ = function (rootEntry) {
    return this.getEntrySize_(rootEntry) + this.computeChildEntrySize_(rootEntry);
};


googlefileprocessor.Session.prototype.computeChildEntrySize_ = function (entry) {
    var cumulativeSize = 0;
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];

        var currentSize = this.getEntrySize_(childEntry);
        var childrenSize = childEntry.directory ? this.computeChildEntrySize_(childEntry) : 0;
        cumulativeSize += currentSize + childrenSize;
    }
    return cumulativeSize;
};


googlefileprocessor.Session.prototype.getEntrySize_ = function (entry) {
    if (!this.isUploadableState_(entry.state)) {
        return 0;
    } else {
        // uncompressed + N * compressed + session overhead bytes
        var fileSize = entry.directory ?
            0 :
            (entry.compressedSize + googlefileprocessor.Session.TRANSFER_DECOMPRESS_MULTIPLIER_ * entry.uncompressedSize);

        return fileSize + googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_;
    }
};


googlefileprocessor.Session.prototype.queueEntry_ = function (entry) {
    // Only queue entries that are in their default (initialized) state.
    // Leave other states alone, so concurrent calls of execute() result in retry.
    if (entry.state == googlefileprocessor.state.EntryState.DEFAULT) {
        var targetState = this.view_.isSelected(entry) ?
            googlefileprocessor.state.EntryState.QUEUED :
            googlefileprocessor.state.EntryState.SKIPPED;

        this.updateEntryState_(entry, targetState);
    }
};


googlefileprocessor.Session.prototype.queueEntryChildren_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];
        this.queueEntry_(childEntry);
        if (childEntry.directory) {
            this.queueEntryChildren_(childEntry);
        }
    }
};


googlefileprocessor.Session.prototype.cancelAllUnstartedEntries_ = function () {
    var rootEntry = this.model_.getEntryTree();
    this.cancelUnstartedEntry_(rootEntry);
    this.cancelUnstartedChildEntries_(rootEntry);
};


googlefileprocessor.Session.prototype.cancelUnstartedEntry_ = function (entry) {
    // Here, in-progress uploads will be aborted, other files will be canceled; don't cancel
    // 'finishing' or 'uploading' states.
    if (!this.isTerminalState_(entry.state) && !this.isInProgressState_(entry.state)) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
    }
};


googlefileprocessor.Session.prototype.cancelUnstartedChildEntries_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];
        this.cancelUnstartedEntry_(childEntry);
        if (childEntry.directory) {
            this.cancelUnstartedChildEntries_(childEntry);
        }
    }
};


googlefileprocessor.Session.prototype.runWorkQueue_ = function () {
    this.workQueue_.run(googlefileprocessor.util.bindFn(this.workQueueExecutionComplete_, this));
};


googlefileprocessor.Session.prototype.updateEntryState_ = function (entry, newState) {
    this.updateEntryStateMap_(entry, newState);
    this.presenter_.updateEntryState(entry, newState);
};


googlefileprocessor.Session.prototype.incrementSessionProgress_ = function (entry, increment) {
    if (this.isAborted_) {
        return;
    }

    this.currentSessionProgress_ += increment;
    this.view_.handleSessionProgress(this.currentSessionProgress_, this.totalSessionSize_);
};


googlefileprocessor.Session.prototype.updateEntryStateMap_ = function (entry, newState) {
    var oldState = entry.state;
    var path = entry.path;

    // Add entry to the map for the new state.
    var entryMapForNewState = this.entryStateMap_[newState];
    if (!entryMapForNewState) {
        entryMapForNewState = {};
        this.entryStateMap_[newState] = entryMapForNewState;
    }
    entryMapForNewState[path] = entry;

    // Remove entry from the map of the old state.
    var entryMapForOldState = this.entryStateMap_[oldState];
    if (entryMapForOldState) {
        if (entryMapForOldState.hasOwnProperty(path)) {
            delete entryMapForOldState[path];
        }
    }

    if (this.isTerminalState_(newState)) {
        delete this.entriesInProcessMap_[path];
    } else {
        this.entriesInProcessMap_[path] = entry;
    }
};


googlefileprocessor.Session.prototype.areAllStatesTerminal_ = function () {
    return Object.keys(this.entriesInProcessMap_).length === 0;
};


googlefileprocessor.Session.prototype.isTerminalState_ = function (state) {
    return state == googlefileprocessor.state.EntryState.UPLOAD_COMPLETE ||
        state == googlefileprocessor.state.EntryState.UPLOAD_ERROR ||
        state == googlefileprocessor.state.EntryState.SKIPPED ||
        state == googlefileprocessor.state.EntryState.CANCELED ||
        state == googlefileprocessor.state.EntryState.QUEUED_PENDING_RETRY ||
        state == googlefileprocessor.state.EntryState.UPLOAD_ABORTED;
};


googlefileprocessor.Session.prototype.isUploadableState_ = function (state) {
    return state == googlefileprocessor.state.EntryState.QUEUED ||
        state == googlefileprocessor.state.EntryState.QUEUED_PENDING_RETRY ||
        state == googlefileprocessor.state.EntryState.UPLOAD_ERROR;
};


googlefileprocessor.Session.prototype.isErrorState_ = function (state) {
    return state == googlefileprocessor.state.EntryState.UPLOAD_ERROR ||
        state == googlefileprocessor.state.EntryState.DECOMPRESSION_ERROR;
};


googlefileprocessor.Session.prototype.isInProgressState_ = function (state) {
    return state == googlefileprocessor.state.EntryState.BEGIN_UPLOAD ||
        state == googlefileprocessor.state.EntryState.UPLOAD_PROGRESS ||
        state == googlefileprocessor.state.EntryState.UPLOAD_ALL_BYTES_TRANSFERRED;
};


googlefileprocessor.Session.prototype.generateWorkItem_ = function (entry, parentId) {
    entry.parentId = parentId;
    var method = entry.directory ? this.processFolder_ : this.processFile_;
    return googlefileprocessor.util.bindFn(method, this, entry, parentId);
};


googlefileprocessor.Session.prototype.processFolder_ = function (entry, parentId, workerCompleteCallback) {
    // Insert the folder, process state updates when done, then recurse to resume process of the
    // children.
    if (this.isAborted_) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
        return;
    }

    // Reset any previous progress values.
    entry.uploadPrev = 0;
    entry.uploadCurrent = 0;
    entry.uploadTotal = 0;

    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.BEGIN_UPLOAD);

    var callbacks = this.fileManager_.generateCallbacks(
        googlefileprocessor.util.bindFn(
            this.folderInsertComplete_,
            this,
            entry,
            workerCompleteCallback,
            googlefileprocessor.util.bindFn(this.processEntryTreeChildren_, this, entry)),
        googlefileprocessor.util.bindFn(this.folderInsertError_, this, entry, workerCompleteCallback),
        undefined /* progressCallback */,
        googlefileprocessor.util.bindFn(this.folderInsertAborted_, this, entry, workerCompleteCallback));

    this.fileManager_.insertFolder(entry.name, parentId, callbacks);
};


googlefileprocessor.Session.prototype.processFile_ = function (entry, parentId, workerCompleteCallback) {
    if (this.isAborted_) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
        return;
    }

    // Reset any previous progrss values.
    entry.decompressionPrev = 0;
    entry.decompressionCurrent = 0;
    entry.decompressionTotal = 0;
    entry.uploadPrev = 0;
    entry.uploadCurrent = 0;
    entry.uploadTotal = 0;

    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.BEGIN_DECOMPRESSION);

    // TODO: Consider separating decompression from ZIP upload.
    // TODO: Deal with decompression errors in getData(), e.g., via try/catch.

    // Decompress the blob, upload the blob, process state updates when done.
    entry.getData(
        new zip.BlobWriter(),
        googlefileprocessor.util.bindFn(this.decompressionComplete_, this, entry, parentId, workerCompleteCallback),
        googlefileprocessor.util.bindFn(this.handleDecompressionProgress_, this, entry),
        true /* checkCrc32 */);
};


googlefileprocessor.Session.prototype.handleDecompressionProgress_ = function (entry, current, total) {
    if (this.isAborted_) {
        return;
    }

    entry.decompressionPrev = entry.decompressionCurrent ? entry.decompressionCurrent : 0;
    entry.decompressionCurrent = current;
    entry.decompressionTotal = total;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.DECOMPRESSION_PROGRESS);

    var progressStep = entry.decompressionCurrent - entry.decompressionPrev;
    this.incrementSessionProgress_(entry, progressStep);
};


googlefileprocessor.Session.prototype.decompressionComplete_ = function (entry, parentId, workerCompleteCallback, blob) {
    if (this.isAborted_) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
        return;
    }

    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.DECOMPRESSION_COMPLETE);
    this.uploadFile_(entry, parentId, blob, workerCompleteCallback);
};


googlefileprocessor.Session.prototype.uploadFile_ = function (entry, parentId, blob, workerCompleteCallback) {
    if (this.isAborted_) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.CANCELED);
        return;
    }

    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.BEGIN_UPLOAD);

    var callbacks = this.fileManager_.generateCallbacks(
        googlefileprocessor.util.bindFn(this.fileUploadComplete_, this, entry, workerCompleteCallback),
        googlefileprocessor.util.bindFn(this.fileUploadError_, this, entry, workerCompleteCallback),
        googlefileprocessor.util.bindFn(this.fileUploadProgress_, this, entry),
        googlefileprocessor.util.bindFn(this.fileUploadAborted_, this, entry, workerCompleteCallback));

    this.fileManager_.insertBlob(blob, entry.name, parentId, callbacks);
};


googlefileprocessor.Session.prototype.fileUploadComplete_ = function (entry, workerCompleteCallback, uploadedFile) {
    entry.file = uploadedFile;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_COMPLETE);
    this.view_.updateUiForFileComplete(entry, uploadedFile.alternateLink, uploadedFile.iconLink);
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    // Worker complete callback to be done only after all state updates have been performed.
    // Worker complete may trigger 'session done' which performs actions that are dependent on state.
    workerCompleteCallback();

    if (this.isAborted_) {
        this.checkForExtractionComplete_();
    }
};


googlefileprocessor.Session.prototype.fileUploadError_ = function (entry, workerCompleteCallback, error, message) {
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    entry.uploadError = error;
    entry.message = message;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_ERROR, error);
    workerCompleteCallback();
};


googlefileprocessor.Session.prototype.fileUploadAborted_ = function (entry, workerCompleteCallback, message) {
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    entry.aborted = true;
    entry.message = message;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_ABORTED, message);
    workerCompleteCallback();
};


googlefileprocessor.Session.prototype.fileUploadProgress_ = function (entry, current, total) {
    if (this.isAborted_) {
        return;
    }

    entry.uploadPrev = entry.uploadCurrent ? entry.uploadCurrent : 0;
    entry.uploadCurrent = current;
    entry.uploadTotal = total;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_PROGRESS);

    if (current === total) {
        this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_ALL_BYTES_TRANSFERRED);
    }

    // Account for actual XHR overhead of content exceeding binary content size due to
    // protocol overhead.
    var progressStepRaw = entry.uploadCurrent - entry.uploadPrev;
    var progressStepNormalized = (entry.uncompressedSize / total) * progressStepRaw;
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.TRANSFER_DECOMPRESS_MULTIPLIER_ * progressStepNormalized);
};


googlefileprocessor.Session.prototype.folderInsertComplete_ = function (entry, workerCompleteCallback, resultCallback, createdFolder) {
    entry.folder = createdFolder;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_COMPLETE);
    this.view_.updateUiForFileComplete(entry, googlefileprocessor.util.createDriveFolderLink(createdFolder.id));
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    resultCallback(createdFolder.id);

    workerCompleteCallback();

    if (this.isAborted_) {
        this.checkForExtractionComplete_();
    }
};


googlefileprocessor.Session.prototype.folderInsertError_ = function (entry, workerCompleteCallback, error, message) {
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    entry.uploadError = error;
    entry.message = message;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_ERROR, message);

    // If a folder had an error, put all child items in a "Queued pending error" state
    // such that they will be uploaded on a retry, unless they were skipped by the user.
    this.setAllChildEntriesQueuedPendingRetry_(entry);

    workerCompleteCallback();

};


googlefileprocessor.Session.prototype.folderInsertAborted_ = function (entry, workerCompleteCallback, message) {
    this.incrementSessionProgress_(entry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

    entry.aborted = true;
    entry.message = message;
    this.updateEntryState_(entry, googlefileprocessor.state.EntryState.UPLOAD_ABORTED, message);

    // If a folder was aborted an error, cancel all child items.
    this.cancelAllChildEntries_(entry);

    workerCompleteCallback();

};


googlefileprocessor.Session.prototype.cancelAllChildEntries_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];
        this.updateEntryState_(childEntry, googlefileprocessor.state.EntryState.CANCELED);
        if (childEntry.directory) {
            this.cancelAllChildEntries_(childEntry);
        }
    }
};


googlefileprocessor.Session.prototype.setAllChildEntriesQueuedPendingRetry_ = function (entry) {
    for (var entryKey in entry.children) {
        var childEntry = entry.children[entryKey];

        if (childEntry.state != googlefileprocessor.state.EntryState.SKIPPED) {
            this.updateEntryState_(childEntry, googlefileprocessor.state.EntryState.QUEUED_PENDING_RETRY);
            this.incrementSessionProgress_(childEntry, googlefileprocessor.Session.ENTRY_OVERHEAD_BYTES_);

            if (childEntry.directory) {
                this.setAllChildEntriesQueuedPendingRetry_(childEntry);
            }
        }
    }
};


googlefileprocessor.Session.prototype.workQueueExecutionComplete_ = function () {

};


googlefileprocessor.Session.prototype.checkForExtractionComplete_ = function () {
    if (this.areAllStatesTerminal_()) {
        if (this.isAborted_) {
            return false;
        } else {
            return true;
        }
    }
};


/**
 * State enums for Google Drive.
 */


/**
 * States for the overall session state.
 */
googlefileprocessor.state.SessionState = {
    DEFAULT: 'default', // initial uninitialized state.
    INIT: 'init', // After presenter has been created
    UNSUPPORTED_BROWSER: 'unsupportedBrowser', // User's browser is not supporteds
    NEW_SESSION: 'newSession', // app launched zero-state
    APP_CREATE: 'appCreate', // While the app is being instantiated.
    APP_CREATED: 'appCreated', // Once the app is instantiated.
    APP_INIT: 'appInit', // While the app is initializing (auth not yet invoked)
    AUTH_PENDING_AUTO: 'authPendingAuto', // Automatic ('immediate') auth call was made at app startup.
    AUTH_PENDING_USER: 'authPendingUser', // User-initiated (non-'immediate') auth call was made as a result of clicking "AUTHORIZE".
    AUTH_REQUIRED: 'authRequired', // when auth call has returned, but auth is still required.
    AUTH_SUCCESS: 'authSuccess', // when auth call has returned, and the client is authorized.
    AUTH_ERROR: 'authError', // when auth call has returned when an error
    DOWNLOADING: 'downloading', // download blob from web
    DOWNLOADING_METADATA: 'downloadingMetadata', // download metadata for a file from the web
    CANCEL_DOWNLOAD_REQUESTED: 'cancelDownloadRequested', // When the user has requested to cancel the download.
    DOWNLOAD_CANCELED: 'downloadCanceled', // When the download has successfully been canceled.
    DOWNLOAD_ALL_BYTES_TRANSFERRED: 'downloadAllBytesTransferred', // when all download data has been received,
    DOWNLOADED: 'downloaded', // successful download of blob from Drive
    DOWNLOAD_ERROR: 'downloadError', // error when downloading blob from Drive
    MODEL_BUILDING: 'modelBuilding', // when building the model.
    MODEL_BUILT: 'modelBuilt', // when building the model.    
    READ_URL_STATE: 'readUrlState', // When reading the URL state.
    API_LOADED: 'apiLoaded', // When the API script has completed loading.
    PENDING_USER_INPUT: 'pendingUserInput', // waiting on UI, pending session
    SESSION_CANCELED: 'sessionCanceled', // the user canceled the session before it began.        
    COMPLETE_WITH_ERRORS: 'completeWithErrors' // session complete
};


/**
 * States for individual file processing state.
 */
googlefileprocessor.state.EntryState = {
    DEFAULT: 'default',
    QUEUED: 'queued', // Item has been placed into the upload queue
    QUEUED_PENDING_RETRY: 'queuedPendingRetry', // Item is queued for upload, pending resolution of error in an ancestor.
    SKIPPED: 'skipped',
    PENDING: 'pending', // Parent has been created, in the current batch
    WAITING: 'waiting', // Upload has begun, item is waiting to be processed
    CANCELED: 'canceled', // Upload was canceled.
    BEGIN_DECOMPRESSION: 'beginDecompression',
    DECOMPRESSION_PROGRESS: 'decompressionProgress',
    DECOMPRESSION_COMPLETE: 'decompressionComplete',
    DECOMPRESSION_ERROR: 'decompressionError',
    BEGIN_UPLOAD: 'beginUpload',
    UPLOAD_PROGRESS: 'uploadProgress',
    UPLOAD_ERROR: 'uploadError',
    UPLOAD_ALL_BYTES_TRANSFERRED: 'uploadAllBytesTransferred',
    UPLOAD_COMPLETE: 'uploadComplete',
    UPLOAD_ABORTED: 'uploadAborted'
};



/**
 * UI Table for Google Drive.
 * 
 * Depends on:
 *   googlefileprocessor.util
 */

googlefileprocessor.Table = function (tableEl) {
    this.tableEl_ = tableEl;
    this.rootEntry_ = null;
};


googlefileprocessor.Table.INDENT_PX_ = 24;
googlefileprocessor.Table.BASE_INDENT_PX_ = 5;

googlefileprocessor.Table.UNCHECKED_COLOR_ = '#888';

googlefileprocessor.Table.IMAGES_PATH_ = 'images/';

googlefileprocessor.Table.Icon_ = {
    CONTAINER: 'folder.png',
    FOLDER: 'folder.png',
    FILE: 'file.png',
    SPINNER: 'spinner.gif'
};


googlefileprocessor.Table.prototype.clear = function () {
    // Keep Offset for table header row.
    // TODO: Verify this is true.
    while (this.tableEl_.rows.length > 1) {
        this.tableEl_.deleteRow(1);
    }

    this.rootEntry_ = null;
};


googlefileprocessor.Table.prototype.lockForSession = function (entryTree) {
    // Disable checkboxes

    // TODO: Consider a 'traverse' method on the model that emits Entries.
    this.getCheckboxForEntry_(entryTree).disabled = true;
    this.disableCheckboxesForChildren_(entryTree);
};


googlefileprocessor.Table.prototype.updateChildEntryIndents_ = function (entry, amount) {
    for (var entryKey in entry.children) {
        var child = entry.children[entryKey];
        this.shiftEntryPadding_(child, amount);
        if (child.directory) {
            this.updateChildEntryIndents_(child, amount);
        }
    }
};


googlefileprocessor.Table.prototype.shiftEntryPadding_ = function (entry, amount) {
    var cell = entry.tableRow.cells[0];
    var currentPaddingValue = parseInt(cell.style.paddingLeft, 10);
    this.setCellPaddingLeft_(cell, currentPaddingValue + amount);
};


googlefileprocessor.Table.prototype.setCellPaddingLeft_ = function (cell, padding) {
    cell.style.paddingLeft = padding + 'px';
};


googlefileprocessor.Table.prototype.disableCheckboxesForChildren_ = function (entry) {
    // TODO: Consider a 'traverse' method on the model that emits Entries.
    for (var entryKey in entry.children) {
        var child = entry.children[entryKey];

        this.getCheckboxForEntry_(child).disabled = true;

        if (child.directory) {
            this.disableCheckboxesForChildren_(child);
        }
    }
};


googlefileprocessor.Table.prototype.isRootEntryFolderCreated = function () {
    return this.getCheckboxForEntry_(this.rootEntry_).checked;
};


googlefileprocessor.Table.prototype.generate = function (entryTree, callback) {
    googlefileprocessor.util.execLater(
        googlefileprocessor.util.bindFn(this.generateInternal_, this, entryTree),
        callback);
};


/**
 * Synchronously renders the table.
 */
googlefileprocessor.Table.prototype.generateInternal_ = function (entryTree) {
    this.clear();
    this.rootEntry_ = entryTree;

    // First child is at same depth as root node
    entryTree.tableRow = this.generateFileTableRow_(entryTree, 0 /* depth */);
    this.generateChildren_(entryTree, 1 /* depth */);
};


googlefileprocessor.Table.prototype.generateChildren_ = function (entry, depth) {
    // Proceed depth-first through the entry tree.
    for (var entryKey in entry.children) {
        var child = entry.children[entryKey];
        child.tableRow = this.generateFileTableRow_(child, depth);

        if (child.directory) {
            this.generateChildren_(child, depth + 1);
        }
    }
};


googlefileprocessor.Table.prototype.generateFileTableRow_ = function (entry, depth) {
    var row = this.tableEl_.insertRow(-1);
    var filenameCell = row.insertCell(0);
    var sizeCell = row.insertCell(1);
    var statusCell = row.insertCell(2);

    filenameCell.className = 'filenameCell';
    sizeCell.className = 'sizeCell';
    statusCell.className = 'statusCell';

    filenameCell.style.paddingLeft = googlefileprocessor.Table.BASE_INDENT_PX_ +
        (googlefileprocessor.Table.INDENT_PX_ * depth) + 'px';

    // Create the checkbox.
    var checkbox = document.createElement('input');
    checkbox.type = "checkbox";
    checkbox.checked = "true";
    filenameCell.appendChild(checkbox);

    var self = this;
    checkbox.onclick = function (e) {
        self.handleCheckboxClick_(entry, e.target.checked);
    };

    var nameSpan = document.createElement('span');
    nameSpan.className = 'tableRowNameSpan';
    nameSpan.innerHTML = entry.name;

    var imgSrc = this.getDefaultIconForEntry_(entry);
    var altText = this.getDefaultAltTextForEntry_(entry);

    var img = document.createElement("img");
    img.className = 'tableRowIcon';
    img.setAttribute('src', imgSrc);
    img.setAttribute('alt', altText);

    filenameCell.appendChild(img);
    filenameCell.appendChild(nameSpan);

    if (!entry.directory && entry.uncompressedSize) {
        sizeCell.innerHTML = googlefileprocessor.util.formatSize(entry.uncompressedSize);
    } else {
        sizeCell.innerHTML = '——';
    }
    return row;
};


googlefileprocessor.Table.prototype.getDefaultIconForEntry_ = function (entry) {
    return googlefileprocessor.Table.IMAGES_PATH_ + (entry.directory ?
        (entry.root ? googlefileprocessor.Table.Icon_.CONTAINER : googlefileprocessor.Table.Icon_.FOLDER) :
        googlefileprocessor.Table.Icon_.FILE);
};


googlefileprocessor.Table.prototype.getDefaultAltTextForEntry_ = function (entry) {
    return entry.directory ?
        (entry.root ? 'Container icon' : 'Folder icon') :
        'File icon';
};


googlefileprocessor.Table.prototype.handleSelectAllCheckboxClick = function (checked) {
    var entryRoot = this.rootEntry_;
    var rootWasCheckedBefore = this.getCheckboxForEntry_(entryRoot).checked;

    this.setEntryChecked_(entryRoot, checked);
    this.setChildEntriesCheckState_(entryRoot, checked);

    // If there is a change in the root checkbox, update the indents.
    if (rootWasCheckedBefore !== checked) {
        this.updateChildEntryIndents_(entryRoot, googlefileprocessor.Table.INDENT_PX_ * (checked ? 1 : -1));
    }
};


googlefileprocessor.Table.prototype.setEntryChecked_ = function (entry, checked) {
    this.getCheckboxForEntry_(entry).checked = checked;
    this.updateEntryRowStyle_(entry, checked);
};


googlefileprocessor.Table.prototype.updateEntryRowStyle_ = function (entry, checked) {
    entry.tableRow.style.color = checked ? 'inherit' : googlefileprocessor.Table.UNCHECKED_COLOR_;
};


googlefileprocessor.Table.prototype.handleCheckboxClick_ = function (entry, checked) {
    this.updateEntryRowStyle_(entry, checked);

    // Checking root has no impact on children, it is independent.
    // Indentation must be updated.
    if (entry.root) {
        this.updateChildEntryIndents_(entry, googlefileprocessor.Table.INDENT_PX_ * (checked ? 1 : -1));
        return;
    }

    // All parents must be checked, if child is checked.
    if (checked) {
        this.setParentEntriesCheckState_(entry, true);
    }

    // Only update children for 'uncheck' events, which is required.
    if (!checked && entry.directory) {
        this.setChildEntriesCheckState_(entry, false);
    }
};


googlefileprocessor.Table.prototype.setChildEntriesCheckState_ = function (entry, checked) {
    // Proceed depth-first through the entry tree.
    for (var entryKey in entry.children) {
        var child = entry.children[entryKey];

        this.setEntryChecked_(child, checked);

        if (child.directory) {
            this.setChildEntriesCheckState_(child, checked);
        }
    }
};


googlefileprocessor.Table.prototype.setParentEntriesCheckState_ = function (entry, checked) {
    var parent = entry.parentEntry;
    if (parent && !parent.root) {
        // Checked children do not enforce root being created
        this.setEntryChecked_(parent, checked);
        this.setParentEntriesCheckState_(parent, checked);
    }
};


googlefileprocessor.Table.prototype.getCheckboxForEntry_ = function (entry) {
    return entry.tableRow.cells[0].firstChild;
};


googlefileprocessor.Table.prototype.isChecked = function (entry) {
    return this.getCheckboxForEntry_(entry).checked;
};


googlefileprocessor.Table.prototype.updateEntryState = function (entry, state, progress) {
    var status = '';
    if (state !== null) {
        status = this.translateEntryState_(state, entry);
    }
    if (progress !== null && progress !== -1) {
        status += ' (' + progress + ')';
    }

    entry.tableRow.cells[2].innerHTML = status;
};


googlefileprocessor.Table.prototype.updateEntryIcon = function (entry, opt_iconUrl, showSpinner) {
    var iconSource = opt_iconUrl ?
        opt_iconUrl :
      (showSpinner ?
          (googlefileprocessor.Table.IMAGES_PATH_ + googlefileprocessor.Table.Icon_.SPINNER) :
          this.getDefaultIconForEntry_(entry));

    var iconAltText = opt_iconUrl ?
       this.getDefaultAltTextForEntry_(entry) :
           (showSpinner ?
               'Processing...' :
               this.getDefaultAltTextForEntry_(entry));

    var imgTag = entry.tableRow.cells[0].children[1];
    imgTag.src = iconSource;
    imgTag.alt = iconAltText;
};


googlefileprocessor.Table.prototype.updateEntryLink = function (entry, link) {
    var nameCell = this.getFilenameCell_(entry);
    nameCell.innerHTML = '<a target="_blank" href="' + link + '">' + nameCell.innerHTML + '</a>';
};


googlefileprocessor.Table.prototype.translateEntryState_ = function (state, entry) {
    switch (state) {
        case googlefileprocessor.state.EntryState.QUEUED:
            return 'Queued';

        case googlefileprocessor.state.EntryState.QUEUED_PENDING_RETRY:
            return 'Queued (Pending resolution of error on parent folder)';

        case googlefileprocessor.state.EntryState.SKIPPED:
            return 'Skipped';

        case googlefileprocessor.state.EntryState.PENDING:
            return 'Pending';

        case googlefileprocessor.state.EntryState.WAITING:
            return 'Waiting';

        case googlefileprocessor.state.EntryState.BEGIN_DECOMPRESSION:
            return 'Decompressing...';

        case googlefileprocessor.state.EntryState.DECOMPRESSION_PROGRESS:
            return 'Decompressing...';

        case googlefileprocessor.state.EntryState.DECOMPRESSION_COMPLETE:
            return 'Decompressed';

        case googlefileprocessor.state.EntryState.BEGIN_UPLOAD:
            return 'Uploading...';

        case googlefileprocessor.state.EntryState.UPLOAD_PROGRESS:
            return 'Uploading...';

        case googlefileprocessor.state.EntryState.UPLOAD_ERROR:
            return 'Upload Error (' + entry.message + ')';

        case googlefileprocessor.state.EntryState.UPLOAD_ALL_BYTES_TRANSFERRED:
            return 'Finishing...';

        case googlefileprocessor.state.EntryState.UPLOAD_COMPLETE:
            return 'Uploaded';

        case googlefileprocessor.state.EntryState.CANCELED:
            return 'Canceled';

        case googlefileprocessor.state.EntryState.UPLOAD_ABORTED:
            return 'Aborted';

        default:
            return '';
    }
};


googlefileprocessor.Table.prototype.getFilenameCell_ = function (entry) {
    return entry.tableRow.cells[0].children[2];
};


/**
 * View for the Google Drive.
 * Depends on:
 *  googlefileprocessor.Model
 *  googlefileprocessor.Presenter
 *  googlefileprocessor.Table
 *  googlefileprocessor.PickerManager
 */

googlefileprocessor.View = function (presenter, pickerManager, uploadManager) {
    this.model_ = null;
    this.presenter_ = presenter;
    this.table_ = null;
    this.pickerManager_ = pickerManager;
    this.uploadManager_ = uploadManager;

    this.isInitialized_ = false;

    this.localFileInputEl = null;

    this.uploadToDriveButtonButton = null;
    this.chooseFileFromDriveButton = null;
    this.openDownloadButton = null;
    this.chooseLocalFileButton = null;
    this.resetButton = null;
    this.rateAppButton = null;
    this.viewFilesButton = null;
    this.retryErrorsButton = null;
    this.retryDownloadButton = null;
    this.shareFilesButton = null;
    this.cancelDownloadButton = null;

    this.downloadChromeButton = null;
    this.downloadFirefoxButton = null;
    this.downloadIeButton = null;

    this.destinationEl = null;

    this.fileTableDiv = null;
    this.fileTableHeaderEl = null;
    this.fileTable = null;

    this.primaryStatus = null;
    this.primaryStatusSpinner = null;
    this.primaryStatusProgress = null;
    this.primaryStatusText = null;
    this.primaryStatusProgressBar = null;

    this.selectAllCheckbox = null;

    this.changeDestinationFolderButton = null;
    this.cancelSessionButton = null;

};


googlefileprocessor.View.APP_NAME_ = 'Google Drive';


/**
 * Called only after DOM has loaded, since attaching to elements.
 */
googlefileprocessor.View.prototype.init = function () {
    if (this.isInitialized_) {
        throw ('Error: View already initialized.');
    }

    this.attachDom_();
    this.attachListeners_();
    this.table_ = new googlefileprocessor.Table(this.fileTable);
    this.isInitialized_ = true;
};


googlefileprocessor.View.prototype.attachDom_ = function () {
    this.authButton = document.getElementById('authorizeButton');

    this.localFileInputEl = document.getElementById('filePicker');

    this.uploadToDriveButtonButton = document.getElementById('uploadToDriveButton');
    this.chooseFileFromDriveButton = document.getElementById('chooseFromDriveButton');
    this.openDownloadButton = document.getElementById('openDownloadButton');
    this.chooseLocalFileButton = document.getElementById('chooseLocalFileButton');
    this.resetButton = document.getElementById('resetButton');
    this.rateAppButton = document.getElementById('rateAppButton');
    this.viewFilesButton = document.getElementById('viewFilesButton');
    this.retryErrorsButton = document.getElementById('retryErrorsButton');
    this.retryDownloadButton = document.getElementById('retryDownloadButton');
    this.shareFilesButton = document.getElementById('shareFilesButton');
    this.cancelDownloadButton = document.getElementById('cancelDownloadButton');

    this.downloadChromeButton = document.getElementById('downloadChromeButton');
    this.downloadFirefoxButton = document.getElementById('downloadFirefoxButton');
    this.downloadIeButton = document.getElementById('downloadIeButton');


    this.destinationEl = document.getElementById('destinationFolderName');

    this.fileTableDiv = document.getElementById('fileTableDiv');

    this.primaryStatus = document.getElementById('primaryStatus');
    this.primaryStatusSpinner = document.getElementById('primaryStatusSpinner');
    this.primaryStatusProgress = document.getElementById('primaryStatusProgress');
    this.primaryStatusText = document.getElementById('primaryStatusText');
    this.primaryStatusProgressBar = document.getElementById('primaryStatusProgressBar');

    this.selectAllCheckbox = document.getElementById('selectAllCheckbox');

    this.changeDestinationFolderButton = document.getElementById('changeDestinationFolderButton');
    this.cancelSessionButton = document.getElementById('cancelSessionButton');


    this.fileTable = document.getElementById('fileTable');
    this.fileTableHeaderEl = document.getElementById('fileTableHeaderCaption');
};


googlefileprocessor.View.prototype.attachListeners_ = function () {
    this.chooseLocalFileButton.onclick = googlefileprocessor.util.bindFn(this.handleChooseLocalFile_, this);
    this.localFileInputEl.onchange = googlefileprocessor.util.bindFn(this.handleLocalFileInputElChange_, this);
    this.uploadToDriveButtonButton.onclick = googlefileprocessor.util.bindFn(this.uploadToDriveButtonButtonClick_, this);
    this.chooseFileFromDriveButton.onclick = googlefileprocessor.util.bindFn(this.chooseFileFromDriveButtonClick_, this);
    this.changeDestinationFolderButton.onclick = googlefileprocessor.util.bindFn(this.changeDestinationFolderButtonClick_, this);
    this.resetButton.onclick = googlefileprocessor.util.bindFn(this.handleResetButtonClick_, this);
    this.authButton.onclick = googlefileprocessor.util.bindFn(this.handleAuthButtonClick_, this);
    this.cancelSessionButton.onclick = googlefileprocessor.util.bindFn(this.handleCancelSessionButtonClick_, this);


    this.retryErrorsButton.onclick = googlefileprocessor.util.bindFn(this.handleRetryErrorsButtonClick_, this);
    this.retryDownloadButton.onclick = googlefileprocessor.util.bindFn(this.handleRetryDownloadButtonClick_, this);
    this.cancelDownloadButton.onclick = googlefileprocessor.util.bindFn(this.handleCancelDownloadButtonClick_, this);
    this.downloadChromeButton.onclick = googlefileprocessor.util.bindFn(this.handleDownloadChromeButtonClick_, this);
    this.downloadFirefoxButton.onclick = googlefileprocessor.util.bindFn(this.handleDownloadFirefoxButtonClick_, this);
    this.downloadIeButton.onclick = googlefileprocessor.util.bindFn(this.handleDownloadIeButtonClick_, this);
    this.selectAllCheckbox.onclick = googlefileprocessor.util.bindFn(this.handleSelectAllCheckboxClick_, this);

};


googlefileprocessor.View.prototype.isSelected = function (entry) {
    return this.table_.isChecked(entry);
};


googlefileprocessor.View.prototype.updateState = function (newState, oldState, opt_data) {
    if (!this.isInitialized_) {
        return;
    }

    switch (newState) {
        case googlefileprocessor.state.SessionState.API_LOADED:
            break;

        case googlefileprocessor.state.SessionState.UNSUPPORTED_BROWSER:
            this.updatePrimaryStatus_(true, false, 'Your browser version is not supported by Google Drive. Please upgrade your browser.');
            this.showEl_(this.downloadChromeButton, true);
            this.showEl_(this.downloadFirefoxButton, true);
            this.showEl_(this.downloadIeButton, true);
            break;

        case googlefileprocessor.state.SessionState.READ_URL_STATE:
            break;

        case googlefileprocessor.state.SessionState.AUTH_PENDING_AUTO:
            this.updatePrimaryStatus_(true, true, 'Checking authorization...');
            break;

        case googlefileprocessor.state.SessionState.AUTH_PENDING_USER:
            this.authButton.disabled = true;
            this.updatePrimaryStatus_(true, true, 'Authorization pending... (Click "Accept" in ' +
            'the popup window to authorize Google Drive to use Google Drive.)');
            break;

        case googlefileprocessor.state.SessionState.AUTH_SUCCESS:
            this.authButton.disabled = true;
            this.showEl_(this.authButton, false);
            break;

        case googlefileprocessor.state.SessionState.AUTH_ERROR:
        case googlefileprocessor.state.SessionState.AUTH_REQUIRED:
            this.updatePrimaryStatus_(
                true, false, 'Please authorize Google Drive to access to Google Drive. ' +
                '(Click "Authorize" below.)');
            this.authButton.disabled = false;
            this.showEl_(this.authButton, true);
            break;

        case googlefileprocessor.state.SessionState.CANCEL_DOWNLOAD_REQUESTED:
            this.enableEl_(this.cancelDownloadButton, false);
            break;

        case googlefileprocessor.state.SessionState.DOWNLOAD_CANCELED:
            this.showEl_(this.cancelDownloadButton, false);
            this.enableEl_(this.cancelDownloadButton, true);
            this.showEl_(this.retryDownloadButton, true);
            this.showEl_(this.resetButton, true);
            this.updatePrimaryStatus_(true, false, 'Download canceled.');
            break;

        case googlefileprocessor.state.SessionState.DOWNLOADING_METADATA:
            this.showEl_(this.chooseFileFromDriveButton, false);
            this.showEl_(this.uploadToDriveButtonButton, false);
            this.showEl_(this.chooseLocalFileButton, false);
            this.showEl_(this.cancelDownloadButton, true);
            this.enableEl_(this.cancelDownloadButton, true);
            this.showEl_(this.retryDownloadButton, false);
            this.showEl_(this.resetButton, false);

            this.updatePrimaryStatus_(true, true, 'Preparing to download file...');
            break;

        case googlefileprocessor.state.SessionState.DOWNLOADING:
            var file = opt_data;
            var statusText = 'Downloading "' + file.title + '" from Google Drive...';
            this.updatePrimaryStatus_(true, true, statusText);
            this.handleDownloadProgress(0, 100);
            break;

        case googlefileprocessor.state.SessionState.DOWNLOAD_ALL_BYTES_TRANSFERRED:
            this.updatePrimaryStatus_(true, false, 'Finishing download...');
            break;

        case googlefileprocessor.state.SessionState.DOWNLOADED:
            this.showEl_(this.cancelDownloadButton, false);
            this.updatePrimaryStatus_(true, false, 'File downloaded.');
            break;

        case googlefileprocessor.state.SessionState.DOWNLOAD_ERROR:
            this.updateUiForDownloadError_(opt_data);
            break;

        case googlefileprocessor.state.SessionState.INIT:
            // Can't update UI at this point in the session.
            break;
        case googlefileprocessor.state.SessionState.MODEL_BUILT:
            this.model_ = opt_data;
            break;

        case googlefileprocessor.state.SessionState.SESSION_CANCELED:
            break;
        case googlefileprocessor.state.SessionState.NEW_SESSION:
            this.setupForNewSession_();
            break;

        default:
            throw ('Unexpected state: ' + newState);
    }
};


googlefileprocessor.View.prototype.updateEntryState = function (entry, newState, oldState) {
    var progress = null;

    switch (newState) {
        case googlefileprocessor.state.EntryState.QUEUED:
            break;

        case googlefileprocessor.state.EntryState.QUEUED_PENDING_RETRY:
            break;

        case googlefileprocessor.state.EntryState.SKIPPED:
            break;

        case googlefileprocessor.state.EntryState.PENDING:
            break;

        case googlefileprocessor.state.EntryState.CANCELED:
            this.updateEntryIconForState_(entry, true);
            break;

        case googlefileprocessor.state.EntryState.BEGIN_UPLOAD:
            this.updateEntryIconForState_(entry, false);
            break;

        case googlefileprocessor.state.EntryState.UPLOAD_PROGRESS:
            progress = Math.round((100 * entry.uploadCurrent) / entry.uploadTotal) + '%';
            break;

        case googlefileprocessor.state.EntryState.UPLOAD_ALL_BYTES_TRANSFERRED:
            break;

        case googlefileprocessor.state.EntryState.UPLOAD_COMPLETE:
            // Special call will come in for the icon.
            break;

        case googlefileprocessor.state.EntryState.UPLOAD_ERROR:
            this.updateEntryIconForState_(entry, true);
            break;

        case googlefileprocessor.state.EntryState.UPLOAD_ABORTED:
            this.updateEntryIconForState_(entry, true);
            break;

        case googlefileprocessor.state.EntryState.BEGIN_DECOMPRESSION:
            this.updateEntryIconForState_(entry, false);
            break;

        case googlefileprocessor.state.EntryState.DECOMPRESSION_PROGRESS:
            progress = Math.round((100 * entry.decompressionCurrent) / entry.decompressionTotal) + '%';
            break;

        case googlefileprocessor.state.EntryState.DECOMPRESSION_COMPLETE:
            break;

        default:
            throw ('Unexpected state: ' + newState);
    }

    this.table_.updateEntryState(entry, newState, progress);
};


googlefileprocessor.View.prototype.updateEntryIconForState_ = function (entry, complete) {
    // TODO: Additional icons for error, abort, etc.
    this.table_.updateEntryIcon(entry, undefined /* iconUrl */, !complete /* showSpinner */);
};


// TODO - make a 'download progress' state (?)
googlefileprocessor.View.prototype.handleDownloadProgress = function (current, total) {
    // Initial download amount is 5%, to show progress bar activity while waiting on first bytes.
    var percent = 5 + (95 * (current / total));
    this.updatePrimaryStatus_(true, false, '', true, true, Math.round(percent));
};


googlefileprocessor.View.prototype.handleSessionProgress = function (current, total) {
    // TODO: Consider consolidating these methods.
    var percent = (100 * (current / total));
    this.updatePrimaryStatus_(true, false, '', true, true, Math.round(percent));
};


googlefileprocessor.View.prototype.updatePageTitle = function (filename) {
    document.title = filename ?
        filename + ' - ' + googlefileprocessor.View.APP_NAME_ :
        googlefileprocessor.View.APP_NAME_;
};


googlefileprocessor.View.prototype.updateUiForFileComplete = function (entry, openUrl, iconUrl) {
    if (openUrl) {
        this.table_.updateEntryLink(entry, openUrl);
    }

    // Clear the spinner icon and show either the icon for the uploaded file,
    // or a default icon.
    if (iconUrl) {
        this.table_.updateEntryIcon(entry, iconUrl);
    } else {
        this.updateEntryIconForState_(entry, true);
    }
};


googlefileprocessor.View.prototype.handleSelectAllCheckboxClick_ = function (e) {
    this.table_.handleSelectAllCheckboxClick(e.target.checked);
};


googlefileprocessor.View.prototype.updatePrimaryStatus_ =
    function (show, showSpinner, text, skipTextUpdate, showProgress, progressPercent) {

        if (!skipTextUpdate) {
            this.primaryStatusText.innerHTML = text || '';
        }

        this.showEl_(this.primaryStatusProgress, show);
        this.showEl_(this.primaryStatusSpinner, showSpinner);

        if (showProgress) {
            this.primaryStatusProgressBar.style.width = "" + progressPercent + "%";
        }

        this.showEl_(this.primaryStatusProgress, !!showProgress);
    };

googlefileprocessor.View.prototype.setupForNewSession_ = function () {

    this.showEl_(this.cancelSessionButton, false);
    this.showEl_(this.changeDestinationFolderButton, false);
    this.showEl_(this.viewFilesButton, false);
    this.showEl_(this.retryErrorsButton, false);
    this.showEl_(this.retryDownloadButton, false);
    this.showEl_(this.shareFilesButton, false);
    this.showEl_(this.resetButton, false);
    this.showEl_(this.rateAppButton, false);
    this.showEl_(this.cancelDownloadButton, false);
    this.showEl_(this.fileTableDiv, false);

    this.showEl_(this.chooseFileFromDriveButton, true);
    this.showEl_(this.uploadToDriveButtonButton, true);
    //this.showEl_(this.chooseLocalFileButton, true);
    this.enableEl_(this.chooseFileFromDriveButton, true);
    this.enableEl_(this.uploadToDriveButtonButton, true);
    this.enableEl_(this.chooseLocalFileButton, true);

    this.table_.clear();
    this.enableEl_(this.selectAllCheckbox, true);

    this.updatePrimaryStatus_(true, false, '');
};

googlefileprocessor.View.prototype.updateUiForDownloadError_ = function (error) {
    this.showEl_(this.cancelDownloadButton, false);
    this.showEl_(this.retryDownloadButton, true);
    this.showEl_(this.resetButton, true);

    this.updatePrimaryStatus_(true, false, 'Unable to download file. (' + error + ')');
};



googlefileprocessor.View.prototype.handleChooseLocalFile_ = function (e) {
    this.localFileInputEl.click();
};


googlefileprocessor.View.prototype.chooseFileFromDriveButtonClick_ = function (e) {
    this.pickerManager_.show(
        googlefileprocessor.util.PickerManager.PickerMode.FILE,
        googlefileprocessor.util.bindFn(this.handlePickerFileSelected_, this));
};

googlefileprocessor.View.prototype.uploadToDriveButtonButtonClick_ = function (e) {
    this.uploadManager_.show(
        googlefileprocessor.util.UploadManager.UploadMode.FILE,
        googlefileprocessor.util.bindFn(this.handleUploaderFileSelected_, this));
};


googlefileprocessor.View.prototype.changeDestinationFolderButtonClick_ = function (e) {
    this.pickerManager_.show(
        googlefileprocessor.util.PickerManager.PickerMode.FOLDER,
        googlefileprocessor.util.bindFn(this.handlePickerFolderSelected_, this));
};


googlefileprocessor.View.prototype.handlePickerFileSelected_ = function (file) {
    this.presenter_.VIEW__driveFileChosen(file);
};


googlefileprocessor.View.prototype.handleUploaderFileSelected_ = function (file) {
    this.presenter_.VIEW__driveFileChosen(file);
};


googlefileprocessor.View.prototype.handlePickerFolderSelected_ = function (folder) {
    this.presenter_.VIEW__driveFolderChosen(folder);
};


googlefileprocessor.View.prototype.handleLocalFileInputElChange_ = function (e) {
    var file = e.target.files[0];
    if (file) {
        this.presenter_.VIEW__localBlobChosen(file.name, file);
    }
};

googlefileprocessor.View.prototype.handleAuthButtonClick_ = function (e) {
    this.presenter_.VIEW__authRequested();
};


googlefileprocessor.View.prototype.handleCancelSessionButtonClick_ = function () {
    this.presenter_.VIEW__cancelSession();
};


googlefileprocessor.View.prototype.handleResetButtonClick_ = function () {
    this.presenter_.VIEW__reset();
};


googlefileprocessor.View.prototype.handleRateAppButtonClick_ = function () {
    this.presenter_.VIEW__rateApp();
};


googlefileprocessor.View.prototype.showEl_ = function (el, show) {
    el.style.display = show ? '' : 'none';
};


googlefileprocessor.View.prototype.enableEl_ = function (el, enable) {
    el.disabled = !enable;
};



googlefileprocessor.View.prototype.handleRetryErrorsButtonClick_ = function (e) {
    this.presenter_.VIEW__retryErrors();
};


googlefileprocessor.View.prototype.handleRetryDownloadButtonClick_ = function (e) {
    this.presenter_.VIEW__retryDownload();
};


googlefileprocessor.View.prototype.handleCancelDownloadButtonClick_ = function (e) {
    this.presenter_.VIEW__cancelDownload();
};


googlefileprocessor.View.prototype.handleDownloadChromeButtonClick_ = function (e) {
    this.presenter_.VIEW__downloadBrowser('chrome');
};


googlefileprocessor.View.prototype.handleDownloadFirefoxButtonClick_ = function (e) {
    this.presenter_.VIEW__downloadBrowser('firefox');
};


googlefileprocessor.View.prototype.handleDownloadIeButtonClick_ = function (e) {
    this.presenter_.VIEW__downloadBrowser('ie');
};
