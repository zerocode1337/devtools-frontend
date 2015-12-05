/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * @constructor
 * @extends {WebInspector.ContentProviderBasedProject}
 * @param {!WebInspector.Target} target
 * @param {!WebInspector.Workspace} workspace
 * @param {string} projectId
 * @param {string} projectURL
 * @param {!WebInspector.projectTypes} projectType
 */
WebInspector.NetworkProjectDelegate = function(target, workspace, projectId, projectURL, projectType)
{
    this._target = target;
    WebInspector.ContentProviderBasedProject.call(this, workspace, projectId, projectType, projectURL, this._computeDisplayName(projectURL));
}

WebInspector.NetworkProjectDelegate.prototype = {
    /**
     * @return {!WebInspector.Target}
     */
    target: function()
    {
        return this._target;
    },

    /**
     * @param {string} url
     * @return {string}
     */
    _computeDisplayName: function(url)
    {
        for (var context of this._target.runtimeModel.executionContexts()) {
            if (context.origin && url.startsWith(context.origin))
                return context.name;
        }

        var targetSuffix = this._target.isPage() ? "" : " \u2014 " + this._target.name();
        if (!url)
            return WebInspector.UIString("(no domain)") + targetSuffix;
        var parsedURL = new WebInspector.ParsedURL(url);
        var prettyURL = parsedURL.isValid ? parsedURL.host + (parsedURL.port ? (":" + parsedURL.port) : "") : "";
        return (prettyURL || url) + targetSuffix;
    },

    /**
     * @param {string} parentPath
     * @param {string} name
     * @param {string} url
     * @param {!WebInspector.ContentProvider} contentProvider
     * @return {!WebInspector.UISourceCode}
     */
    addFile: function(parentPath, name, url, contentProvider)
    {
        return this.addContentProvider(parentPath, name, url, contentProvider);
    },

    __proto__: WebInspector.ContentProviderBasedProject.prototype
}

/**
 * @constructor
 * @param {!WebInspector.TargetManager} targetManager
 * @param {!WebInspector.Workspace} workspace
 * @param {!WebInspector.NetworkMapping} networkMapping
 * @implements {WebInspector.TargetManager.Observer}
 */
WebInspector.NetworkProjectManager = function(targetManager, workspace, networkMapping)
{
    this._workspace = workspace;
    this._networkMapping = networkMapping;
    targetManager.observeTargets(this);
}

WebInspector.NetworkProjectManager.prototype = {
    /**
     * @override
     * @param {!WebInspector.Target} target
     */
    targetAdded: function(target)
    {
        new WebInspector.NetworkProject(target, this._workspace, this._networkMapping);
    },

    /**
     * @override
     * @param {!WebInspector.Target} target
     */
    targetRemoved: function(target)
    {
        WebInspector.NetworkProject.forTarget(target)._dispose();
    }
}

/**
 * @constructor
 * @extends {WebInspector.SDKObject}
 * @param {!WebInspector.Target} target
 * @param {!WebInspector.Workspace} workspace
 * @param {!WebInspector.NetworkMapping} networkMapping
 */
WebInspector.NetworkProject = function(target, workspace, networkMapping)
{
    WebInspector.SDKObject.call(this, target);
    this._workspace = workspace;
    this._networkMapping = networkMapping;
    this._projectDelegates = {};
    target[WebInspector.NetworkProject._networkProjectSymbol] = this;

    target.resourceTreeModel.addEventListener(WebInspector.ResourceTreeModel.EventTypes.ResourceAdded, this._resourceAdded, this);
    target.resourceTreeModel.addEventListener(WebInspector.ResourceTreeModel.EventTypes.MainFrameNavigated, this._mainFrameNavigated, this);

    var debuggerModel = WebInspector.DebuggerModel.fromTarget(target);
    if (debuggerModel) {
        debuggerModel.addEventListener(WebInspector.DebuggerModel.Events.ParsedScriptSource, this._parsedScriptSource, this);
        debuggerModel.addEventListener(WebInspector.DebuggerModel.Events.FailedToParseScriptSource, this._parsedScriptSource, this);
    }
    var cssModel = WebInspector.CSSStyleModel.fromTarget(target);
    if (cssModel) {
        cssModel.addEventListener(WebInspector.CSSStyleModel.Events.StyleSheetAdded, this._styleSheetAdded, this);
        cssModel.addEventListener(WebInspector.CSSStyleModel.Events.StyleSheetRemoved, this._styleSheetRemoved, this);
    }
    target.targetManager().addEventListener(WebInspector.TargetManager.Events.SuspendStateChanged, this._suspendStateChanged, this);
}

WebInspector.NetworkProject._networkProjectSymbol = Symbol("networkProject");
WebInspector.NetworkProject._contentTypeSymbol = Symbol("networkContentType");

/**
 * @param {!WebInspector.Target} target
 * @param {string} projectURL
 * @param {boolean} isContentScripts
 * @return {string}
 */
WebInspector.NetworkProject.projectId = function(target, projectURL, isContentScripts)
{
    return target.id() + ":" + (isContentScripts ? "contentscripts:" : "") + projectURL;
}

/**
 * @param {!WebInspector.Target} target
 * @return {!WebInspector.NetworkProject}
 */
WebInspector.NetworkProject.forTarget = function(target)
{
    return target[WebInspector.NetworkProject._networkProjectSymbol];
}

/**
 * @param {!WebInspector.UISourceCode} uiSourceCode
 * @return {?WebInspector.Target} target
 */
WebInspector.NetworkProject.targetForUISourceCode = function(uiSourceCode)
{
    if (uiSourceCode.project().type() !== WebInspector.projectTypes.ContentScripts && uiSourceCode.project().type() !==  WebInspector.projectTypes.Network)
        return null;

    return /** @type {!WebInspector.NetworkProjectDelegate} */(uiSourceCode.project())._target;
}

/**
 * @param {!WebInspector.UISourceCode} uiSourceCode
 * @return {(!WebInspector.ResourceType|undefined)}
 */
WebInspector.NetworkProject.uiSourceCodeContentType = function(uiSourceCode)
{
    return uiSourceCode[WebInspector.NetworkProject._contentTypeSymbol];
}

WebInspector.NetworkProject.prototype = {
    /**
     * @param {string} projectURL
     * @param {boolean} isContentScripts
     * @return {!WebInspector.NetworkProjectDelegate}
     */
    _projectDelegate: function(projectURL, isContentScripts)
    {
        var projectId = WebInspector.NetworkProject.projectId(this.target(), projectURL, isContentScripts);
        var projectType = isContentScripts ? WebInspector.projectTypes.ContentScripts : WebInspector.projectTypes.Network;

        if (this._projectDelegates[projectId])
            return this._projectDelegates[projectId];
        var projectDelegate = new WebInspector.NetworkProjectDelegate(this.target(), this._workspace, projectId, projectURL, projectType);
        this._projectDelegates[projectId] = projectDelegate;
        return projectDelegate;
    },

    /**
     * @param {string} url
     * @param {!WebInspector.ContentProvider} contentProvider
     * @param {boolean=} isContentScript
     * @return {!WebInspector.UISourceCode}
     */
    addFileForURL: function(url, contentProvider, isContentScript)
    {
        var splitURL = WebInspector.ParsedURL.splitURLIntoPathComponents(url);
        var projectURL = splitURL[0];
        var parentPath = splitURL.slice(1, -1).join("/");
        var name = splitURL.peekLast() || "";
        var projectDelegate = this._projectDelegate(projectURL, isContentScript || false);
        var uiSourceCode = projectDelegate.addFile(parentPath, name, url, contentProvider);
        return uiSourceCode;
    },

    /**
     * @param {string} url
     */
    _removeFileForURL: function(url)
    {
        var splitURL = WebInspector.ParsedURL.splitURLIntoPathComponents(url);
        var projectURL = splitURL[0];
        var path = splitURL.slice(1).join("/");
        var projectDelegate = this._projectDelegates[WebInspector.NetworkProject.projectId(this.target(), projectURL, false)];
        if (!projectDelegate)
            return;
        projectDelegate.removeFile(path);
    },

    _populate: function()
    {
        /**
         * @param {!WebInspector.ResourceTreeFrame} frame
         * @this {WebInspector.NetworkProject}
         */
        function populateFrame(frame)
        {
            for (var i = 0; i < frame.childFrames.length; ++i)
                populateFrame.call(this, frame.childFrames[i]);

            var resources = frame.resources();
            for (var i = 0; i < resources.length; ++i)
                this._addResource(resources[i]);
        }

        var mainFrame = this.target().resourceTreeModel.mainFrame;
        if (mainFrame)
            populateFrame.call(this, mainFrame);
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _parsedScriptSource: function(event)
    {
        var script = /** @type {!WebInspector.Script} */ (event.data);
        if (!script.sourceURL || script.isLiveEdit() || (script.isInlineScript() && !script.hasSourceURL))
            return;
        // Filter out embedder injected content scripts.
        if (script.isContentScript() && !script.hasSourceURL) {
            var parsedURL = new WebInspector.ParsedURL(script.sourceURL);
            if (!parsedURL.isValid)
                return;
        }
        this._addFile(script.sourceURL, script, script.isContentScript());
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _styleSheetAdded: function(event)
    {
        var header = /** @type {!WebInspector.CSSStyleSheetHeader} */ (event.data);
        if (header.isInline && !header.hasSourceURL && header.origin !== "inspector")
            return;

        this._addFile(header.resourceURL(), header, false);
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _styleSheetRemoved: function(event)
    {
        var header = /** @type {!WebInspector.CSSStyleSheetHeader} */ (event.data);
        if (header.isInline && !header.hasSourceURL && header.origin !== "inspector")
            return;

        this._removeFileForURL(header.resourceURL());
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _resourceAdded: function(event)
    {
        var resource = /** @type {!WebInspector.Resource} */ (event.data);
        this._addResource(resource);
    },

    /**
     * @param {!WebInspector.Resource} resource
     */
    _addResource: function(resource)
    {
        // Only load documents from resources.
        if (resource.resourceType() !== WebInspector.resourceTypes.Document)
            return;

        // Never load document twice.
        if (this._workspace.uiSourceCodeForOriginURL(resource.url))
            return;
        this._addFile(resource.url, resource);
    },

    /**
     * @param {!WebInspector.Event} event
     */
    _mainFrameNavigated: function(event)
    {
        this._reset();
        this._populate();
    },

    _suspendStateChanged: function()
    {
        if (this.target().targetManager().allTargetsSuspended())
            this._reset();
        else
            this._populate();
    },

    /**
     * @param {string} url
     * @param {!WebInspector.ContentProvider} contentProvider
     * @param {boolean=} isContentScript
     */
    _addFile: function(url, contentProvider, isContentScript)
    {
        if (this._networkMapping.hasMappingForURL(url))
            return;

        var type = contentProvider.contentType();
        if (!type.isDocumentOrScriptOrStyleSheet())
            return;
        var uiSourceCode = this.addFileForURL(url, contentProvider, isContentScript);
        uiSourceCode[WebInspector.NetworkProject._contentTypeSymbol] = type;
    },

    _dispose: function()
    {
        this._reset();
        var target = this.target();
        target.resourceTreeModel.removeEventListener(WebInspector.ResourceTreeModel.EventTypes.ResourceAdded, this._resourceAdded, this);
        target.resourceTreeModel.removeEventListener(WebInspector.ResourceTreeModel.EventTypes.MainFrameNavigated, this._mainFrameNavigated, this);
        var debuggerModel = WebInspector.DebuggerModel.fromTarget(target);
        if (debuggerModel) {
            debuggerModel.removeEventListener(WebInspector.DebuggerModel.Events.ParsedScriptSource, this._parsedScriptSource, this);
            debuggerModel.removeEventListener(WebInspector.DebuggerModel.Events.FailedToParseScriptSource, this._parsedScriptSource, this);
        }
        var cssModel = WebInspector.CSSStyleModel.fromTarget(target);
        if (cssModel) {
            cssModel.removeEventListener(WebInspector.CSSStyleModel.Events.StyleSheetAdded, this._styleSheetAdded, this);
            cssModel.removeEventListener(WebInspector.CSSStyleModel.Events.StyleSheetRemoved, this._styleSheetRemoved, this);
        }
        delete target[WebInspector.NetworkProject._networkProjectSymbol];
    },

    _reset: function()
    {
        for (var projectId in this._projectDelegates)
            this._projectDelegates[projectId].reset();
        this._projectDelegates = {};
    },

    __proto__: WebInspector.SDKObject.prototype
}
