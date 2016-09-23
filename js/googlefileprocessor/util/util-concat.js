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


googlefileprocessor.util = {};

googlefileprocessor.util.IS_NATIVE_BIND_ =
    Function.prototype.bind &&
    Function.prototype.bind.toString().indexOf('native code') != -1;

googlefileprocessor.util.bindFn = function (fn, selfObj, var_args) {
    
    if (googlefileprocessor.util.IS_NATIVE_BIND_) {
        return fn.call.apply(fn.bind, arguments);
    } else {
        if (arguments.length > 2) {
            var boundArgs = Array.prototype.slice.call(arguments, 2);
            return function () {
                var newArgs = Array.prototype.slice.call(arguments);
                Array.prototype.unshift.apply(newArgs, boundArgs);
                return fn.apply(selfObj, newArgs);
            };
        } else {
            return function () {
                return fn.apply(selfObj, arguments);
            };
        }
    }
};



/**
 * Async work queue.
 */

googlefileprocessor.util.AsyncWorkQueue = function (maxWorkers) {
    this.workQueue_ = [];
    this.numCurrentWorkers_ = 0;
    this.maxWorkers_ = maxWorkers;

    this.runCompleteCallback_ = null;

    this.isRunning_ = false;
};


googlefileprocessor.util.AsyncWorkQueue.prototype.enqueue = function (workItem) {
    this.workQueue_.push(workItem);
};


googlefileprocessor.util.AsyncWorkQueue.prototype.run = function (callback) {
    this.runCompleteCallback_ = callback;

    this.isRunning_ = true;
    this.processQueue_();
};


googlefileprocessor.util.AsyncWorkQueue.prototype.processQueue_ = function () {
    while (this.numCurrentWorkers_ < this.maxWorkers_ && !this.isEmpty()) {
        this.executeNextWorkItem_();
    }
};


googlefileprocessor.util.AsyncWorkQueue.prototype.stop = function () {
    this.workQueue_.length = 0;
    this.isRunning_ = false;
};


googlefileprocessor.util.AsyncWorkQueue.prototype.isEmpty = function () {
    return this.workQueue_.length === 0;
};


googlefileprocessor.util.AsyncWorkQueue.prototype.isActive = function () {
    return this.isRunning_ || !this.isDone();
};


googlefileprocessor.util.AsyncWorkQueue.prototype.isDone = function () {
    return this.numCurrentWorkers_ === 0 && this.isEmpty();
};


googlefileprocessor.util.AsyncWorkQueue.prototype.executeNextWorkItem_ = function () {
    var workItem = this.workQueue_.shift();

    if (this.numCurrentWorkers_ > this.maxWorkers_) {
        throw ('Error: too many workers');
    }

    // Execute the work item, which is to merely invoke a callback that is bound with parameters.
    this.numCurrentWorkers_++;
    workItem(googlefileprocessor.util.bindFn(this.workItemComplete_, this));
};


googlefileprocessor.util.AsyncWorkQueue.prototype.workItemComplete_ = function () {
    if (!this.isRunning_) {
        return;
    }

    this.numCurrentWorkers_--;

    if (this.numCurrentWorkers_ < 0) {
        throw ('Error: too few workers.');
    }

    var isDone = this.isDone();

    if (isDone) {
        this.isRunning_ = false;
        if (this.runCompleteCallback_) {
            this.runCompleteCallback_();
        }
    } else {
        this.processQueue_();
    }
};



/**
 * Drive API Picker widget wrapper for Google Drive.
 * Depends on:
 *   driveapi.appconfig
 *   gapi
 *   google.picker
 */


// TODO: Minor friction here, picker manager relies on driveapi items.
googlefileprocessor.util.PickerManager = function (appConfig, authManager) {
    this.appConfig_ = appConfig;
    this.authManager_ = authManager;
};


googlefileprocessor.util.PickerManager.PickerMode = {
    FILE: 'file',
    FOLDER: 'folder'
};


googlefileprocessor.util.PickerManager.prototype.show = function (pickerMode, callback) {
    var cb = googlefileprocessor.util.bindFn(this.showInternal_, this, pickerMode, callback);
    var pickerParams = {
        'callback': cb
    };

    gapi.load('picker', pickerParams);
};


googlefileprocessor.util.PickerManager.prototype.showInternal_ = function (pickerMode, callback) {
    if (pickerMode == googlefileprocessor.util.PickerManager.PickerMode.FILE) {
        this.showFilePicker_(googlefileprocessor.util.bindFn(this.itemChosenInternalCallback_, this, callback));
    } else if (pickerMode == googlefileprocessor.util.PickerManager.PickerMode.FOLDER) {
        this.showFolderPicker_(googlefileprocessor.util.bindFn(this.itemChosenInternalCallback_, this, callback));
    } else {
        throw ('Unexpected Picker Mode: ' + pickerMode);
    }
};


googlefileprocessor.util.PickerManager.prototype.itemChosenInternalCallback_ = function (callback, data) {  
    if (data.action == google.picker.Action.PICKED) {
        var file = data.docs[0];
        callback(file);
    }
};


googlefileprocessor.util.PickerManager.prototype.showFilePicker_ = function (callback) {
    var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setSelectFolderEnabled(false)
        .setIncludeFolders(false)
        .setMode(google.picker.DocsViewMode.LIST);

    var pickerBuilder = this.generatePickerBuilder_(view, callback);
    pickerBuilder.setTitle('Select a file');
    var picker = pickerBuilder.build();
    picker.setVisible(true);
};


googlefileprocessor.util.PickerManager.prototype.showFolderPicker_ = function (callback) {
    var view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true)
      .setMode(google.picker.DocsViewMode.LIST)
      .setMimeTypes('application/vnd.google-apps.folder');

    var pickerBuilder = this.generatePickerBuilder_(view, callback);
    pickerBuilder.setTitle('Select a folder');
    var picker = pickerBuilder.build();
    picker.setVisible(true);
};


googlefileprocessor.util.PickerManager.prototype.generatePickerBuilder_ = function (view, callback) {
    return new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setAppId(this.appConfig_.getAppId())
      .setOAuthToken(this.authManager_.getAccessToken())
      .setDeveloperKey(this.appConfig_.getApiKey())
      .setCallback(callback)
      .addView(view);
};


/**
 * Drive API Upload widget wrapper for Google Drive.
 * Depends on:
 *   driveapi.appconfig
 *   gapi
 *   google.picker
 */


// TODO: Minor friction here, picker manager relies on driveapi items.
googlefileprocessor.util.UploadManager = function (appConfig, authManager) {
    this.appConfig_ = appConfig;
    this.authManager_ = authManager;
};


googlefileprocessor.util.UploadManager.UploadMode = {
    FILE: 'file'
};


googlefileprocessor.util.UploadManager.prototype.show = function (pickerMode, callback) {
    var cb = googlefileprocessor.util.bindFn(this.showInternal_, this, pickerMode, callback);
    var pickerParams = {
        'callback': cb
    };

    gapi.load('picker', pickerParams);
};


googlefileprocessor.util.UploadManager.prototype.showInternal_ = function (pickerMode, callback) {
    if (pickerMode == googlefileprocessor.util.UploadManager.UploadMode.FILE) {
        this.showFileUpload_(googlefileprocessor.util.bindFn(this.itemChosenInternalCallback_, this, callback));
    } else {
        throw ('Unexpected Upload Mode: ' + pickerMode);
    }
};


googlefileprocessor.util.UploadManager.prototype.itemChosenInternalCallback_ = function (callback, data) {
    if (data.action == google.picker.Action.PICKED) {
        var file = data.docs[0];
        callback(file);
    }
};


googlefileprocessor.util.UploadManager.prototype.showFileUpload_ = function (callback) {
    var view = new google.picker.DocsUploadView().setIncludeFolders(true);

    var pickerBuilder = this.generateUploadBuilder_(view, callback);
    pickerBuilder.setTitle('Upload a file');
    var picker = pickerBuilder.build();
    picker.setVisible(true);
};

googlefileprocessor.util.UploadManager.prototype.generateUploadBuilder_ = function (view, callback) {
    return new google.picker.PickerBuilder()
       .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
       .setAppId(this.appConfig_.getAppId())
       .setOAuthToken(this.authManager_.getAccessToken())
       .setDeveloperKey(this.appConfig_.getApiKey())
       .setCallback(callback)
     .addView(view);
};



/**
 * Utility methods for Google Drive.
 */

googlefileprocessor.util.formatSize = function (size) {
    var i = 0;
    do {
        size /= 1024;
        i++;
    } while (size > 1024);

    var value;
    if (i === 1) {
        value = Math.ceil(Math.max(size, googlefileprocessor.util.MIN_VALUE_));
    } else {
        // MB or greater, use one-digit precision and round
        var tmp = Math.max(size, googlefileprocessor.util.MIN_VALUE_);
        value = Math.round(tmp * Math.pow(10, 1)) / Math.pow(10, 1);
    }

    return value + ' ' + googlefileprocessor.util.BYTE_UNITS_[i - 1];
};

googlefileprocessor.util.BYTE_UNITS_ = ['KB', 'MB', 'GB', 'TB'];
googlefileprocessor.util.MIN_VALUE_ = 0.1;

googlefileprocessor.util.DRIVE_URL_ = 'https://drive.google.com/';
googlefileprocessor.util.FOLDER_SUFFIX_ = '#folders/';

googlefileprocessor.util.FILE_EXTENSION_REGEX_ = '/\\.[^/.]+$/';


googlefileprocessor.util.endsWith = function (str, suffix) {
    return str.indexOf(suffix, str.length - suffix.length) !== -1;
};


googlefileprocessor.util.trimFileExtension = function (filename) {
    return filename.replace(googlefileprocessor.util.FILE_EXTENSION_REGEX_, '');
};


googlefileprocessor.util.createDriveFolderLink = function (folderId) {
    return googlefileprocessor.util.DRIVE_URL_ + (folderId ? googlefileprocessor.util.FOLDER_SUFFIX_ + folderId : '');
};


googlefileprocessor.util.isEmptyObject = function (obj) {
    var name;
    for (name in obj) {
        return false;
    }
    return true;
};


googlefileprocessor.util.getFileExtension = function (filename) {
    var a = filename.split('.');
    if (a.length === 1 || (a[0] === '' && a.length === 2)) {
        return '';
    }
    return a.pop().toLowerCase();
};


googlefileprocessor.util.execLater = function (fn, opt_callback) {
    window.setTimeout(function () {
        fn();
        if (opt_callback) {
            opt_callback();
        }
    }, 0);
};

googlefileprocessor.util.isIE = function () {
    try {
        var myNav = navigator.userAgent.toLowerCase();
        return (myNav.indexOf('msie') != -1) ? parseInt(myNav.split('msie')[1], 10) : false;
    } catch (err) {
        return false;
    }
};

