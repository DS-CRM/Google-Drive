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


/**
 * Drive API Upload widget wrapper for Google Drive.
 * Depends on:
 *   driveapi.appconfig
 *   gapi
 *   google.picker
 */


// TODO: Minor friction here, picker manager relies on driveapi items.
zipextractor.util.UploadManager = function (appConfig, authManager) {
    this.appConfig_ = appConfig;
    this.authManager_ = authManager;
};


zipextractor.util.UploadManager.UploadMode = {
    FILE: 'file'
};


zipextractor.util.UploadManager.prototype.show = function (pickerMode, callback) {
    var cb = zipextractor.util.bindFn(this.showInternal_, this, pickerMode, callback);
    var pickerParams = {
        'callback': cb
    };

    gapi.load('picker', pickerParams);
};


zipextractor.util.UploadManager.prototype.showInternal_ = function (pickerMode, callback) {
    if (pickerMode == zipextractor.util.UploadManager.UploadMode.FILE) {
        this.showFileUpload_(zipextractor.util.bindFn(this.itemChosenInternalCallback_, this, callback));
    } else {
        throw ('Unexpected Upload Mode: ' + pickerMode);
    }
};


zipextractor.util.UploadManager.prototype.itemChosenInternalCallback_ = function (callback, data) {
    if (data.action == google.picker.Action.PICKED) {
        var file = data.docs[0];
        callback(file);
    }
};


zipextractor.util.UploadManager.prototype.showFileUpload_ = function (callback) {
    var view = new google.picker.DocsUploadView()
        .setIncludeFolders(true);

    var pickerBuilder = this.generateUploadBuilder_(view, callback);
    pickerBuilder.setTitle('Upload a file');
    var picker = pickerBuilder.build();
    picker.setVisible(true);
};

zipextractor.util.UploadManager.prototype.generateUploadBuilder_ = function (view, callback) {
    return new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .setAppId(this.appConfig_.getAppId())
      .setOAuthToken(this.authManager_.getAccessToken())
      .setDeveloperKey(this.appConfig_.getApiKey())
      .setCallback(callback)
      .addView(view);
};
